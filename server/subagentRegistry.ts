/**
 * Subagent Registry — Реестр и движок in-process суб-агентов
 * 
 * Суб-агенты — это фоновые AI-задачи, которые основной агент может
 * делегировать для параллельного выполнения. В отличие от cron-задач,
 * суб-агенты:
 * - Выполняются однократно (one-shot)
 * - Имеют контекст родительского сообщения
 * - Могут использовать специализированный системный промпт
 * - Доставляют результат через WebSocket в реальном времени
 * 
 * Архитектура: In-Process Async (не RPC, как в OpenClaw)
 * Это проще и достаточно для single-instance deployment.
 */

import { db } from "./db";
import { subagentRuns, type SubagentRun } from "@shared/schema";
import { eq, desc, inArray, and, lt } from "drizzle-orm";
import { getAIClientForTask, callWithFallback, type AICallResult } from "./aiConfigService";
import type { AITaskType } from "@shared/schema";
import { storage } from "./storage";
import { WebSocket } from "ws";
import { executeReActLoop, resolveToolsForRequest } from "./tools";
import { getExpertiseBySlug } from "./expertiseRegistry";

// ============================================================================
// WebSocket — ссылка на клиентов (устанавливается из routes.ts)
// ============================================================================

let wsClients: Set<WebSocket> = new Set();

export function setWebSocketClients(clients: Set<WebSocket>) {
    wsClients = clients;
}

// ============================================================================
// In-memory tracking для активных суб-агентов
// ============================================================================

interface ActiveSubagent {
    id: number;
    taskType: string;
    startedAt: Date;
    parentMessageId: number;
    abortController: AbortController;
}

const activeSubagents = new Map<number, ActiveSubagent>();

// ============================================================================
// Cross-Agent Spawning — allowlist и маппинг промптов (через Expertise Registry)
// ============================================================================

const ALLOWED_AGENT_SLUGS = new Set(['business', 'finance', 'psychology', 'general', 'browser']);

/**
 * Получение системного промпта агента через Expertise Registry с кешированием.
 */
const _cachedPrompts: Record<string, string> = {};

async function getAgentSystemPrompt(slug: string): Promise<string> {
    if (_cachedPrompts[slug]) return _cachedPrompts[slug];

    const expertise = await getExpertiseBySlug(slug);
    if (expertise) {
        _cachedPrompts[slug] = expertise.promptTemplate;
        return expertise.promptTemplate;
    }

    // Fallback: для агентов без записи в expertises (например browser)
    // промпт берётся из SubagentSpec
    const spec = SUBAGENT_SPECS.find(s => s.type === `${slug}_task`);
    if (spec) {
        _cachedPrompts[slug] = spec.systemPrompt;
        return spec.systemPrompt;
    }

    throw new Error(`Экспертиза "${slug}" не найдена в реестре`);
}

const AGENT_TASK_KEYS: Record<string, AITaskType> = {
    business: 'agent_core',
    finance: 'agent_core',
    psychology: 'agent_core',
    browser: 'browser_agent',
};

const AGENT_DISPLAY_NAMES: Record<string, string> = {
    business: 'Бизнес-консультант',
    finance: 'Финансовый консультант',
    psychology: 'Психолог-коуч',
    browser: 'Веб-агент',
};

// ============================================================================
// Типы суб-агентов (predefined specializations)
// ============================================================================

export interface SubagentSpec {
    /** Уникальный идентификатор типа суб-агента */
    type: string;
    /** Человекочитаемое название */
    name: string;
    /** Описание для LLM — когда делегировать */
    description: string;
    /** Системный промпт для суб-агента */
    systemPrompt: string;
    /** Иконка */
    icon: string;
    /** Максимальное время выполнения в ms */
    timeoutMs: number;
    /** Максимальное количество итераций ReAct Loop (по умолчанию 8) */
    maxIterations?: number;
    /** Модель по умолчанию для этого типа (например "openai/gpt-4o-mini"). Если не задана — используется конфиг subagent_execution */
    defaultModel?: string;
}

