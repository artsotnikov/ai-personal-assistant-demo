/**
 * Execution Engine — ReAct Loop для tool calling
 * 
 * Цикл: LLM → tool_calls? → execute → inject results → LLM → ... → text
 * 
 * Использует расширенный callWithFallback с поддержкой tools.
 * Отправляет processing_step события через broadcastStep для визуализации в UI.
 */

import type {
    ToolDefinition,
    ToolExecutionContext,
    ToolResult,
    ToolCallLog,
    ReActResult,
    ToolCall,
    HookResult,
    ParsedToolCall,
} from './types';
import type { ChatMessage, AICallResult } from '../aiConfigService';
import { db } from '../db';
import { logToolCall } from '../lib/logger';
import type { OpenAI } from 'openai';
import type { AIProvider, ProcessingStep } from '@shared/schema';
import { callWithFallback } from '../aiConfigService';
import { formatToolsForOpenAI, parseToolCallsFromResponse, parseXmlToolCalls } from './llmAdapter';
import { toolRegistry } from './toolRegistry';
import { createToolCallStepDef } from '@shared/schema';
import { assembleResponsePrompt, type AssembleResponsePromptOptions } from '../promptAssembler';
import { formatMessagesForPrompt } from '../contextBuilder';

// ============================================================================
// Константы
// ============================================================================

const DEFAULT_MAX_ITERATIONS = 15;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// Адаптивный лимит итераций по сложности задачи
const ITERATIONS_BY_COMPLEXITY: Record<string, number> = {
    low: 10,      // простые — Fast Path (нужен запас для retry/guards + реальные tool calls)
    medium: 15,   // средние — поиск + ответ (DeepSeek — дёшево, можно больше)
    high: 25,     // сложные — мультизадача, генерация документов, NDA
};

/** Определяет максимум итераций на основе complexity и количества tools */
function getAdaptiveMaxIterations(complexity?: string, toolCount?: number): number {
    const base = ITERATIONS_BY_COMPLEXITY[complexity || 'medium'] ?? DEFAULT_MAX_ITERATIONS;
    // Если доступно много tools — добавляем буфер (агент может вызвать несколько)
    if (toolCount && toolCount > 10) return Math.min(base + 5, 35);
    return base;
}

// Промпт для оптимизации использования итераций
const EFFICIENCY_INSTRUCTION = `
ИСПОЛЬЗОВАНИЕ ИНСТРУМЕНТОВ:
1. Перед вызовом инструмента проверь секцию "🔍 ДАННЫЕ, НАЙДЕННЫЕ РЕФЛЕКТОРОМ" — возможно, нужные данные уже собраны.
2. Ты МОЖЕШЬ И ДОЛЖЕН вызывать инструменты когда тебе нужна информация — даже если рефлектор уже что-то искал. Поиск с ДРУГИМИ параметрами, уточнениями или в других источниках — это нормально и ожидаемо.
3. ОБЪЕДИНЯЙ НЕЗАВИСИМЫЕ вызовы в ОДНУ группу (параллельное выполнение).
`;

// ============================================================================
// 🔁 Tool Loop Detector
// ============================================================================

/** Запись о вызове tool в скользящем окне */
interface ToolCallRecord {
    name: string;
    /** Детерминированный стабильный хеш аргументов (рекурсивная сортировка ключей) */
    argsHash: string;
}

/** Результат проверки на зацикливание */
interface LoopCheckResult {
    /** true = вызов заблокирован, false = можно выполнять */
    blocked: boolean;
    /** Уровень: 'warning' — предупреждение, 'critical' — блокировка */
    level?: 'warning' | 'critical';
    /** Сообщение для инъекции в контекст модели */
    reason?: string;
}

/**
 * Рекурсивная детерминированная сериализация (аналог stableStringify из OpenClaw).
 * Сортирует ключи объектов на всех уровнях вложенности, что гарантирует
 * одинаковый хеш для семантически идентичных аргументов независимо от порядка ключей.
 */
function stableStringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    // Пропускаем undefined-значения (как JSON.stringify)
    const pairs = keys
        .filter(k => obj[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${pairs.join(',')}}`;
}

/**
 * ToolLoopDetector — детектор зацикливания tool calls в ReAct Loop.
 *
 * Логика (адаптировано из OpenClaw tool-loop-detection.ts):
 * - Ведёт скользящее окно последних `windowSize` вызовов.
 * - CRITICAL (blocked): один и тот же `name + argsHash` повторяется ≥ `repeatThreshold` раз подряд.
 * - WARNING (не блокирует, только инъекция): один и тот же `name` (любые args) встречается
 *   ≥ `sameNameThreshold` раз в окне.
 *
 * argsHash = stableStringify(args) — рекурсивно сортирует ключи на всех уровнях.
 */
export class ToolLoopDetector {
    private readonly window: ToolCallRecord[] = [];
    private readonly warnedNames = new Set<string>(); // однократные warning на tool
    readonly windowSize: number;
    readonly repeatThreshold: number;   // одинаковый name+args подряд → critical
    readonly sameNameThreshold: number;  // одинаковый name в окне → warning
    /** Счётчик заблокированных вызовов (для мониторинга) */
    blockedCount = 0;

    constructor(opts: { windowSize?: number; repeatThreshold?: number; sameNameThreshold?: number } = {}) {
        this.windowSize = opts.windowSize ?? 10;
        this.repeatThreshold = opts.repeatThreshold ?? 3;
        this.sameNameThreshold = opts.sameNameThreshold ?? 5;
    }

    /** Вычисляет детерминированный хеш аргументов с рекурсивной сортировкой ключей */
    static argsHash(args: unknown): string {
        try {
            return stableStringify(args);
        } catch {
            // Fallback при циклических ссылках или нестандартных типах
            return String(args);
        }
    }

    /**
     * Проверяет, является ли вызов частью зацикливания.
     * Вызывать ПЕРЕД выполнением tool call.
     */
    check(toolName: string, toolArgs: unknown): LoopCheckResult {
        const hash = ToolLoopDetector.argsHash(toolArgs);
        const signature = `${toolName}:${hash}`;

        // 1. CRITICAL: одинаковый name+args N раз подряд
        let consecutiveSame = 0;
        for (let i = this.window.length - 1; i >= 0; i--) {
            const entry = this.window[i];
            if (!entry) break;
            if (`${entry.name}:${entry.argsHash}` === signature) {
                consecutiveSame++;
            } else {
                break;
            }
        }

        if (consecutiveSame >= this.repeatThreshold) {
            this.blockedCount++;
            return {
                blocked: true,
                level: 'critical',
                reason: `Ты вызвал «${toolName}» с теми же параметрами ${consecutiveSame + 1} раз подряд. ` +
                    `Результат не изменится — инструмент заблокирован. ` +
                    `Попробуй другой подход или дай финальный ответ пользователю.`,
            };
        }

        // 2. WARNING: одинаковый name много раз в окне (разные args)
        // Генерируется однократно на tool — чтобы не спамить контекст
        const sameNameCount = this.window.filter(e => e.name === toolName).length;
        if (sameNameCount >= this.sameNameThreshold && !this.warnedNames.has(toolName)) {
            this.warnedNames.add(toolName);
            return {
                blocked: false,
                level: 'warning',
                reason: `⚠️ TOOL LOOP DETECTOR: «${toolName}» вызван уже ${sameNameCount} раз в этой сессии. ` +
                    `Убедись, что каждый вызов даёт новую информацию.`,
            };
        }

        return { blocked: false };
    }

    /**
     * Записывает вызов в историю.
     * Вызывать ПОСЛЕ выполнения tool call (для разблокированных).
     */
    record(toolName: string, toolArgs: unknown): void {
        const hash = ToolLoopDetector.argsHash(toolArgs);
        this.window.push({ name: toolName, argsHash: hash });
        // Поддерживаем скользящее окно
        if (this.window.length > this.windowSize) {
            this.window.shift();
        }
    }

    /** Текущий размер окна (для диагностики) */
    get historyLength(): number {
        return this.window.length;
    }
}

// ============================================================================
// Types
// ============================================================================

export interface ReActLoopParams {
    /** Полная история сообщений (system + history + user) */
    messages: ChatMessage[];
    /** Доступные tools */
    tools: ToolDefinition[];
    /** Конфиг AI-клиента (основной — для tool-calling итераций) */
    aiConfig: {
        client: OpenAI;
        model: string;
        temperature: number;
        maxTokens: number;
        provider: AIProvider;
    };
    /** Model Cascade: конфиг для финального ответа (дорогая модель). Если не задан — используется aiConfig */
    finalAnswerAiConfig?: {
        client: OpenAI;
        model: string;
        temperature: number;
        maxTokens: number;
        provider: AIProvider;
    };
    /** Контекст выполнения */
    context: ToolExecutionContext;
    /** Максимум итераций (если не задан — рассчитывается адаптивно по complexity) */
    maxIterations?: number;
    /** Сложность задачи — для адаптивного лимита итераций */
    complexity?: string;
    /** Slug агента (для результата) */
    agentSlug: string;
    /** Callback для отправки processing_step событий в UI (опциональный) */
    broadcastStep?: (step: ProcessingStep) => void;
    /** ID сообщения для привязки шагов к timeline */
    messageId?: number;
    /** Фаза пайплайна — для разделения блоков мышления в UI */
    phase?: 'reflection' | 'response';
    /** Tool calls из рефлектора — для Duplicate Guard (не повторять те же вызовы) */
    reflectionToolCalls?: Array<{ toolName: string; input: Record<string, unknown>; success: boolean }>;
    /** Опции для Response Phase (двухфазная генерация).
     *  Если заданы — после завершения Action Phase (с tool calls) запускается
     *  отдельный вызов модели БЕЗ tools для формулировки ответа на основе
     *  реальных результатов. Это предотвращает ложные подтверждения действий. */
    responsePhaseOptions?: Omit<AssembleResponsePromptOptions, 'actionResults'>;
}

// ============================================================================
// ReAct Loop
// ============================================================================

/**
 * Главная функция — ReAct Loop
 * 
 * 1. Вызвать LLM с tools
 * 2. Если tool_calls → execute → inject results → goto 1
 * 3. Если text → вернуть как финальный ответ
 */
export async function executeReActLoop(params: ReActLoopParams): Promise<ReActResult> {
    const {
        messages: initialMessages,
        tools,
        aiConfig,
        finalAnswerAiConfig,
        context,
        maxIterations: explicitMaxIterations,
        complexity,
        agentSlug,
        broadcastStep,
        messageId = context.messageId || 0,
        phase,
    } = params;

    // Хелпер: уникальный stepId с phase prefix (предотвращает коллизию reflection/response)
    const phaseStepId = (id: string) => phase ? `${phase}_${id}` : id;

    // Адаптивный лимит: явный maxIterations → адаптивный по complexity → дефолт
    const maxIterations = explicitMaxIterations ?? getAdaptiveMaxIterations(complexity, tools.length);

    const openAITools = tools.length > 0 ? formatToolsForOpenAI(tools) : undefined;
    const allToolCalls: ToolCallLog[] = [];
    let totalTokens = 0;
    let usedFallback = false;
    let usedFinalModel = false;

    // 🔁 Tool Loop Detector: отслеживает повторяющиеся вызовы в скользящем окне
    const loopDetector = new ToolLoopDetector();

    // Allowlist: только разрешённые tools могут быть выполнены
    // Это КРИТИЧНО — модель может галлюцинировать tool names или вызывать tools
    // вне переданного набора (например browser_open из рефлектора)
    const allowedToolNames = new Set(tools.map(t => t.name));

    // Duplicate Guard: сигнатуры УСПЕШНЫХ tool calls рефлектора для предотвращения повторных вызовов
    // Фейловые вызовы НЕ блокируются — основной агент должен иметь возможность повторить их
    const reflectionSignatures = new Set(
        (params.reflectionToolCalls || [])
            .filter(tc => tc.success !== false)
            .map(tc => `${tc.toolName}:${JSON.stringify(tc.input)}`)
    );

    // Мутабельная копия messages для добавления tool results
    // Добавляем инструкцию по эффективности если фаза response (не reflection)
    const messages: ChatMessage[] = [...initialMessages];
    if (phase === 'response' && tools.length > 0) {
        messages.push({ role: 'system' as const, content: EFFICIENCY_INSTRUCTION });
    }

    console.log(`[ReActLoop] 🏁 Старт: maxIterations=${maxIterations} (complexity=${complexity || 'default'}, tools=${tools.length})`);

    // ─── Saturation Guard: отслеживание новизны для фазы reflection ───
    // Вместо жёстких лимитов на итерации — анализируем, приносят ли tool calls
    // новую информацию. Если 2 итерации подряд дают <15% новых данных — останавливаемся.
    const saturationState = {
        /** Уникальные "контентные" слова из результатов tool calls (length > 3, lowercase) */
        seenContentWords: new Set<string>(),
        /** Новизна (0..1) по каждой итерации: доля слов, которых ещё не видели */
        noveltyPerIteration: [] as number[],
        /** Счётчик последовательных итераций с низкой новизной */
        consecutiveLowNovelty: 0,
    };
    /** Минимум итераций до активации Saturation Guard (позволяет начальное исследование) */
    const SATURATION_MIN_ITERATIONS = 3;
    /** Порог новизны: если < 15% слов — новых данных почти нет */
    const SATURATION_LOW_NOVELTY_THRESHOLD = 0.15;
    /** Стоп после N подряд низко-новизных итераций */
    const SATURATION_CONSECUTIVE_LIMIT = 2;

    // Обогащаем context с broadcastStep для проброса в tool handlers (delegate_task → spawnSubagent)
    const enrichedContext = { ...context, broadcastStep };
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        // 1. Вызов LLM
        // ⚡ Fast Path + первая итерация: принудительный tool_choice='required'
        // Это заставляет DeepSeek API вернуть tool_calls вместо текста
        const isFastPath = !!params.context?._isFastPath;
        const forceToolCall = isFastPath && iteration <= 2 && allToolCalls.length === 0;
        const toolCallOptions: { tools?: typeof openAITools; tool_choice?: 'auto' | 'required' | 'none' } = {};
        if (openAITools) {
            toolCallOptions.tools = openAITools;
            if (forceToolCall) {
                toolCallOptions.tool_choice = 'required';
                console.log(`[ReActLoop] ⚡ Итерация ${iteration}: tool_choice=required (Fast Path, принудительный вызов инструмента)`);
            }
        }

        // ── Defensive: LLM-вызов может бросить exception (сеть, timeout после всех retry) ──
        let llmResult: AICallResult;
        try {
            llmResult = await callWithFallback(
                aiConfig,
                messages,
                toolCallOptions.tools ? toolCallOptions : undefined,
            );
        } catch (llmError: any) {
            console.error(`[ReActLoop] 🔴 LLM call failed (итерация ${iteration}):`, llmError?.message || String(llmError));

            // Логируем для диагностики
            logToolCall({
                toolName: '__llm_call_crash__',
                input: { iteration, model: aiConfig.model, provider: aiConfig.provider },
                result: { error: `LLM call crash: ${llmError?.message || String(llmError)}` },
                success: false,
                error: `LLM crash (iter ${iteration}): ${llmError?.message || String(llmError)}`,
                durationMs: 0,
                agentSlug: agentSlug || 'unknown',
                messageId,
                sessionId: context.sessionId,
                iteration,
                displayText: `🔴 LLM CRASH: ${llmError?.message || 'unknown error'}`,
            }).catch(() => {});

            // Если есть результаты от предыдущих итераций — собираем ответ из них
            if (allToolCalls.length > 0) {
                const successResults = allToolCalls.filter(tc => tc.result.success);
                if (successResults.length > 0) {
                    const summary = successResults
                        .map(tc => `• ${tc.toolName}: ${tc.result.displayText?.substring(0, 500) || 'OK'}`)
                        .join('\n');
                    return {
                        content: `Вот что удалось выяснить:\n\n${summary}`,
                        tokensUsed: totalTokens,
                        toolCalls: allToolCalls,
                        iterations: iteration,
                        agentSlug,
                        usedFallback,
                    };
                }
            }

            // Первая итерация, ничего нет — бросаем наверх, оркестратор сделает fallback
            throw llmError;
        }

        totalTokens += llmResult.tokensUsed;
        if (llmResult.usedFallback) usedFallback = true;

        // ── Обнаружение ошибки-заглушки от callWithFallback ──
        // Если все провайдеры упали, callWithFallback возвращает { _isError: true, content: '...' }
        // вместо throw. Без этой проверки ошибочное сообщение принималось как валидный ответ
        // модели и отправлялось пользователю.
        if ((llmResult as any)._isError) {
            console.error(`[ReActLoop] 🔴 callWithFallback вернул ошибку-заглушку (итерация ${iteration}). Все провайдеры упали.`);

            // Логируем для диагностики
            logToolCall({
                toolName: '__all_providers_failed__',
                input: { iteration, model: aiConfig.model, provider: aiConfig.provider },
                result: { error: `All providers failed, error placeholder returned` },
                success: false,
                error: `All providers failed (iter ${iteration})`,
                durationMs: 0,
                agentSlug: agentSlug || 'unknown',
                messageId,
                sessionId: context.sessionId,
                iteration,
                displayText: `🔴 Все провайдеры вернули ошибку на итерации ${iteration}`,
            }).catch(() => {});

            // Если есть результаты от предыдущих итераций — собираем ответ из них
            if (allToolCalls.length > 0) {
                const successResults = allToolCalls.filter(tc => tc.result.success);
                if (successResults.length > 0) {
                    const summary = successResults
                        .map(tc => `• ${tc.toolName}: ${tc.result.displayText?.substring(0, 500) || 'OK'}`)
                        .join('\n');
                    return {
                        content: `Вот что удалось выяснить:\n\n${summary}`,
                        tokensUsed: totalTokens,
                        toolCalls: allToolCalls,
                        iterations: iteration,
                        agentSlug,
                        usedFallback,
                    };
                }
            }

            // Первая итерация, ничего нет — бросаем наверх
            throw new Error(`All AI providers failed on iteration ${iteration}`);
        }

        // 2. Проверяем: есть ли tool_calls?
        const parsedToolCalls = llmResult.toolCalls || [];

        if (parsedToolCalls.length === 0) {
            const textContent = llmResult.content || '';

            // 🛡️ XML Rescue: если callWithFallback не извлёк tool calls, но текст содержит XML — парсим повторно
            if (textContent && iteration < maxIterations) {
                const rescuedToolCalls = parseXmlToolCalls(textContent, openAITools);
                if (rescuedToolCalls.length > 0) {
                    console.warn(`[ReActLoop] 🚨 XML Rescue: извлечено ${rescuedToolCalls.length} tool calls из текста (итерация ${iteration}): ${rescuedToolCalls.map(tc => tc.name).join(', ')}`);
                    parsedToolCalls.push(...rescuedToolCalls);
                }
            }
        }

        // Если после XML Rescue всё ещё нет tool calls — это текстовый ответ
        if (parsedToolCalls.length === 0) {
            let textContent = llmResult.content || '';

            // 🛡️ Если модель вернула пустой текст без tool_calls на первой итерации — retry
            if (!textContent.trim() && iteration === 1 && iteration < maxIterations) {
                console.warn(`[ReActLoop] ⚠️ Пустой ответ без tool_calls на итерации 1, retry`);
                messages.push(
                    { role: 'assistant' as const, content: '' },
                    { role: 'user' as const, content: 'Пожалуйста, ответь на мой вопрос.' },
                );
                continue;
            }

            // 🛡️ Детекция "описания инструментов" вместо реального function call
            // Если модель написала "подожди, сейчас найду..." вместо вызова tool — retry
            const toolIntentPatterns = [
                /подожд[иь]\s*(секунд|минут|пока)/i,
                /сейчас\s*(я\s*)?(найд|поищ|получ|провер[юы]|загруж|посмотр)/i,
                /сначала\s*(я\s*)?(найд|поищ|получ|провер[юы])/i,
                /давай\s*(я\s*)?(найд|поищ|получ|провер[юы])/i,
                /позволь\s*(мне\s*)?(найти|поискать|получить)/i,
                /let me\s*(find|search|get|check|look)/i,
                /I('ll| will)\s*(find|search|get|check|look)/i,
                /\[\d{2}\.\d{2}\.\d{4}.*?\].*?(ищу|поиск|директива)/i,
                /\*\*Сначала — поиск данных/i,
                /Это займёт (\d+ |несколько )?(секунд|минут)/i,
                /я\s+в процессе\s+поиска/i,
                /подготавливаю\s+информацию/i,
                /сейчас\s+сделаю/i,
                // Простые формы глаголов ("Проверяю.", "Ищу задачи.", "Смотрю.")
                /^проверяю/im,
                /^ищу\b/im,
                /^смотрю\b/im,
                /^загружаю\b/im,
                /^получаю\b/im,
                /^запрашиваю\b/im,
                /да, могу.*провер/i,
            ];

            const looksLikeToolIntent = toolIntentPatterns.some(p => p.test(textContent));

            if (looksLikeToolIntent && iteration < maxIterations) {
                console.warn(`[ReActLoop] ⚠️ Итерация ${iteration}: модель описала tool-intent текстом вместо function call. Повтор с подсказкой.`);

                // Broadcast warning
                if (broadcastStep && messageId) {
                    broadcastStep({
                        type: 'processing_step',
                        messageId,
                        stepId: phaseStepId(`tool_intent_retry_${iteration}`),
                        stepName: 'Коррекция: повтор вызова инструментов',
                        stepIcon: '🔄',
                        status: 'completed',
                        output: {
                            summary: 'Модель описала действия текстом вместо вызова инструментов. Повторяю.',
                            data: { textSnippet: textContent.substring(0, 100), iteration },
                            kind: 'thinking',
                            phase,
                        },
                        timestamp: new Date().toISOString(),
                    });
                }

                // Инъекция подсказки — не описывай, а вызывай
                const retryAssistantMsg: any = { role: 'assistant' as const, content: textContent };
                if (llmResult.reasoningContent) retryAssistantMsg.reasoning_content = llmResult.reasoningContent;
                messages.push(
                    retryAssistantMsg,
                    { role: 'user' as const, content: 'Не описывай действия текстом — ВЫЗОВИ нужный инструмент через function call прямо сейчас. У тебя есть доступные tools.' },
                );
                continue; // Следующая итерация ReAct Loop
            }

            // 🛡️ False Success Guard: модель утверждает "Готово/Создано/Записал", 
            // но НЕ вызвала ни одного tool. Это галлюцинация — retry с коррекцией.
            if (allToolCalls.length === 0 && iteration <= 2 && iteration < maxIterations && tools.length > 0) {
                const falseSuccessPatterns = [
                    /готово/i,
                    /задача\s+(создан|добавлен|записан|поставлен)/i,
                    /создал[аи]?\s+(задач|напоминани|заметк|событи)/i,
                    /записал[аи]?\b/i,
                    /сохранил[аи]?\b/i,
                    /добавил[аи]?\s+(задач|запис|заметк|пункт)/i,
                    /встреча\s+назначен/i,
                    /напоминание\s+(создан|установлен|поставлен)/i,
                    /✅\s*(задача|готово|создан|добавлен|сохранен)/i,
                    /выполнено/i,
                    /сделано/i,
                ];

                const looksLikeFalseSuccess = falseSuccessPatterns.some(p => p.test(textContent));

                if (looksLikeFalseSuccess) {
                    console.warn(`[ReActLoop] 🚨 False Success Guard: итерация ${iteration}, модель утверждает успех ("${textContent.substring(0, 80)}") без tool calls. Повтор с коррекцией.`);

                    // Broadcast warning
                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: phaseStepId(`false_success_retry_${iteration}`),
                            stepName: 'Коррекция: требуется вызов инструмента',
                            stepIcon: '🛡️',
                            status: 'completed',
                            output: {
                                summary: 'Модель подтвердила выполнение без вызова инструмента. Принудительный повтор.',
                                data: { textSnippet: textContent.substring(0, 100), iteration },
                                kind: 'thinking',
                                phase,
                            },
                            timestamp: new Date().toISOString(),
                        });
                    }

                    const falseSuccessMsg: any = { role: 'assistant' as const, content: textContent };
                    if (llmResult.reasoningContent) falseSuccessMsg.reasoning_content = llmResult.reasoningContent;
                    messages.push(
                        falseSuccessMsg,
                        { role: 'user' as const, content: 'СТОП. Ты написал что задача выполнена, но ты НЕ ВЫЗВАЛ ни одного инструмента! Действие НЕ было выполнено. Ты ОБЯЗАН вызвать инструмент (function call / tool_call) чтобы реально выполнить действие. Вызови нужный tool прямо сейчас.' },
                    );
                    continue;
                }
            }

            let finalContent = textContent;

            // ═══════════════════════════════════════════════════════════
            // 📝 Response Phase (двухфазная генерация)
            // ═══════════════════════════════════════════════════════════
            // Если были tool calls (iteration > 1) И есть responsePhaseOptions —
            // запускаем отдельный вызов модели БЕЗ tools для формулировки ответа
            // на основе РЕАЛЬНЫХ результатов. Это предотвращает ложные подтверждения.
            //
            // Если 0 tool calls (iteration === 1) — текст из Action Phase
            // возвращается как есть (оптимизация: простой chat не требует 2 фаз).
            // ═══════════════════════════════════════════════════════════

            if (iteration > 1 && params.responsePhaseOptions && allToolCalls.length > 0) {
                try {
                    // Собираем сводку реальных tool call results
                    const actionResultsLines = allToolCalls.map(tc => {
                        const status = tc.result.success ? '✅' : '❌';
                        const detail = tc.result.success
                            ? tc.result.displayText.substring(0, 5000)
                            : `ОШИБКА: ${tc.result.error || 'неизвестная ошибка'}`;
                        return `${status} ${tc.toolName}(${JSON.stringify(tc.input).substring(0, 500)}) → ${detail}`;
                    });
                    const actionResults = actionResultsLines.join('\n');

                    // Добавляем thinking из Action Phase как черновик ответа для Response Phase.
                    // Это критически важно: без черновика Response Phase модель "залипает" 
                    // на контексте (200K+ токенов) и игнорирует краткие action results (~300 символов).
                    const actionThinking = textContent?.trim()
                        ? `\n\n## ЧЕРНОВИК ОТВЕТА (может быть ошибочным или содержать только статус выполнения — используй РЕАЛЬНЫЕ РЕЗУЛЬТАТЫ выше как приоритет):\n${textContent}`
                        : '';

                    // Собираем промпт Response Phase (теперь возвращает массив сообщений)
                    const responseSystemMessages = assembleResponsePrompt({
                        ...params.responsePhaseOptions,
                        actionResults: actionResults + actionThinking,
                    });

                    // Выбираем модель: в Fast Path всегда используем текущую (дешевую), 
                    // иначе finalAnswerAiConfig (дорогую) или основной aiConfig
                    const isFastPath = params.responsePhaseOptions?.isFastPath;
                    const responseConfig = isFastPath ? aiConfig : (finalAnswerAiConfig ?? aiConfig);

                    console.log(`[ReActLoop] 📝 Response Phase: ${responseConfig.model} (${allToolCalls.length} tool calls в сводке, isFastPath: ${!!isFastPath})`);

                    // Broadcast: Response Phase running
                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `response_phase`,
                            stepName: `Формулировка ответа (${responseConfig.model})`,
                            stepIcon: '📝',
                            status: 'running',
                            timestamp: new Date().toISOString(),
                        });
                    }

                    // Формируем сообщения для Response Phase:
                    // system messages (stable + dynamic) + последние сообщения пользователя
                    const responseMessages: ChatMessage[] = [
                        ...responseSystemMessages,
                    ];

                    // Добавляем историю диалога из контекста (если есть)
                    if (params.responsePhaseOptions.context?.recentMessages) {
                        const lastMsg = params.responsePhaseOptions.context.recentMessages[
                            params.responsePhaseOptions.context.recentMessages.length - 1
                        ];
                        const isImageMessage = lastMsg?.type === 'image' && lastMsg?.fileUrl;
                        const conversationHistory = formatMessagesForPrompt(
                            isImageMessage
                                ? params.responsePhaseOptions.context.recentMessages
                                : params.responsePhaseOptions.context.recentMessages.slice(0, -1)
                        );
                        responseMessages.push(...conversationHistory);

                        // Если последнее сообщение не image — добавляем user message
                        if (!isImageMessage) {
                            // Берём ПОСЛЕДНИЙ user message из initialMessages — это текущее сообщение пользователя
                            // (.find() брал бы ПЕРВЫЙ user msg из conversation history — баг!)
                            const userMsg = [...initialMessages].reverse().find(m => m.role === 'user');
                            if (userMsg) {
                                responseMessages.push(userMsg);
                            }
                        }
                    } else {
                        // Fallback: берём ПОСЛЕДНИЙ user message из начальных сообщений
                        const userMsg = [...initialMessages].reverse().find(m => m.role === 'user');
                        if (userMsg) {
                            responseMessages.push(userMsg);
                        }
                    }

                    // Вызов модели БЕЗ tools
                    const responseResult = await callWithFallback(responseConfig, responseMessages);
                    finalContent = responseResult.content;
                    totalTokens += responseResult.tokensUsed;
                    if (responseConfig === finalAnswerAiConfig) usedFinalModel = true;
                    if (responseResult.usedFallback) usedFallback = true;

                    // 🛡️ Валидация: если Response Phase вернул пустой контент — fallback на текст Action Phase
                    if (!finalContent?.trim()) {
                        console.warn(`[ReActLoop] ⚠️ Response Phase вернул пустой ответ, используем текст Action Phase`);
                        finalContent = textContent;
                    }

                    console.log(`[ReActLoop] 📝 Response Phase: ответ от ${responseConfig.model} (${responseResult.tokensUsed} tokens)`);

                    // Broadcast: completed
                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `response_phase`,
                            stepName: `Формулировка ответа (${responseConfig.model})`,
                            stepIcon: '📝',
                            status: 'completed',
                            output: {
                                summary: `Ответ от ${responseConfig.model}`,
                                data: {
                                    actionModel: aiConfig.model,
                                    responseModel: responseConfig.model,
                                    toolCallsInSummary: allToolCalls.length,
                                    tokensUsed: responseResult.tokensUsed,
                                },
                                kind: 'response_phase',
                                phase,
                            },
                            timestamp: new Date().toISOString(),
                        });
                    }
                } catch (error) {
                    console.error(`[ReActLoop] ⚠️ Response Phase error, формируем ответ из результатов:`, error);

                    // 🛡️ Graceful Degradation: вместо потери всего контекста,
                    // формируем ответ из имеющихся tool call results
                    if (textContent?.trim()) {
                        // Есть черновик от Action Phase — используем его
                        finalContent = textContent;
                        console.log(`[ReActLoop] 📋 Fallback: используем черновик Action Phase (${textContent.length} символов)`);
                    } else {
                        // Черновика нет — формируем структурированную сводку из результатов
                        const successResults = allToolCalls.filter(tc => tc.result.success);
                        const failedResults = allToolCalls.filter(tc => !tc.result.success);
                        
                        if (successResults.length > 0) {
                            const resultSummary = successResults.map(tc => {
                                const text = tc.result.displayText;
                                // Ограничиваем каждый результат 2000 символами
                                return text.length > 2000 ? text.substring(0, 2000) + '...' : text;
                            }).join('\n\n---\n\n');
                            
                            finalContent = resultSummary;
                            
                            if (failedResults.length > 0) {
                                finalContent += `\n\n⚠️ Некоторые операции завершились с ошибкой (${failedResults.length} из ${allToolCalls.length}).`;
                            }
                            
                            console.log(`[ReActLoop] 📋 Fallback: сформирован ответ из ${successResults.length} результатов tool calls`);
                        } else {
                            finalContent = 'Извини, произошла ошибка при формировании ответа, но данные были собраны. Попробуй задать вопрос ещё раз.';
                        }
                    }

                    // Broadcast: ошибка с информацией о fallback
                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `response_phase`,
                            stepName: `Response Phase — ошибка, fallback на собранные данные`,
                            stepIcon: '⚠️',
                            status: 'error',
                            error: String(error),
                            output: {
                                summary: `Ответ сформирован из ${allToolCalls.filter(tc => tc.result.success).length} результатов tool calls`,
                                data: { fallbackType: textContent?.trim() ? 'action_phase_draft' : 'tool_results_summary' },
                                kind: 'response_phase',
                                phase,
                            },
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            } else if (finalAnswerAiConfig && iteration > 1 && !params.responsePhaseOptions && !params.context._isFastPath) {
                // 🏆 Legacy Model Cascade (backward compatibility — если responsePhaseOptions не переданы)
                try {
                    console.log(`🏆 Model Cascade: переключение на ${finalAnswerAiConfig.model} для финального ответа (iteration ${iteration})`);

                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `model_cascade`,
                            stepName: `Финальный ответ (${finalAnswerAiConfig.model})`,
                            stepIcon: '🏆',
                            status: 'running',
                            timestamp: new Date().toISOString(),
                        });
                    }

                    const cascadeResult = await callWithFallback(finalAnswerAiConfig, messages);
                    finalContent = cascadeResult.content;
                    totalTokens += cascadeResult.tokensUsed;
                    usedFinalModel = true;

                    if (!finalContent?.trim()) {
                        console.warn(`[ReActLoop] ⚠️ Model Cascade вернул пустой ответ, используем thinking model`);
                        finalContent = textContent;
                    }
                    if (cascadeResult.usedFallback) usedFallback = true;

                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `model_cascade`,
                            stepName: `Финальный ответ (${finalAnswerAiConfig.model})`,
                            stepIcon: '🏆',
                            status: 'completed',
                            output: {
                                summary: `Ответ от ${finalAnswerAiConfig.model}`,
                                data: {
                                    thinkingModel: aiConfig.model,
                                    finalModel: finalAnswerAiConfig.model,
                                    tokensUsed: cascadeResult.tokensUsed,
                                },
                                kind: 'model_cascade',
                                phase,
                            },
                            timestamp: new Date().toISOString(),
                        });
                    }
                } catch (error: any) {
                    console.error(`⚠️ Model Cascade error [${error?.constructor?.name}]:`, error?.message || error);
                    // Если textContent доступен — будет использован ниже
                    // Если нет — собираем из tool results
                    if (!textContent?.trim() && allToolCalls.length > 0) {
                        const successResults = allToolCalls.filter(tc => tc.result.success);
                        if (successResults.length > 0) {
                            finalContent = successResults
                                .map(tc => tc.result.displayText?.substring(0, 2000) || 'OK')
                                .join('\n\n---\n\n');
                            console.log(`[ReActLoop] 📋 Model Cascade fallback: ответ из ${successResults.length} tool results`);
                        }
                    }
                    if (broadcastStep && messageId) {
                        broadcastStep({
                            type: 'processing_step',
                            messageId,
                            stepId: `model_cascade`,
                            stepName: `Финальная модель — ошибка, fallback`,
                            stepIcon: '⚠️',
                            status: 'error',
                            error: String(error),
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            }

            // 🛡️ Финальная проверка: если контент всё ещё пуст — recovery call
            if (!finalContent?.trim()) {
                console.error(`[ReActLoop] ❌ Финальный контент пуст после ${iteration} итераций. Recovery call без tools.`);
                try {
                    const recoveryResult = await callWithFallback(aiConfig, messages);
                    finalContent = recoveryResult.content || 'Извини, произошла ошибка при формировании ответа. Попробуй задать вопрос ещё раз.';
                    totalTokens += recoveryResult.tokensUsed;
                    if (recoveryResult.usedFallback) usedFallback = true;
                } catch (recoveryError) {
                    console.error(`[ReActLoop] ❌ Recovery call failed:`, recoveryError);
                    finalContent = 'Извини, произошла ошибка при формировании ответа. Попробуй задать вопрос ещё раз.';
                }
            }

            // Broadcast: финальное размышление
            if (broadcastStep && messageId && finalContent) {
                broadcastStep({
                    type: 'processing_step',
                    messageId,
                    stepId: phaseStepId(`thinking_final`),
                    stepName: 'Формирование ответа',
                    stepIcon: '📝',
                    status: 'completed',
                    output: {
                        summary: finalContent.substring(0, 100),
                        thinking: finalContent,
                        iteration,
                        kind: 'thinking',
                        phase,
                    },
                    timestamp: new Date().toISOString(),
                });
            }

            // Финальный ответ
            return {
                content: finalContent,
                tokensUsed: totalTokens,
                toolCalls: allToolCalls,
                iterations: iteration,
                agentSlug,
                usedFallback,
                usedFinalModel,
            };
        }

        // 3. Выполняем tool calls ПАРАЛЛЕЛЬНО
        // ── Defensive wrapper: любая ошибка в tool execution НЕ должна убивать ReAct Loop ──
        // unblockedToolCalls объявлен снаружи try, чтобы catch использовал его для корректных tool_call_id
        let unblockedToolCalls: ParsedToolCall[] = parsedToolCalls;
        try {
        console.log(`[ReActLoop] 🔄 Iteration ${iteration}: ${parsedToolCalls.length} tool call(s)`);

        // Broadcast: thinking text перед tool calls (размышление AI)
        if (broadcastStep && messageId) {
            const thinkingText = llmResult.content?.trim() || '';
            // Если LLM не вернул content (типичное поведение OpenAI при tool calls),
            // синтезируем описание решения из списка вызываемых tools
            const toolNames = parsedToolCalls.map(tc => tc.name).join(', ');
            const syntheticThinking = thinkingText
                || `Решение: вызвать ${parsedToolCalls.length > 1 ? 'инструменты' : 'инструмент'} ${toolNames}`;

            broadcastStep({
                type: 'processing_step',
                messageId,
                stepId: phaseStepId(`thinking_${iteration}`),
                stepName: `Размышление #${iteration}`,
                stepIcon: '💭',
                status: 'completed',
                output: {
                    summary: syntheticThinking.substring(0, 100),
                    thinking: syntheticThinking,
                    iteration,
                    kind: 'thinking',
                    phase,
                },
                timestamp: new Date().toISOString(),
            });
        }

        // ─── 🔁 Tool Loop Detection ───
        // Проверяем ПЕРЕД добавлением assistantMsg в историю.
        // Это критично: если все tools заблокированы, мы НЕ добавляем assistantMsg
        // с tool_calls, которые не имеют парных tool result messages.
        // Невалидный контекст (assistant с tool_calls без tool messages) → 400 от OpenAI API.
        const blockedIndices = new Set<number>();
        const warningMessages: string[] = [];

        for (let i = 0; i < parsedToolCalls.length; i++) {
            const toolCall = parsedToolCalls[i]!;
            const loopCheck = loopDetector.check(toolCall.name, toolCall.arguments);
            if (loopCheck.level === 'critical' && loopCheck.blocked) {
                blockedIndices.add(i);
                console.warn(`[ReActLoop] 🔁 Tool Loop BLOCKED: ${toolCall.name} (iter ${iteration}): ${loopCheck.reason}`);
            } else if (loopCheck.level === 'warning' && loopCheck.reason) {
                warningMessages.push(loopCheck.reason);
                console.warn(`[ReActLoop] 🔁 Tool Loop WARNING: ${toolCall.name} (iter ${iteration}): ${loopCheck.reason}`);
            }
        }

        unblockedToolCalls = parsedToolCalls.filter((_, i) => !blockedIndices.has(i));
        const blockedToolNames = parsedToolCalls.filter((_, i) => blockedIndices.has(i)).map(tc => tc.name);

        // Если все tool calls заблокированы — не добавляем assistantMsg и переходим к след. итерации
        if (unblockedToolCalls.length === 0 && blockedToolNames.length > 0) {
            const blockMsg = `🔁 TOOL LOOP DETECTED: Инструменты [${blockedToolNames.join(', ')}] вызывались с теми же параметрами несколько раз подряд и больше не будут выполняться. Результат не изменится. Попробуй другой подход или дай финальный ответ пользователю.`;
            console.warn(`[ReActLoop] 🛑 Все tool calls заблокированы Loop Detector — инъекция без assistantMsg`);
            // Инъецируем как user message — не добавляем assistantMsg с пустыми tool_calls
            messages.push({ role: 'user' as const, content: blockMsg });

            // Broadcast: блокировка
            if (broadcastStep && messageId) {
                broadcastStep({
                    type: 'processing_step',
                    messageId,
                    stepId: phaseStepId(`loop_blocked_${iteration}`),
                    stepName: 'Tool Loop заблокирован',
                    stepIcon: '🔁',
                    status: 'error',
                    error: blockMsg,
                    output: {
                        summary: `Зацикливание: ${blockedToolNames.join(', ')}`,
                        data: { blockedTools: blockedToolNames, iteration },
                        kind: 'thinking',
                        phase,
                    },
                    timestamp: new Date().toISOString(),
                });
            }

            // Следующая итерация — модель получит сообщение и должна дать финальный ответ
            continue;
        }

        // Если есть предупреждения — инъецируем перед assistantMsg как user message.
        // Нельзя после assistantMsg с tool_calls — там должны идти только tool result messages.
        if (warningMessages.length > 0) {
            messages.push({ role: 'user' as const, content: warningMessages.join('\n') } as any);
        }

        // Добавляем assistant message с tool_calls в историю.
        // Включаем только НЕЗАБЛОКИРОВАННЫЕ tool_calls (при частичной блокировке).
        // ВАЖНО: для DeepSeek thinking-моделей (deepseek-v4-flash) необходимо
        // сохранять reasoning_content — без него следующий вызов вернёт 400.
        const assistantMsg: any = {
            role: 'assistant' as const,
            content: llmResult.content || '',
            tool_calls: unblockedToolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                },
            })),
        };
        if (llmResult.reasoningContent) {
            assistantMsg.reasoning_content = llmResult.reasoningContent;
        }
        messages.push(assistantMsg);

        // Broadcast: отмечаем каждый tool call как running (только незаблокированные)
        if (broadcastStep && messageId) {
            for (const tc of unblockedToolCalls) {
                const stepDef = createToolCallStepDef(tc.name, iteration, phase);
                broadcastStep({
                    type: 'processing_step',
                    messageId,
                    stepId: stepDef.id,
                    stepName: stepDef.name,
                    stepIcon: stepDef.icon,
                    status: 'running',
                    timestamp: new Date().toISOString(),
                });
            }
        }

        // Запускаем все tools параллельно (с проверкой allowlist, только незаблокированные)
        const toolResults = await Promise.all(
            unblockedToolCalls.map(toolCall => {
                // ━━━ Duplicate Notice: логируем совпадение с рефлектором, но НЕ блокируем ━━━
                // Основной агент может иметь причины для повторного вызова (уточнение, расширение запроса).
                // Блокировка приводила к тому, что модель не могла использовать инструменты вообще.
                if (reflectionSignatures.size > 0) {
                    const sig = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
                    if (reflectionSignatures.has(sig)) {
                        console.log(`[ReActLoop] ℹ️ Duplicate Notice: ${toolCall.name} совпадает с вызовом рефлектора (выполняется повторно)`);
                    }
                }
                // Записываем в историю детектора после разрешения на выполнение
                loopDetector.record(toolCall.name, toolCall.arguments);
                return executeSingleTool(toolCall, enrichedContext, iteration, allowedToolNames);
            })
        );

        // Broadcast: отмечаем каждый tool call как completed/error (с полными данными для Reasoning Chain)
        if (broadcastStep && messageId) {
            for (const result of toolResults) {
                const stepDef = createToolCallStepDef(result.toolName, iteration, phase);
                broadcastStep({
                    type: 'processing_step',
                    messageId,
                    stepId: stepDef.id,
                    stepName: stepDef.name,
                    stepIcon: stepDef.icon,
                    status: result.result.success ? 'completed' : 'error',
                    duration: result.durationMs,
                    output: {
                        summary: result.result.success
                            ? result.result.displayText.substring(0, 100)
                            : `Ошибка: ${result.result.error}`,
                        toolInput: result.input as Record<string, any>,
                        toolOutput: result.result.displayText,
                        iteration,
                        kind: 'tool_call',
                        phase,
                        data: {
                            success: result.result.success,
                        },
                    },
                    error: result.result.error,
                    timestamp: new Date().toISOString(),
                });
            }
        }

        // Добавляем результаты в историю (в том же порядке, что и вызовы - хотя для chat completions порядок не критичен, но лучше сохранять)
        for (const result of toolResults) {
            allToolCalls.push(result);

            // Находим исходный toolCall для id (хотя они в том же порядке)
            const originalCall = parsedToolCalls.find(tc => tc.name === result.toolName && tc.arguments === result.input); // не совсем надежно, лучше по индексу или id если бы он был проброшен

            // Если есть изображение (скриншот) — формируем multipart content для vision model
            // Defensive: displayText может быть undefined при ошибке tool handler
            const safeDisplayText = result.result.displayText || result.result.error || `Tool ${result.toolName} завершён`;

            // Включаем data в контент для LLM — без этого AI не видит структурированные данные
            // (ID задач, массивы, объекты). displayText — для человека, data — для AI.
            let fullToolContent = safeDisplayText;
            if (result.result.success && result.result.data != null) {
                try {
                    const dataJson = JSON.stringify(result.result.data);
                    // Добавляем data только если он не слишком большой (лимит ~8KB для экономии контекста)
                    if (dataJson.length <= 8192) {
                        fullToolContent = `${safeDisplayText}\n\n<tool_data>\n${dataJson}\n</tool_data>`;
                    }
                } catch {
                    // JSON.stringify может упасть при циклических ссылках — игнорируем
                }
            }

            const toolContent = result.result.imageBase64
                ? [
                    { type: 'text' as const, text: fullToolContent },
                    { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${result.result.imageBase64}`, detail: 'low' as const } },
                ]
                : fullToolContent;

            messages.push({
                role: 'tool' as any,
                content: toolContent,
                // @ts-ignore — tool_call_id для OpenAI
                tool_call_id: result.toolCallId, // Важно: executeSingleTool должен возвращать ID
            } as any);
        }

        // ─── Tool Results Summary Injection ───
        // Инъецируем явную сводку success/failure, чтобы модель НЕ подтверждала
        // выполнение действий, которые на самом деле завершились ошибкой
        const hasWriteTools = toolResults.some(r => 
            !r.toolName.startsWith('get_') && 
            !r.toolName.startsWith('search_') && 
            !r.toolName.startsWith('find_')
        );
        if (hasWriteTools) {
            const summaryLines = toolResults
                .filter(r => 
                    !r.toolName.startsWith('get_') && 
                    !r.toolName.startsWith('search_') && 
                    !r.toolName.startsWith('find_')
                )
                .map(r => r.result.success
                    ? `✅ ${r.toolName} → success`
                    : `❌ ${r.toolName} → ОШИБКА: ${r.result.error || 'неизвестная ошибка'}`
                );
            messages.push({
                role: 'system' as any,
                content: `⚠️ РЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ (проверь перед подтверждением пользователю):\n${summaryLines.join('\n')}\n\nЕсли инструмент вернул ❌ — НЕ подтверждай выполнение. Сообщи пользователю об ошибке.`,
            } as any);
        }

        // ─── Repetition Guard & Browser Watchdog ───
        if (allToolCalls.length >= 3) {
            const last3 = allToolCalls.slice(-3);
            const allFailed = last3.every(tc => !tc.result.success);

            // 1. Strict & Fuzzy Repetition Guard
            if (allFailed) {
                const signatures = last3.map(tc => `${tc.toolName}:${JSON.stringify(tc.input)}`);
                const allSameExact = signatures[0] === signatures[1] && signatures[1] === signatures[2];

                // Fuzzy: проверяем совпадение имени функции и начального паттерна ошибки (например, та же самая ошибка валидации)
                const errorPatterns = last3.map(tc => `${tc.toolName}:${tc.result.error?.substring(0, 50)}`);
                const allSamePattern = errorPatterns[0] === errorPatterns[1] && errorPatterns[1] === errorPatterns[2];

                if (allSameExact || allSamePattern) {
                    console.warn(`[ReActLoop] 🔄 Repetition Guard: 3 ошибочных вызова "${last3[0].toolName}" подряд (exact: ${allSameExact}, fuzzy: ${allSamePattern})`);
                    messages.push({
                        role: 'system' as any,
                        content: `⚠️ REPETITION GUARD: Ты 3 раза подряд вызвал "${last3[0].toolName}" и получил одинаковую ошибку. ПРЕКРАТИ повторять то же самое!

ОБЯЗАТЕЛЬНО СМЕНИ СТРАТЕГИЮ:
1. Вызови browser_read(mode: "dom") чтобы обновить DOM и получить актуальные селекторы
2. Или вызови browser_read(mode: "screenshot") для визуальной диагностики
3. Или попробуй browser_act с evaluate (JS) для программного клика/ввода
4. Если ничего не помогает — сообщи об ошибке и заверши задачу

НЕ ПОВТОРЯЙ ТЕ ЖЕ ДЕЙСТВИЯ!`,
                    } as any);
                }
            }

            // 2. Browser Form Watchdog (для browser_act type/click)
            if (allToolCalls.length >= 4) {
                const last4 = allToolCalls.slice(-4);
                const browserActs = last4.filter(tc => tc.toolName === 'browser_act');
                if (browserActs.length === 4) {
                    // Извлекаем все actions
                    const actions = browserActs.flatMap(tc => {
                        const input = tc.input as any;
                        return Array.isArray(input.actions) ? input.actions : (input.actions ? [input.actions] : []);
                    });

                    // Проверяем, есть ли залипание на одном селекторе (более 3 раз)
                    const selectors = actions.filter(a => a.type === 'click' || a.type === 'type').map(a => a.selector).filter(Boolean);

                    // Подсчитываем частоту селекторов
                    const selectorFreq: Record<string, number> = {};
                    for (const s of selectors) {
                        selectorFreq[s] = (selectorFreq[s] || 0) + 1;
                    }

                    const stuckSelector = Object.keys(selectorFreq).find(s => selectorFreq[s] >= 4);
                    if (stuckSelector) {
                        console.warn(`[ReActLoop] 🕵️ Browser Form Watchdog: залипание на селекторе ${stuckSelector}`);
                        messages.push({
                            role: 'system' as any,
                            content: `⚠️ BROWSER FORM WATCHDOG: Зафиксировано залипание. Ты пытаешься взаимодействовать с селектором "${stuckSelector}" 4 раза подряд без успешного продвижения!

ВОЗМОЖНЫЕ ПРОБЛЕМЫ:
- Элемент скрыт (hidden/opacity:0) или перекрыт другим элементом.
- Селектор не уникален (matches multiple elements).
- Страница изменила состояние (появился попап, требуется скролл).

ТРЕБУЕМОЕ РЕШЕНИЕ:
Смени стратегию! Используй КООРДИНАТНЫЙ КЛИК {"type":"click", "x":..., "y":...} ИЛИ программный ввод через evaluate(JS) вместо обычного click/type по селектору.`,
                        } as any);
                    }
                }
            }
        }

        // ─── Saturation Guard (только для reflection phase) ───
        // Анализирует СОДЕРЖАТЕЛЬНУЮ новизну результатов tool calls.
        // Если 2 итерации подряд не дают новой информации — мягко останавливаем.
        // ВАЖНО: один и тот же инструмент с другими параметрами — это ОК.
        // Guard срабатывает ТОЛЬКО если результаты повторяют уже найденное.
        if (phase === 'reflection' && iteration >= SATURATION_MIN_ITERATIONS) {
            // Собираем текст результатов текущей итерации
            const iterationResultTexts = toolResults
                .filter(r => r.result.success)
                .map(r => r.result.displayText)
                .join(' ');

            // Извлекаем "контентные" слова (>3 символов, lowercase, без цифр)
            const words = iterationResultTexts
                .toLowerCase()
                .split(/[\s,.:;!?(){}[\]"'`\-—–/\\|]+/)
                .filter(w => w.length > 3 && !/^\d+$/.test(w));

            if (words.length > 0) {
                // Считаем, сколько слов — действительно новые
                const newWords = words.filter(w => !saturationState.seenContentWords.has(w));
                const novelty = newWords.length / words.length;
                saturationState.noveltyPerIteration.push(novelty);

                // Добавляем все слова в общий пул
                for (const w of words) saturationState.seenContentWords.add(w);

                console.log(`[ReActLoop] 📊 Saturation Guard (iter ${iteration}): ` +
                    `novelty=${Math.round(novelty * 100)}% ` +
                    `(${newWords.length}/${words.length} новых слов, ` +
                    `всего уникальных: ${saturationState.seenContentWords.size})`);

                if (novelty < SATURATION_LOW_NOVELTY_THRESHOLD) {
                    saturationState.consecutiveLowNovelty++;
                    console.warn(`[ReActLoop] ⚠️ Saturation: низкая новизна ${saturationState.consecutiveLowNovelty}/${SATURATION_CONSECUTIVE_LIMIT}`);

                    if (saturationState.consecutiveLowNovelty >= SATURATION_CONSECUTIVE_LIMIT) {
                        console.log(`[ReActLoop] 🛑 Saturation Guard: ${SATURATION_CONSECUTIVE_LIMIT} итераций подряд ` +
                            `с <${SATURATION_LOW_NOVELTY_THRESHOLD * 100}% новизной. ` +
                            `Мягкая остановка рефлексии — данных достаточно.`);

                        // Broadcast saturation event для UI
                        if (broadcastStep && messageId) {
                            broadcastStep({
                                type: 'processing_step',
                                messageId,
                                stepId: phaseStepId(`saturation_stop`),
                                stepName: 'Данных достаточно',
                                stepIcon: '📊',
                                status: 'completed',
                                output: {
                                    summary: `Saturation Guard: ${saturationState.seenContentWords.size} уникальных фрагментов собрано, новизна упала до ${Math.round(novelty * 100)}%`,
                                    data: {
                                        totalUniqueWords: saturationState.seenContentWords.size,
                                        noveltyHistory: saturationState.noveltyPerIteration.map(n => `${Math.round(n * 100)}%`),
                                        iterationsStopped: iteration,
                                    },
                                    kind: 'thinking',
                                    phase,
                                },
                                timestamp: new Date().toISOString(),
                            });
                        }

                        // Мягкий стоп: инъецируем directive, чтобы модель завершила цикл текстом
                        messages.push({
                            role: 'system' as any,
                            content: `📊 SATURATION GUARD: Последние ${SATURATION_CONSECUTIVE_LIMIT} итерации дали менее ${SATURATION_LOW_NOVELTY_THRESHOLD * 100}% новой информации. Данных ДОСТАТОЧНО для ответа. Ответь "COMPLETE" и заверши сбор контекста.`,
                        } as any);
                        // Не break — даём модели шанс ответить "COMPLETE" текстом на следующей итерации
                    }
                } else {
                    // Новизна высокая — сбрасываем счётчик
                    saturationState.consecutiveLowNovelty = 0;
                }
            }
        }

        // ─── Read-Only Streak Watchdog ───
        // Если агент 3+ итерации подряд вызывает только read-only tools (get_*, search_*)
        // → подсказываем перейти к действиям и ответу
        if (phase === 'response' && iteration >= 3 && iteration < maxIterations - 1) {
            const readOnlyPrefixes = ['get_', 'search_', 'find_'];
            let readOnlyStreak = 0;
            for (let i = allToolCalls.length - 1; i >= 0; i--) {
                const isReadOnly = readOnlyPrefixes.some(p => allToolCalls[i].toolName.startsWith(p));
                if (isReadOnly) readOnlyStreak++;
                else break;
            }
            if (readOnlyStreak >= 6) {
                console.warn(`[ReActLoop] 📖 Read-Only Watchdog: ${readOnlyStreak} read-only tool calls подряд`);
                messages.push({
                    role: 'system' as any,
                    content: `⚠️ READ-ONLY WATCHDOG: Ты уже ${readOnlyStreak} раз подряд только ищешь данные (get_*, search_*). У тебя достаточно контекста. Переходи к ДЕЙСТВИЯМ (create_*, update_*, log_*) и затем дай ПОЛНЫЙ ОТВЕТ пользователю. Осталось ${maxIterations - iteration} итераций.`,
                } as any);
            }
        }

        // ─── Graceful Exit Warning ───
        // За 2 итерации до конца — предупреждаем модель, что пора завершать
        if (iteration === maxIterations - 1) {
            console.log(`[ReActLoop] ⏳ Graceful Exit: осталась 1 итерация, инъекция предупреждения`);
            messages.push({
                role: 'system' as any,
                content: `⚠️ ПОСЛЕДНЯЯ ИТЕРАЦИЯ: У тебя осталась ОДНА итерация. Заверши ВСЕ оставшиеся tool calls СЕЙЧАС. На следующей итерации ты ДОЛЖЕН дать ФИНАЛЬНЫЙ ТЕКСТОВЫЙ ОТВЕТ пользователю — полный, развёрнутый, ничего не пропуская.`,
            } as any);
        }

        // Продолжаем цикл → вызов LLM снова (с tool results)
        } catch (toolExecError: any) {
            // ── Graceful Recovery: tool execution упал, но loop НЕ должен падать ──
            console.error(`[ReActLoop] 🔴 КРИТИЧЕСКАЯ ОШИБКА tool execution (итерация ${iteration}):`, {
                error: toolExecError?.message || String(toolExecError),
                stack: toolExecError?.stack?.split('\n').slice(0, 5).join('\n'),
                toolNames: parsedToolCalls.map(tc => tc.name).join(', '),
                iteration,
                totalToolCalls: allToolCalls.length,
                phase,
            });

            // Логируем в tool_call_logs для видимости и диагностики
            logToolCall({
                toolName: '__tool_execution_crash__',
                input: { tools: parsedToolCalls.map(tc => tc.name), iteration },
                result: { error: `Tool execution crash: ${toolExecError?.message || String(toolExecError)}` },
                success: false,
                error: `Tool execution crash (iter ${iteration}): ${toolExecError?.message || String(toolExecError)}`,
                durationMs: 0,
                agentSlug: agentSlug || 'unknown',
                messageId,
                sessionId: context.sessionId,
                iteration,
                displayText: `🔴 CRASH: ${toolExecError?.message || 'unknown error'}`,
            }).catch(() => {});

            // Инжектируем error tool responses — API требует ответ на каждый tool_call_id,
            // а модель увидит ошибки и решит: повторить, использовать другой подход, или дать ответ
            // Используем unblockedToolCalls (не parsedToolCalls) — при частичной блокировке
            // заблокированные tools не в assistantMsg, их tool_call_id невалидны
            for (const tc of unblockedToolCalls) {
                messages.push({
                    role: 'tool' as any,
                    content: `Ошибка выполнения инструмента "${tc.name}": ${toolExecError?.message || 'внутренняя ошибка'}. Попробуй другой подход или сформулируй ответ без этого инструмента.`,
                    tool_call_id: tc.id,
                } as any);
            }
            // Loop продолжается → LLM получит ошибки и решит, что делать дальше
        }
    }

    // Превышено max iterations
    console.warn(`[ReActLoop] ⚠️ Превышено максимум итераций (${maxIterations}), tool calls: ${allToolCalls.length}`);

    // Последний вызов без tools — с увеличенным maxTokens для длинных ответов (NDA, договоры и т.д.)
    const overflowConfig = { ...aiConfig, maxTokens: Math.max(aiConfig.maxTokens, 8000) };
    const finalResult = await callWithFallback(overflowConfig, messages);
    totalTokens += finalResult.tokensUsed;

    return {
        content: finalResult.content || 'Извини, не удалось завершить обработку.',
        tokensUsed: totalTokens,
        toolCalls: allToolCalls,
        iterations: maxIterations,
        agentSlug,
        usedFallback: usedFallback || finalResult.usedFallback,
    };
}