const SUBAGENT_SPECS: SubagentSpec[] = [
    {
        type: 'deep_analysis',
        name: 'Глубокий анализ',
        description: 'Углублённый анализ данных, метрик, конкурентов. Используй когда нужен детальный разбор, который займёт время.',
        systemPrompt: `Ты — аналитический суб-агент. Твоя задача — провести глубокий, структурированный анализ.

Правила:
- Структурируй ответ с заголовками и подпунктами
- Используй числа и метрики где возможно
- Дай чёткие выводы и рекомендации
- Формат: Markdown`,
        icon: '🔬',
        timeoutMs: 120_000,
        defaultModel: undefined,
    },
    {
        type: 'research',
        name: 'Исследование',
        description: 'Сбор и систематизация информации по теме. Используй когда нужно изучить вопрос со всех сторон.',
        systemPrompt: `Ты — исследовательский суб-агент. Твоя задача — провести всестороннее исследование темы.

Правила:
- Рассмотри тему с разных сторон
- Укажи плюсы и минусы, if applicable
- Приведи примеры и аналогии
- Дай структурированный обзор
- Формат: Markdown`,
        icon: '🔍',
        timeoutMs: 120_000,
        defaultModel: undefined,
    },
    {
        type: 'content_creation',
        name: 'Создание контента',
        description: 'Написание текстов, постов, описаний, статей. Используй для создания любого текстового контента.',
        systemPrompt: `Ты — контент-суб-агент. Твоя задача — создать качественный текстовый контент.

Правила:
- Пиши живым, естественным языком
- Адаптируй стиль под целевую аудиторию
- Используй структуру и форматирование
- Предложи варианты если уместно
- Формат: Markdown`,
        icon: '✍️',
        timeoutMs: 90_000,
        defaultModel: undefined,
    },
    {
        type: 'planning',
        name: 'Планирование',
        description: 'Составление планов, стратегий, roadmap. Используй когда нужен детальный план действий.',
        systemPrompt: `Ты — суб-агент планирования. Твоя задача — создать детальный, actionable план.

Правила:
- Разбей на этапы с чёткими шагами
- Укажи временные рамки если возможно
- Определи приоритеты и зависимости
- Учитывай риски и альтернативы
- Формат: Markdown с чек-листами`,
        icon: '📋',
        timeoutMs: 90_000,
        defaultModel: undefined,
    },
    {
        type: 'browser_task',
        name: 'Веб-агент',
        description: 'Работа с браузером: скрапинг, навигация, заполнение форм, регистрация. Используй когда нужно открывать сайты, заполнять формы, извлекать данные со страниц или выполнять multi-step workflow в браузере.',
        systemPrompt: `Ты — веб-агент, специализирующийся на работе с браузером. Ты умеешь открывать веб-страницы, кликать по элементам, заполнять формы, скроллить, читать контент и выполнять сложные multi-step сценарии.

Твои инструменты:
- browser_open(url) — открыть страницу, получить sessionId и список интерактивных элементов
- browser_act(session_id, actions) — выполнить действия (click, type, scroll, press, hover, select, evaluate JS, navigate)
- browser_read(session_id, mode) — прочитать содержимое (text, dom, elements, screenshot)
- perplexity_search(query) — поиск в интернете для получения URL или информации
- web_search(query) — быстрый веб-поиск
- read_web_page(url) — прочитать содержимое веб-страницы без браузера (быстрее, если не нужна интерактивность)

Правила:
1. Начинай с browser_open(url) для получения sessionId
2. Используй селекторы из ответа browser_open/browser_read для browser_act
3. После действий проверяй результат через browser_read
4. При ошибках — пробуй evaluate (JS) для удаления оверлеев, или координатный клик
5. Для навигации внутри сессии используй navigate (не browser_open!) — сохраняет cookies
6. Если нужен только текст — используй read_web_page (дешевле и быстрее)
7. Если не знаешь URL — сначала найди его через perplexity_search или web_search
8. Дай структурированный отчёт о проделанной работе

⛔ КРИТИЧЕСКИЕ ПРАВИЛА (НАРУШЕНИЕ = ПРОВАЛ ЗАДАЧИ):

1. ОБЯЗАТЕЛЬНЫЕ ПАРАМЕТРЫ:
   - click ВСЕГДА требует selector ИЛИ координаты (x, y). НИКОГДА не отправляй {"type":"click"} без них!
   - type ВСЕГДА требует selector И value. НИКОГДА не отправляй {"type":"type"} без selector!
   - navigate ВСЕГДА требует url. НИКОГДА не отправляй {"type":"navigate"} без url!
   Если ты не знаешь selector — сначала вызови browser_read(mode:"dom") чтобы получить актуальные селекторы.

2. РАБОТА С ФОРМАМИ И ЧЕКБОКСАМИ:
   - ПЕРЕД заполнением формы ВСЕГДА вызывай browser_read(mode:"dom") для получения актуальных селекторов.
   - НЕ используй обобщённые селекторы (input[type="checkbox"], input[type="submit"]). ВСЕГДА используй УНИКАЛЬНЫЕ селекторы (#id, [name="..."]).
   - ДЛЯ ЧЕКБОКСОВ: Сначала пробуй ID-селектор. При ошибке (часто чекбоксы бывают стилизованы и скрыты) — ИСПОЛЬЗУЙ КООРДИНАТНЫЙ КЛИК (x, y) из vision-диагностики.
   - ОЧИСТКА ПОЛЕЙ: Инструмент type автоматически очищает поле, но если текст дописывается криво, используй evaluate \`document.querySelector('...').value = ''\`.
   - КИРИЛЛИЦА: На WordPress-сайтах логины обычно требуют латиницу. Если у тебя кириллический логин и он не проходит (ошибка валидации имени) — ПЕРЕКЛЮЧАЙСЯ НА ТРАНСЛИТЕРАЦИЮ.

3. ЗАПРЕТ ПОВТОРОВ И ЭСКАЛАЦИЯ ОШИБОК:
   - Если действие вернуло ошибку — НЕ повторяй его с теми же параметрами!
   - Шаг 1 (1-я ошибка): Вызови browser_read(mode:"dom") для обновления DOM, потом пробуй с новыми селекторами.
   - Шаг 2 (2-я ошибка): Вызови browser_read(mode:"screenshot") для визуальной диагностики.
   - Шаг 3 (3-я ошибка): Используй evaluate(JS) для программного клика/сабмита или координат.
   - Шаг 4 (4+ ошибок): ПРЕКРАТИ выполнять это действие, сообщи пользователю об ошибке.

4. ЗАПРЕТ ДУБЛИРОВАНИЯ browser_open:
   - browser_open создаёт НОВУЮ сессию, теряя cookies и авторизацию! ОН НУЖЕН ТОЛЬКО ОДИН РАЗ В НАЧАЛЕ ЗАДАЧИ.
   - Для навигации ВСЕГДА используй browser_act → {"type":"navigate","url":"..."}.

📦 BATCHING — экономь итерации:
- Комбинируй НЕСКОЛЬКО действий в ОДНОМ вызове browser_act:
  ПЛОХО (3 итерации): browser_act([type login]) → browser_act([type password]) → browser_act([click submit])
  ХОРОШО (1 итерация): browser_act([{type login}, {type password}, {click checkbox}, {click submit}])
- Максимум 10 действий на вызов.

🔄 FALLBACK — выбирай правильный инструмент:
- Для ЧТЕНИЯ страницы (без кликов/форм) → используй read_web_page(url)
- Для ИНТЕРАКТИВА (клики, формы, навигация) → используй browser_open + browser_act
- Для ПОИСКА URL → сначала perplexity_search или web_search, потом browser

📸 Стратегия скриншотов:
- После browser_open — browser_read(mode: "dom") для получения селекторов
- После заполнения формы ИЛИ любой ошибки — ОБЯЗАТЕЛЬНО browser_read(mode: "screenshot") для проверки и диагностики
- НЕ делай скриншот после КАЖДОГО browser_act — только ключевые этапы и ошибки.

Формат ответа: Markdown`,
        icon: '🌐',
        timeoutMs: 300_000, // 5 минут для multi-step browser задач
        maxIterations: 30, // Больше итераций — browser задачи multi-step (регистрация, формы и т.д.)
        defaultModel: undefined, // Используется из AITaskType 'browser_agent'
    },
    {
        type: 'custom',
        name: 'Пользовательский',
        description: 'Произвольная задача с пользовательским промптом. Используй когда ни один из специализированных типов не подходит.',
        systemPrompt: `Ты — универсальный суб-агент. Выполни задачу максимально качественно и подробно.
Формат: Markdown`,
        icon: '🤖',
        timeoutMs: 90_000,
        defaultModel: undefined,
    },
];

/**
 * Получить спецификацию суб-агента по типу
 */
export function getSubagentSpec(type: string): SubagentSpec | undefined {
    return SUBAGENT_SPECS.find(s => s.type === type);
}

/**
 * Получить все доступные типы суб-агентов
 */
export function getAvailableSubagentTypes(): SubagentSpec[] {
    return SUBAGENT_SPECS;
}

// ============================================================================
// CRUD операции
// ============================================================================

/**
 * Создать запись о запуске суб-агента
 */
export async function createRun(data: {
    parentMessageId: number;
    taskType: string;
    taskPrompt: string;
    systemPrompt?: string;
    metadata?: Record<string, any>;
}): Promise<SubagentRun> {
    const spec = getSubagentSpec(data.taskType);

    const [run] = await db.insert(subagentRuns).values({
        parentMessageId: data.parentMessageId,
        taskType: data.taskType,
        taskPrompt: data.taskPrompt,
        systemPrompt: data.systemPrompt || spec?.systemPrompt || SUBAGENT_SPECS.find(s => s.type === 'custom')!.systemPrompt,
        status: 'pending',
        metadata: data.metadata || null,
    }).returning();

    console.log(`🤖 [Subagent] Создан run #${run.id}: тип="${data.taskType}", prompt="${data.taskPrompt.substring(0, 80)}..."`);
    return run;
}