// ============================================================================
// Single Tool Execution
// ============================================================================

async function executeSingleTool(
    parsedCall: ParsedToolCall,
    context: ToolExecutionContext,
    iteration: number,
    allowedToolNames?: Set<string>,
): Promise<ToolCallLog> {
    const startTime = Date.now();

    // Проверка allowlist: если tool не в разрешённом списке — блокируем
    if (allowedToolNames && allowedToolNames.size > 0 && !allowedToolNames.has(parsedCall.name)) {
        const durationMs = Date.now() - startTime;
        console.warn(`[ReActLoop] 🚫 Tool "${parsedCall.name}" заблокирован (не в allowlist)`);

        logToolCall({
            toolName: parsedCall.name,
            input: parsedCall.arguments,
            result: { error: `Tool "${parsedCall.name}" не разрешён для данного агента` },
            success: false,
            error: `Tool "${parsedCall.name}" не разрешён`,
            durationMs,
            agentSlug: context.agentSlug || 'unknown',
            messageId: context.messageId,
            sessionId: context.sessionId,
            iteration,
            displayText: `🚫 Tool "${parsedCall.name}" не доступен. Используй только разрешённые инструменты.`,
        }).catch((err: any) => console.error('[ReActLoop] Logging error:', err));

        return {
            toolName: parsedCall.name,
            input: parsedCall.arguments,
            result: {
                success: false,
                error: `Tool "${parsedCall.name}" не разрешён для данного агента`,
                displayText: `🚫 Tool "${parsedCall.name}" не доступен. Используй только разрешённые инструменты.`,
            },
            durationMs,
            iteration,
        };
    }

    const tool = toolRegistry.get(parsedCall.name);

    // Tool не найден в реестре
    if (!tool) {
        const durationMs = Date.now() - startTime;
        console.error(`[ReActLoop] ❌ Tool "${parsedCall.name}" не найден`);

        logToolCall({
            toolName: parsedCall.name,
            input: parsedCall.arguments,
            result: { error: `Tool "${parsedCall.name}" не зарегистрирован` },
            success: false,
            error: `Tool "${parsedCall.name}" не зарегистрирован`,
            durationMs,
            agentSlug: context.agentSlug || 'unknown',
            messageId: context.messageId,
            sessionId: context.sessionId,
            iteration,
            displayText: `Ошибка: tool "${parsedCall.name}" не найден.`,
        }).catch((err: any) => console.error('[ReActLoop] Logging error:', err));

        return {
            toolName: parsedCall.name,
            input: parsedCall.arguments,
            result: {
                success: false,
                error: `Tool "${parsedCall.name}" не зарегистрирован`,
                displayText: `Ошибка: tool "${parsedCall.name}" не найден.`,
            },
            durationMs,
            iteration,
        };
    }

    // Подготовка ToolCall для hooks
    const toolCall: ToolCall = {
        id: parsedCall.id,
        toolName: parsedCall.name,
        input: parsedCall.arguments,
        timestamp: new Date(),
    };

    // Run before-hooks
    const hooks = toolRegistry.getHooks();
    let finalInput = parsedCall.arguments;

    for (const hook of hooks) {
        if (hook.beforeExecute) {
            try {
                const hookResult: HookResult = await hook.beforeExecute(toolCall);
                if (hookResult.blocked) {
                    const durationMs = Date.now() - startTime;
                    console.warn(`[ReActLoop] 🚫 Tool "${parsedCall.name}" заблокирован hook "${hook.name}": ${hookResult.reason}`);

                    logToolCall({
                        toolName: parsedCall.name,
                        input: parsedCall.arguments,
                        result: { error: hookResult.reason },
                        success: false,
                        error: hookResult.reason || 'Заблокирован hook',
                        durationMs,
                        agentSlug: context.agentSlug || 'unknown',
                        messageId: context.messageId,
                        sessionId: context.sessionId,
                        iteration,
                        displayText: `Tool заблокирован: ${hookResult.reason || 'нет причины'}`,
                    }).catch((err: any) => console.error('[ReActLoop] Logging error:', err));

                    return {
                        toolName: parsedCall.name,
                        input: parsedCall.arguments,
                        result: {
                            success: false,
                            error: hookResult.reason || 'Заблокирован hook',
                            displayText: `Tool заблокирован: ${hookResult.reason || 'нет причины'}`,
                        },
                        durationMs,
                        iteration,
                    };
                }
                if (hookResult.modifiedInput) {
                    finalInput = hookResult.modifiedInput;
                }
            } catch (hookError) {
                console.error(`[ReActLoop] ❌ Ошибка hook "${hook.name}":`, hookError);
            }
        }
    }

    // Execute tool handler with timeout
    let result: ToolResult;
    const timeout = tool.timeout || DEFAULT_TOOL_TIMEOUT_MS;
    const execStartTime = Date.now();

    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(Object.assign(
                new Error(`Tool "${parsedCall.name}" timeout (${timeout}ms)`),
                { __isTimeout: true },
            )), timeout);
        });

        result = await Promise.race([
            tool.handler(finalInput as any, context),
            timeoutPromise,
        ]);
    } catch (error: any) {
        const execDurationMs = Date.now() - execStartTime;

        // ── Причинно-ориентированная классификация ошибок ──
        // Вместо одинакового "ошибка" — даём LLM диагностику:
        // - timeout: инструмент не ответил за {N}с — стоит ли повторить?
        // - network: проблема с сетью/соединением — повторить позже
        // - api_error: внешний API вернул ошибку (HTTP код) — может быть фатально
        // - internal: баг в коде инструмента — не повторять с теми же параметрами

        const isTimeout = error?.__isTimeout === true || error?.message?.includes('timeout');
        const isNetwork = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE']
            .some(code => error?.code === code || error?.cause?.code === code);
        const httpStatus = error?.status || error?.statusCode || null;
        const isApiError = !!httpStatus;

        let errorClass: string;
        let userHint: string;

        if (isTimeout) {
            errorClass = 'TIMEOUT';
            userHint = `Инструмент "${parsedCall.name}" не ответил за ${Math.round(timeout / 1000)}с. ` +
                `Возможные причины: сервис перегружен, длительная операция, или соединение потеряно. ` +
                `Ты можешь: (1) попробовать ещё раз — иногда это временная перегрузка, ` +
                `(2) попробовать альтернативный инструмент, ` +
                `(3) сформировать ответ из уже собранных данных.`;
        } else if (isNetwork) {
            errorClass = 'NETWORK';
            userHint = `Ошибка сети при вызове "${parsedCall.name}" (${error?.code || 'connection error'}). ` +
                `Внешний сервис может быть временно недоступен. ` +
                `НЕ повторяй этот вызов сразу — подожди или используй другой инструмент.`;
        } else if (isApiError) {
            const isRetryable = [429, 500, 502, 503].includes(httpStatus);
            errorClass = `API_${httpStatus}`;
            userHint = isRetryable
                ? `API вернул HTTP ${httpStatus} при вызове "${parsedCall.name}". ` +
                  `Это временная ошибка — можешь повторить через несколько секунд.`
                : `API вернул HTTP ${httpStatus} при вызове "${parsedCall.name}". ` +
                  `Это ошибка клиента (возможно, неверные параметры). ` +
                  `Проверь входные данные или используй другой подход.`;
        } else {
            errorClass = 'INTERNAL';
            userHint = `Внутренняя ошибка при выполнении "${parsedCall.name}": ${error?.message || error}. ` +
                `Попробуй другой подход или сформулируй ответ без этого инструмента.`;
        }

        console.error(`[ToolExec] ❌ ${errorClass} | ${parsedCall.name} | ${execDurationMs}ms | ${error?.message || error}`);

        result = {
            success: false,
            error: `[${errorClass}] ${error?.message || String(error)}`,
            displayText: userHint,
        };
    }

    // Run after-hooks
    for (const hook of hooks) {
        if (hook.afterExecute) {
            try {
                await hook.afterExecute(toolCall, result);
            } catch (hookError) {
                console.error(`[ReActLoop] ❌ Ошибка after-hook "${hook.name}":`, hookError);
            }
        }
    }

    const durationMs = Date.now() - startTime;

    logToolCall({
        toolName: parsedCall.name,
        input: finalInput,
        result: result,
        success: result.success,
        error: result.error,
        durationMs,
        agentSlug: context.agentSlug || 'unknown',
        messageId: context.messageId,
        sessionId: context.sessionId,
        iteration,
        displayText: result.displayText,
    }).catch((err: any) => console.error('[ReActLoop] Logging error:', err));

    return {
        toolName: parsedCall.name,
        input: finalInput,
        result,
        durationMs,
        iteration,
        toolCallId: parsedCall.id,
    };
}