/**
 * Получить запуск по ID
 */
export async function getRun(id: number): Promise<SubagentRun | null> {
    const [run] = await db.select()
        .from(subagentRuns)
        .where(eq(subagentRuns.id, id))
        .limit(1);
    return run || null;
}

/**
 * Получить последние запуски
 */
export async function getRecentRuns(limit: number = 20): Promise<SubagentRun[]> {
    return db.select()
        .from(subagentRuns)
        .orderBy(desc(subagentRuns.createdAt))
        .limit(limit);
}

/**
 * Получить запуски для родительского сообщения
 */
export async function getRunsByParentMessage(parentMessageId: number): Promise<SubagentRun[]> {
    return db.select()
        .from(subagentRuns)
        .where(eq(subagentRuns.parentMessageId, parentMessageId))
        .orderBy(desc(subagentRuns.createdAt));
}

// ============================================================================
// Execution Engine
// ============================================================================

/**
 * Запустить суб-агент асинхронно.
 * Возвращает run ID сразу (fire-and-forget), результат доставляется через WebSocket.
 */
export async function spawnSubagent(data: {
    parentMessageId: number;
    taskType: string;
    taskPrompt: string;
    systemPrompt?: string;
    context?: string;
    entityIds?: number[];
    structuredContext?: Record<string, any>;
    metadata?: Record<string, any>;
    modelOverride?: string;
    agentSlug?: string;
    broadcastStep?: (step: any) => void;
}): Promise<{ runId: number; taskType: string; estimated: string }> {
    // Allowlist check для agentSlug
    if (data.agentSlug && !ALLOWED_AGENT_SLUGS.has(data.agentSlug)) {
        throw new Error(`Агент "${data.agentSlug}" не разрешён для использования в суб-агентах`);
    }

    // Создаём запись
    const run = await createRun({
        parentMessageId: data.parentMessageId,
        taskType: data.taskType,
        taskPrompt: data.taskPrompt,
        systemPrompt: data.systemPrompt,
        metadata: {
            ...data.metadata,
            ...(data.agentSlug ? { agentSlug: data.agentSlug } : {}),
        },
    });

    const spec = getSubagentSpec(data.taskType) || SUBAGENT_SPECS.find(s => s.type === 'custom')!;
    const abortController = new AbortController();

    // Регистрируем в active
    activeSubagents.set(run.id, {
        id: run.id,
        taskType: data.taskType,
        startedAt: new Date(),
        parentMessageId: data.parentMessageId,
        abortController,
    });

    // Fire-and-forget: запускаем выполнение в фоне
    executeSubagent(run, spec, data.context, abortController.signal, data.modelOverride, data.agentSlug, data.entityIds, data.structuredContext, data.broadcastStep)
        .catch(error => {
            console.error(`🤖 [Subagent] Необработанная ошибка run #${run.id}:`, error);
        })
        .finally(() => {
            activeSubagents.delete(run.id);
        });

    return {
        runId: run.id,
        taskType: data.taskType,
        estimated: `~${Math.round(spec.timeoutMs / 1000)}с макс.`,
    };
}

async function summarizeTextContext(context: string | undefined, modelOverride?: string): Promise<string> {
    if (!context || context.length <= 500) return context || "";

    try {
        console.log(`🤖 [Subagent] Входной текстовый контекст длинный (${context.length} симв.), запускаем быструю суммаризацию...`);
        const aiConfig = await getAIClientForTask('subagent_execution');

        const systemPrompt = "Ты - супероптимизатор контекста. Твоя задача сжать переданный текст, сохранив 100% смысловой нагрузки, фактов, чисел и важных деталей. Убери воду, пустые размышления и длинные форматирования. Твоя цель - минимизировать размер текста в токенах, но сохранить всю полезную информацию. Выдай только сжатый текст без вводных фраз.";

        const configToUse = modelOverride ? { ...aiConfig, model: modelOverride } : aiConfig;
        const result = await callWithFallback(configToUse, [
            { role: "system", content: systemPrompt },
            { role: "user", content: context }
        ]);

        const summary = result.content?.trim() || context;
        console.log(`🤖 [Subagent] Суммаризация завершена: ${context.length} -> ${summary.length} симв.`);
        return summary;
    } catch (e) {
        console.warn(`🤖 [Subagent] Ошибка суммаризации контекста, используем оригинал:`, e);
        return context || "";
    }
}

/**
 * Внутренняя функция выполнения суб-агента
 *
 * TODO: Если суб-агент получит доступ к tools (ReAct Loop),
 * передавать ctx.isSubagent = true в execution engine
 */
async function executeSubagent(
    run: SubagentRun,
    spec: SubagentSpec,
    additionalContext?: string,
    signal?: AbortSignal,
    modelOverride?: string,
    agentSlug?: string,
    entityIds?: number[],
    structuredContext?: Record<string, any>,
    broadcastStep?: (step: any) => void,
): Promise<void> {
    const startTime = Date.now();

    // Обновляем статус → running
    await db.update(subagentRuns)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(subagentRuns.id, run.id));

    // Отправляем начало через WebSocket
    broadcastSubagentEvent(run.id, 'started', {
        taskType: run.taskType,
        taskPrompt: run.taskPrompt,
        icon: spec.icon,
        name: spec.name,
        ...(agentSlug ? { agentSlug, agentName: AGENT_DISPLAY_NAMES[agentSlug] } : {}),
    });

    try {
        // Проверка отмены
        if (signal?.aborted) {
            throw new Error('Суб-агент отменён');
        }

        // --- Context Optimization Pipeline ---
        let optimizedTextContext = await summarizeTextContext(additionalContext, modelOverride);

        const combinedContextBlocks: string[] = [];
        if (entityIds && entityIds.length > 0) {
            combinedContextBlocks.push(`ВАЖНО: Твоя первая задача — выгрузить данные по этим ID из памяти/целей (${entityIds.join(', ')}). Используй свои tools перед тем, как давать финальный ответ.`);
        }
        if (structuredContext && Object.keys(structuredContext).length > 0) {
            combinedContextBlocks.push(`Структурированный контекст для задачи:\n\`\`\`json\n${JSON.stringify(structuredContext, null, 2)}\n\`\`\``);
        }
        if (optimizedTextContext.length > 0) {
            combinedContextBlocks.push(`Текстовый контекст:\n${optimizedTextContext}`);
        }

        const finalContextString = combinedContextBlocks.join('\n\n');
        // ------------------------------------

        let responseContent: string;
        let tokensUsed: number | undefined;
        let resolvedModelName: string;

        if (agentSlug) {
            // === Путь через специализированного агента с tools ===
            console.log(`🤖 [Subagent] Run #${run.id}: используется агент "${agentSlug}" (${AGENT_DISPLAY_NAMES[agentSlug]})`);

            const agentResult = await executeWithAgent(agentSlug, run, spec, finalContextString, signal, modelOverride, broadcastStep);
            responseContent = agentResult.content;
            tokensUsed = agentResult.tokensUsed;
            resolvedModelName = agentResult.modelUsed;
        } else {
            // === Стандартный путь — прямой AI-вызов без tools ===
            const resolvedModel = modelOverride || spec.defaultModel;
            let aiConfig = await getAIClientForTask('subagent_execution');

            if (resolvedModel) {
                aiConfig = { ...aiConfig, model: resolvedModel };
                console.log(`🤖 [Subagent] Run #${run.id}: модель переопределена → ${resolvedModel}`);
            }

            const systemPrompt = `${run.systemPrompt || spec.systemPrompt}

Контекст задачи:
- Тип: ${spec.name} (${spec.type})
- Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
${finalContextString ? `\nДополнительный контекст (сжатый):\n${finalContextString}` : ''}

Выполни задачу тщательно и подробно. Это фоновая задача — пользователь ожидает развёрнутый результат.`;

            let timeoutHandle: ReturnType<typeof setTimeout>;
            const aiPromise = callWithFallback(aiConfig, [
                { role: "system", content: systemPrompt },
                { role: "user", content: run.taskPrompt },
            ]);

            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(`Таймаут: ${spec.timeoutMs / 1000}с`)), spec.timeoutMs);
            });

            let result: AICallResult;
            try {
                result = await Promise.race([aiPromise, timeoutPromise]);
            } finally {
                clearTimeout(timeoutHandle!);
            }

            responseContent = result.content?.trim() || "Не удалось получить ответ";
            tokensUsed = result.tokensUsed;
            resolvedModelName = resolvedModel || aiConfig.model || 'unknown';
        }

        const duration = Date.now() - startTime;

        // Обновляем запись: success
        await db.update(subagentRuns)
            .set({
                status: 'completed',
                result: responseContent,
                durationMs: duration,
                tokensUsed: tokensUsed || null,
                completedAt: new Date(),
                metadata: {
                    ...(run.metadata as any || {}),
                    modelUsed: resolvedModelName,
                    ...(agentSlug ? { agentSlug } : {}),
                },
            })
            .where(eq(subagentRuns.id, run.id));

        // Доставляем результат через WebSocket
        broadcastSubagentEvent(run.id, 'completed', {
            taskType: run.taskType,
            name: spec.name,
            icon: spec.icon,
            result: responseContent,
            durationMs: duration,
            tokensUsed: tokensUsed || 0,
            ...(agentSlug ? { agentSlug, agentName: AGENT_DISPLAY_NAMES[agentSlug] } : {}),
        });

        // Также сохраняем как AI-сообщение (чтобы было в истории чата)
        const agentLabel = agentSlug
            ? `${spec.icon} **${AGENT_DISPLAY_NAMES[agentSlug]}** (фоновая задача — ${spec.name})`
            : `${spec.icon} **${spec.name}** (фоновая задача)`;

        const aiMessage = await storage.createMessage({
            content: `${agentLabel}\n\n${responseContent}`,
            type: 'text',
            sender: 'ai',
            status: 'delivered',
        });

        // Broadcast AI message
        broadcastNewMessage(aiMessage);

        console.log(`🤖 [Subagent] Run #${run.id} завершён за ${duration}ms (${tokensUsed || '?'} tokens${agentSlug ? `, agent=${agentSlug}` : ''})`);

    } catch (error: any) {
        const duration = Date.now() - startTime;
        const errorMessage = error?.message || String(error);

        // Обновляем запись: failed
        await db.update(subagentRuns)
            .set({
                status: signal?.aborted ? 'cancelled' : 'failed',
                error: errorMessage,
                durationMs: duration,
                completedAt: new Date(),
            })
            .where(eq(subagentRuns.id, run.id));

        // Уведомляем об ошибке
        broadcastSubagentEvent(run.id, 'failed', {
            taskType: run.taskType,
            name: spec.name,
            icon: spec.icon,
            error: errorMessage,
            durationMs: duration,
        });

        // Отправляем AI-сообщение в чат о сбое/таймауте
        const errorLabel = agentSlug
            ? `${spec.icon} **${AGENT_DISPLAY_NAMES[agentSlug] || agentSlug}** (фоновая задача — ${spec.name})`
            : `${spec.icon} **${spec.name}** (фоновая задача)`;

        const isTimeout = errorMessage.includes('Таймаут') || errorMessage.includes('timeout');
        const errorSummary = isTimeout
            ? `Задача не завершена: превышен лимит времени (${Math.round(spec.timeoutMs / 1000)}с). Попробуй упростить задачу или разбить на шаги.`
            : `Задача завершилась с ошибкой: ${errorMessage}`;

        try {
            const errorAiMessage = await storage.createMessage({
                content: `${errorLabel}\n\n❌ ${errorSummary}\n\n📋 Промпт задачи: ${run.taskPrompt.substring(0, 200)}...`,
                type: 'text',
                sender: 'ai',
                status: 'delivered',
            });
            broadcastNewMessage(errorAiMessage);
        } catch (msgErr) {
            console.error(`🤖 [Subagent] Не удалось отправить сообщение об ошибке для run #${run.id}:`, msgErr);
        }

        console.error(`🤖 [Subagent] Run #${run.id} ошибка (${duration}ms):`, errorMessage);
    }
}

// ============================================================================
// Cross-Agent Execution — запуск через ReAct Loop специализированного агента
// ============================================================================

/**
 * Выполнить задачу через специализированного агента с полным доступом к tools.
 * Использует executeReActLoop напрямую (без generateResponse),
 * чтобы избежать ненужного buildContext/memory lookup.
 */
async function executeWithAgent(
    agentSlug: string,
    run: SubagentRun,
    spec: SubagentSpec,
    additionalContext?: string,
    signal?: AbortSignal,
    modelOverride?: string,
    broadcastStep?: (step: any) => void,
): Promise<{ content: string; tokensUsed: number; modelUsed: string }> {
    // 1. Получаем системный промпт агента
    const agentSystemPrompt = await getAgentSystemPrompt(agentSlug);
    if (!agentSystemPrompt) {
        throw new Error(`Агент "${agentSlug}" не найден`);
    }

    // 2. Получаем AI-конфиг агента
    const taskKey = AGENT_TASK_KEYS[agentSlug] || 'subagent_execution';
    const resolvedModel = modelOverride || spec.defaultModel;
    let aiConfig = await getAIClientForTask(taskKey);

    if (resolvedModel) {
        aiConfig = { ...aiConfig, model: resolvedModel };
    }

    // 3. Получаем tools агента (без delegate_task — Nesting Guard)
    const tools = resolveToolsForRequest({
        agentSlug,
        exclude: ['delegate_task'],
    });

    console.log(`🤖 [Subagent] Run #${run.id}: агент "${agentSlug}" загружен, ${tools.length} tools доступно`);

    // 4. Формируем системный промпт
    const systemPrompt = `${agentSystemPrompt}

## Режим суб-агента (фоновая задача)
Ты работаешь как фоновый суб-агент. Ты выполняешь задачу автономно.
- Дай развёрнутый, структурированный ответ
- Используй tools если они помогут выполнить задачу
- Тип задачи: ${spec.name} (${spec.type})
- Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
${additionalContext ? `\nДополнительный контекст:\n${additionalContext}` : ''}`;

    // 5. Формируем messages
    const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: run.taskPrompt },
    ];

    // 6. Проверка отмены перед вызовом
    if (signal?.aborted) {
        throw new Error('Суб-агент отменён');
    }

    // 7. Выполняем ReAct Loop с таймаутом
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const reactPromise = executeReActLoop({
        messages,
        tools,
        aiConfig,
        context: {
            sessionId: `subagent-${run.id}`,
            messageId: run.parentMessageId,
            isSubagent: true,
        },
        agentSlug,
        broadcastStep,
        messageId: run.parentMessageId,
        maxIterations: spec.maxIterations,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
            () => reject(new Error(`Таймаут агента ${agentSlug}: ${spec.timeoutMs / 1000}с`)),
            spec.timeoutMs,
        );
    });

    let reactResult;
    try {
        reactResult = await Promise.race([reactPromise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutHandle!);
    }

    if (reactResult.toolCalls.length > 0) {
        console.log(`🤖 [Subagent] Run #${run.id}: агент "${agentSlug}" вызвал ${reactResult.toolCalls.length} tool(s): ${reactResult.toolCalls.map(tc => tc.toolName).join(', ')}`);
    }

    return {
        content: reactResult.content || 'Не удалось получить ответ',
        tokensUsed: reactResult.tokensUsed,
        modelUsed: resolvedModel || aiConfig.model || 'unknown',
    };
}

/**
 * Отменить активный суб-агент
 */
export function cancelSubagent(runId: number): boolean {
    const active = activeSubagents.get(runId);
    if (!active) return false;

    active.abortController.abort();
    activeSubagents.delete(runId);
    console.log(`🤖 [Subagent] Run #${runId} отменён`);
    return true;
}

/**
 * Получить список активных суб-агентов
 */
export function getActiveSubagents(): Array<{
    id: number;
    taskType: string;
    runningFor: number;
    parentMessageId: number;
}> {
    return Array.from(activeSubagents.values()).map(sa => ({
        id: sa.id,
        taskType: sa.taskType,
        runningFor: Date.now() - sa.startedAt.getTime(),
        parentMessageId: sa.parentMessageId,
    }));
}

// ============================================================================
// Disk Persistence — восстановление зависших run-ов после перезапуска
// ============================================================================

/**
 * Восстановить зависшие run-ы при старте сервера.
 * Находит все записи со статусом running/pending и помечает их как failed.
 * Безопасна для вызова — не бросает исключений.
 */
export async function restoreSubagentRunsOnStart(): Promise<void> {
    try {
        // Находим все зависшие run-ы
        const staleRuns = await db.select()
            .from(subagentRuns)
            .where(inArray(subagentRuns.status, ['running', 'pending']));

        if (staleRuns.length === 0) {
            return;
        }

        const now = new Date();

        // Обновляем каждый run
        for (const run of staleRuns) {
            const durationMs = run.startedAt
                ? now.getTime() - new Date(run.startedAt).getTime()
                : run.createdAt
                    ? now.getTime() - new Date(run.createdAt).getTime()
                    : 0;

            await db.update(subagentRuns)
                .set({
                    status: 'failed',
                    error: 'Сервер был перезапущен — задача прервана',
                    completedAt: now,
                    durationMs,
                })
                .where(eq(subagentRuns.id, run.id));

            // WebSocket broadcast (клиенты могут уже быть подключены)
            broadcastSubagentEvent(run.id, 'failed', {
                taskType: run.taskType,
                error: 'Сервер был перезапущен — задача прервана',
                durationMs,
            });
        }

        console.log(`🤖 [Subagent] Восстановлено ${staleRuns.length} зависших run-ов после перезапуска`);
    } catch (error) {
        console.error('🤖 [Subagent] Ошибка при восстановлении зависших run-ов:', error);
    }
}

// ============================================================================
// Archive Sweeper — автоматическая очистка старых записей
// ============================================================================

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 часов
const SWEEP_MAX_AGE_DAYS = 7;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Удалить старые завершённые записи из subagent_runs.
 * Удаляет только completed / failed / cancelled старше 7 дней.
 * Записи running / pending не трогает — они обрабатываются restoreSubagentRunsOnStart.
 */
export async function sweepOldSubagentRuns(): Promise<number> {
    try {
        const cutoff = new Date(Date.now() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

        const deleted = await db.delete(subagentRuns)
            .where(
                and(
                    inArray(subagentRuns.status, ['completed', 'failed', 'cancelled']),
                    lt(subagentRuns.completedAt, cutoff),
                ),
            )
            .returning({ id: subagentRuns.id });

        if (deleted.length > 0) {
            console.log(`🧹 [Sweeper] Удалено ${deleted.length} старых subagent_runs (> ${SWEEP_MAX_AGE_DAYS} дней)`);
        }

        return deleted.length;
    } catch (error) {
        console.error('🧹 [Sweeper] Ошибка при очистке старых subagent_runs:', error);
        return 0;
    }
}

/**
 * Запустить периодическую очистку старых subagent_runs (каждые 6 часов).
 */
export function startSubagentSweeper(): void {
    if (sweepTimer) return; // уже запущен

    sweepTimer = setInterval(() => {
        sweepOldSubagentRuns();
    }, SWEEP_INTERVAL_MS);

    // .unref() — таймер не блокирует завершение процесса
    sweepTimer.unref();

    console.log(`🧹 [Sweeper] Запущен: очистка каждые ${SWEEP_INTERVAL_MS / 1000 / 60 / 60}ч, порог ${SWEEP_MAX_AGE_DAYS} дней`);
}

/**
 * Остановить периодическую очистку.
 */
export function stopSubagentSweeper(): void {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
        console.log('🧹 [Sweeper] Остановлен');
    }
}

// ============================================================================
// WebSocket доставка
// ============================================================================

function broadcastSubagentEvent(
    runId: number,
    event: 'started' | 'completed' | 'failed',
    data: Record<string, any>,
): void {
    if (wsClients.size === 0) return;

    const payload = JSON.stringify({
        type: 'subagent_event',
        data: {
            runId,
            event,
            ...data,
            timestamp: new Date().toISOString(),
        },
    });

    for (const client of Array.from(wsClients)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

function broadcastNewMessage(message: any): void {
    if (wsClients.size === 0) return;

    const payload = JSON.stringify({
        type: 'new_message',
        message,
    });

    for (const client of Array.from(wsClients)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
