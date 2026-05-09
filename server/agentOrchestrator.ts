/**
 * Agent Orchestrator — Координатор Universal Agent
 * 
 * Управляет полным циклом обработки сообщения:
 * 1. Классификация интента (domain, intent, complexity)
 * 2. Adaptive Planning (для complexity: high)
 * 3. Сбор контекста памяти
 * 4. Сборка промпта (Prompt Assembler) или fallback на старых агентов
 * 5. Генерация ответа (ReAct Loop с tool calling)
 * 6. Post-processing и обновление сессии
 */

import { db } from "./db";
import { agents, type Agent, type ProcessingStep, type OrchestratorStepDef, ORCHESTRATOR_STEPS } from "@shared/schema";
import { hooks } from "./lifecycleHooks";
import { registerLifecycleHooks } from "./hookRegistrations";
import { eq } from "drizzle-orm";
import { buildContext, formatContextForPrompt, formatMessagesForPrompt, type RelevantContext, type ContextPreferences, type ContextOptions, DEFAULT_CONTEXT_PREFERENCES } from "./contextBuilder";
import * as intentClassifier from "./intentClassifier";
import type { ClassificationResult } from "./intentClassifier";

import { extractAndSaveKnowledgeRelations } from "./entityExtractor";
// factExtractor: extractAndSaveFacts переведён на lifecycle hooks (afterMessage)
import { extractProfileUpdatesFromMessage } from "./profileManager";
import { getPreferencesContext, extractPreferencesFromMessage, decayStalePreferences } from "./preferencesManager";
import { WorkflowLogger } from "./services/workflowLogger";
import { saveDocument } from "./documentManager";
// selfReflection: analyzeConversation переведён на lifecycle hooks (afterMessage)
import { planContextQueries, getDataSourcesSummary, type QueryPlan } from "./queryPlanner";
import { executeQueryPlan, type EnrichedContextData } from "./contextEnricher";
import { runReflectionLoop } from "./contextReflector";
import { parseCompetitorData, upsertCompetitor } from "./competitorRegistry";
import { parseMetricsData, saveMetricSnapshot } from "./metricsTracker";
import { initializeBuiltinSkills, resolveSkillsForMessage, formatSkillsForPrompt } from "./skillManager";
import type { DataClassification } from "@shared/schema";
import { initializeBuiltinTools, executeReActLoop, resolveToolsForRequest, resolveToolsByPacks } from "./tools";
import { getExpertiseByDomain, getExpertiseBySlug, initializeExpertises } from "./expertiseRegistry";
import { assemblePrompt } from "./promptAssembler";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { mcpClientService } from "./services/mcpClientService";
import path from 'path';
import { fileURLToPath } from 'url';
import { logToolCall } from './lib/logger';
// sessionCompactor: shouldCompact/applyCompaction переведены на lifecycle hooks (afterMessage)
import { getLastCompaction } from './sessionCompactor';

/** Timestamp последнего запуска decay предпочтений (раз в сутки) */
let lastDecayRun: Date | null = null;

// ── Логирование результатов фоновых задач ──
// Promise.allSettled не теряет ошибки, но без логирования в БД
// мы узнаём о систематических падениях только из PM2 логов (теряются при ротации).

/** Названия background tasks по индексу в массиве postProcessingTasks */
const BACKGROUND_TASK_NAMES = [
    'knowledge_relations',
    'fact_extraction',
    'profile_update',
    'preference_extraction',
    'preference_decay',
    'data_ingestion',
];

/**
 * Логирование rejected фоновых задач в tool_call_logs для видимости.
 * Вызывается после Promise.allSettled.
 */
function logSettledResults(
    results: PromiseSettledResult<any>[],
    context: { source: string; sessionId?: string; messageId?: number },
    taskNames?: string[],
): void {
    const names = taskNames || BACKGROUND_TASK_NAMES;
    const rejected = results
        .map((r, i) => ({ ...r, index: i, name: names[i] || `task_${i}` }))
        .filter((r): r is PromiseRejectedResult & { index: number; name: string } => r.status === 'rejected');

    if (rejected.length === 0) return;

    console.error(
        `[${context.source}] ⚠️ ${rejected.length}/${results.length} фоновых задач упали:`,
        rejected.map(r => `${r.name}: ${r.reason?.message || String(r.reason)}`).join('; ')
    );

    // Логируем каждую ошибку в tool_call_logs для персистентной видимости
    for (const r of rejected) {
        logToolCall({
            toolName: '__background_task_failure__',
            input: { taskName: r.name, source: context.source },
            result: { error: r.reason?.message || String(r.reason) },
            success: false,
            error: `[${context.source}] ${r.name}: ${r.reason?.message || String(r.reason)}`,
            durationMs: 0,
            agentSlug: context.source,
            messageId: context.messageId,
            sessionId: context.sessionId,
            iteration: 0,
            displayText: `🔴 Background task "${r.name}" failed: ${r.reason?.message || 'unknown error'}`,
        }).catch(() => {}); // fire-and-forget
    }
}

// ============================================================================
// Processing Timeline — Типы и хелперы для визуализации
// ============================================================================

/**
 * Тип callback-функции для отправки шагов через WebSocket
 */
export type BroadcastStepFn = (step: ProcessingStep) => void;

/**
 * Создаёт объект шага обработки
 */
function createStep(
    messageId: number,
    stepDef: OrchestratorStepDef,
    status: ProcessingStep['status'],
    output?: ProcessingStep['output'],
    duration?: number,
    error?: string
): ProcessingStep {
    return {
        type: 'processing_step',
        messageId,
        stepId: stepDef.id,
        stepName: stepDef.name,
        stepIcon: stepDef.icon,
        status,
        duration,
        output,
        error,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Обёртка для измерения времени выполнения шага с отправкой событий и логированием.
 * Поддерживает per-step timeout для предотвращения зависания отдельных шагов.
 */
async function timeStep<T>(
    messageId: number,
    stepDef: OrchestratorStepDef,
    fn: () => Promise<T>,
    summaryFn: (result: T) => ProcessingStep['output'],
    broadcastStep?: BroadcastStepFn,
    workflowLogger?: WorkflowLogger,
    input?: Record<string, any>,
    stepTimeoutMs?: number  // Per-step timeout (по умолчанию 120с)
): Promise<T> {
    const timeout = stepTimeoutMs ?? 120_000; // 120с по умолчанию

    // Отправляем событие "running"
    const runningStep = createStep(messageId, stepDef, 'running');
    broadcastStep?.(runningStep);
    workflowLogger?.logStep(runningStep, input);

    const start = Date.now();
    try {
        // Per-step timeout через Promise.race
        const result = await Promise.race([
            fn(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(
                    new Error(`⏱️ Step timeout: ${stepDef.name} превысил ${timeout / 1000}с`)
                ), timeout)
            ),
        ]);
        const duration = Date.now() - start;

        // Отправляем событие "completed" с результатом
        const completedStep = createStep(messageId, stepDef, 'completed', summaryFn(result), duration);
        broadcastStep?.(completedStep);
        workflowLogger?.logStep(completedStep, input);
        return result;
    } catch (error) {
        const duration = Date.now() - start;
        const isTimeout = String(error).includes('Step timeout');

        // Отправляем событие "error" (или "timeout")
        const errorStep = createStep(
            messageId, stepDef,
            isTimeout ? 'error' : 'error',
            isTimeout ? { summary: `Timeout: ${stepDef.name} (${Math.round(duration / 1000)}с)` } : undefined,
            duration,
            String(error)
        );
        broadcastStep?.(errorStep);
        workflowLogger?.logStep(errorStep, input);
        throw error;
    }
}

/**
 * Очистка ответа агента от внутренних артефактов мышления,
 * дублирования заголовков или "статусных" сообщений.
 * Предотвращает утечку "сырых" мыслей модели пользователю.
 */
export function cleanAgentResponse(content: string): string {
    if (!content) return content;

    let cleaned = content.trim();

    // 1. Убираем "статусные" префиксы и временные метки (могут попадать из имитации истории)
    // Пример: [27.03.2026, 03:49] **Сначала — поиск данных. Потом — директива.**
    cleaned = cleaned.replace(/^\[\d{2}\.\d{2}\.\d{4}.*?\].*?\*\*.*?\*\*[\s\n]*/gi, '');
    
    // 2. Убираем фразы-заполнители ("статусы" выполнения), если они остались в начале ответа
    const statusPatterns = [
        /^[ \t]*Ищу актуальную информацию.*?(секунд|минут).*?\.?[\s\n]*/gi,
        /^[ \t]*Сейчас (я\s*)?(найду|поищу|проверю).*?(секунд|минут).*?\.?[\s\n]*/gi,
        /^[ \t]*Сначала — поиск данных.*?\.?[\s\n]*/gi,
        /^[ \t]*Подождите.*?\.?[\s\n]*/gi,
        /^[ \t]*Это займёт (\d+ |несколько )?(секунд|минут).*?\.?[\s\n]*/gi,
    ];

    for (const pattern of statusPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }

    // 3. Убираем теги <thinking> (иногда модели их не закрывают или оставляют)
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>[\s\n]*/gi, '');
    cleaned = cleaned.replace(/<thinking>[\s\S]*$/gi, ''); // Незакрытый тег

    // 4. Убираем технические повторы инструкций промпта (эхо)
    cleaned = cleaned.replace(/^## ИНСТРУКЦИЯ ОТВЕТА[\s\S]*?(\n\n|$)/gi, '');

    // 5. Убираем префиксы ролей, если модель начала имитировать диалог
    const rolePrefixes = [
        /^(Ассистент|Помощник|AI|Assistant|Response|Ответ|Результат):[ \t]*/i,
        /^(System|Система):[ \t]*/i,
    ];
    for (const prefix of rolePrefixes) {
        cleaned = cleaned.replace(prefix, '');
    }

    return cleaned.trim();
}



/**
 * Результат обработки сообщения оркестратором
 */
export interface OrchestratorResult {
    response: string;
    agentUsed: string;
    agentName: string;
    classificationResult: ClassificationResult;
    factsExtracted: number;
    tokensUsed: number;
    insightsShown: number;  // Количество показанных проактивных insights
    remindersCreated: number;  // Количество созданных напоминаний
    isDataOnly?: boolean;  // true = данные без вопроса, только сохранение (без ответа агента)
    toolCalls?: Array<{ toolName: string; success: boolean; durationMs: number }>;
}



/**
 * Инициализация агентов в БД (если их нет)
 */
export async function initializeAgents(): Promise<void> {

    // Инициализация встроенных навыков
    await initializeBuiltinSkills();

    // Инициализация Tool System
    initializeBuiltinTools();

    // Инициализация экспертиз (Universal Agent)
    await initializeExpertises();

    // Инициализация Lifecycle Hooks
    registerLifecycleHooks();

    // Инициализация MCP серверов
    await initializeMCPServers();
}

/**
 * Инициализация подключений к MCP серверам
 */

/** Сохранённая конфигурация для позднего реконнекта */
let calendarMCPConfig: import('./services/mcpClientService').MCPServerConfig | null = null;

export function getCalendarMCPConfig() { return calendarMCPConfig; }

async function initializeMCPServers(): Promise<void> {
    // Google Calendar MCP Server
    const calendarEnabled = process.env.MCP_GOOGLE_CALENDAR_ENABLED === 'true';
    if (calendarEnabled) {
        try {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const isDev = process.env.NODE_ENV === 'development';

            // В dev: tsx запускает .ts файл
            // В production: node запускает скомпилированный .js из dist/
            const command = isDev ? 'npx' : 'node';
            const serverPath = isDev
                ? path.resolve(__dirname, 'mcp/googleCalendarServer.ts')
                : path.resolve(__dirname, 'googleCalendarServer.js');
            const args = isDev ? ['tsx', serverPath] : [serverPath];

            calendarMCPConfig = {
                name: 'google-calendar',
                command,
                args,
                enabled: true,
            };

            await mcpClientService.connect(calendarMCPConfig);
        } catch (error: any) {
            console.error('[MCP] ⚠️ Google Calendar MCP не запущен:', error?.message || error);
            console.error('[MCP] 💡 Для настройки: npx tsx server/mcp/googleCalendarAuth.ts');
        }
    } else {
        console.log('[MCP] ⏭️ Google Calendar отключён (MCP_GOOGLE_CALENDAR_ENABLED != true)');
    }
}

/**
 * Получение имени агента по slug
 */
async function getAgentName(slug: string): Promise<string> {
    const agent = await db.select()
        .from(agents)
        .where(eq(agents.slug, slug))
        .limit(1);

    return agent[0]?.name || slug;
}

// ============================================================================
// Data Ingestion — Сохранение структурированных данных
// ============================================================================

interface DataIngestionResult {
    type: string;
    summary: string;
    details?: Record<string, any>;
}

/**
 * Обработка Data Ingestion — параллельное сохранение данных по всем типам
 * 
 * Вместо выбора одного типа (switch/case) — параллельно:
 * 1. Специализированный парсинг (метрики ИЛИ конкуренты)
 * 2. ВСЕГДА сохраняем полный текст как документ
 * 
 * Это гарантирует, что аналитический отчёт с метриками сохранит и числа,
 * и все таблицы, когорты, выводы — как цельный документ.
 */
async function processDataIngestion(
    userMessage: string,
    classification: DataClassification,
    sourceMessageId: number
): Promise<DataIngestionResult | null> {
    try {
        console.log(`[DataIngestion] 📥 Тип: ${classification.dataType}, confidence: ${classification.confidence}`);

        const summaries: string[] = [];
        const allDetails: Record<string, any> = {};

        // 1. Специализированный парсинг по типу (параллельно с документом)
        const specializedTask = (async (): Promise<void> => {
            try {
                if (classification.dataType === 'competitor_info') {
                    const parsed = await parseCompetitorData(userMessage);
                    if (parsed) {
                        const result = await upsertCompetitor(parsed, undefined);
                        summaries.push(`${result.isNew ? 'Создан' : 'Обновлён'} конкурент "${result.competitorName}" (${result.attributesCount} атр.)`);
                        allDetails.competitor = result;
                    }
                } else if (classification.dataType === 'financial_metrics') {
                    const parsed = await parseMetricsData(userMessage);
                    if (parsed) {
                        const result = await saveMetricSnapshot(parsed, userMessage, sourceMessageId);
                        summaries.push(`Метрики за ${result.period} (${result.metricsCount} показателей)`);
                        allDetails.metrics = result;
                    }
                }
            } catch (error) {
                console.error(`[DataIngestion] ⚠️ Ошибка специализированного парсинга (${classification.dataType}):`, error);
            }
        })();

        // 2. Сохраняем как документ ТОЛЬКО для специализированных типов (метрики, конкуренты)
        // Для dataType='document' — НЕ auto-save; создание документов — ответственность AI-агента
        const documentTask = (async (): Promise<void> => {
            if (classification.dataType === 'document') {
                console.log('[DataIngestion] ⏭️ dataType=document — пропускаем auto-save (дело AI-агента)');
                return;
            }
            try {
                const documentType = classification.dataType === 'financial_metrics' ? 'financial_report'
                    : classification.dataType === 'competitor_info' ? 'competitor_analysis'
                        : 'general';

                const result = await saveDocument({
                    content: userMessage,
                    documentType,
                    sourceMessageId,
                });
                summaries.push(`Документ "${result.title}"`);
                allDetails.document = result;
            } catch (error) {
                console.error('[DataIngestion] ⚠️ Ошибка сохранения документа:', error);
            }
        })();

        // 3. Ждём оба результата
        await Promise.allSettled([specializedTask, documentTask]);

        if (summaries.length === 0) {
            return null;
        }

        // Формируем тип для отображения
        const type = classification.dataType === 'financial_metrics' ? 'Метрики + Документ'
            : classification.dataType === 'competitor_info' ? 'Конкурент + Документ'
                : 'Документ';

        return {
            type,
            summary: summaries.join(' | '),
            details: allDetails,
        };
    } catch (error) {
        console.error('[DataIngestion] ❌ Ошибка:', error);
        return null;
    }
}

/**
 * Главная функция обработки сообщения
 */
// Глобальный таймаут на обработку сообщения (10 минут — защита от полного зависания)
// Должен быть больше суммы per-step таймаутов: reflection (180с) + response (420с) = 600с.
// Остальные шаги (routing, context, queryPlanning, contextEnrich) обычно завершаются за 2-10с.
const PROCESS_MESSAGE_TIMEOUT_MS = 600_000;

export async function processMessage(
    userMessage: string,
    sessionId: string,
    sourceMessageId?: number,
    broadcastStep?: BroadcastStepFn
): Promise<OrchestratorResult> {
    const messageId = sourceMessageId || 0;

    console.log(`\n🎯 Orchestrator: обработка сообщения`);
    console.log(`Session: ${sessionId}`);
    console.log(`Message: "${userMessage.substring(0, 100)}..."`);

    // 0. Создаём логгер workflow (только если есть messageId)
    const workflowLogger = messageId ? new WorkflowLogger(messageId) : undefined;
    if (workflowLogger) {
        await workflowLogger.start();
    }

    // AbortController для отмены фоновых операций при таймауте
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Глобальный timeout — защита от зависания всего pipeline
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            abortController.abort(); // Сигнал отмены для дочерних операций
            reject(new Error(`⏱️ processMessage timeout: обработка превысила ${PROCESS_MESSAGE_TIMEOUT_MS / 1000}с`));
        }, PROCESS_MESSAGE_TIMEOUT_MS);
    });

    try {
        const result = await Promise.race([
            timeoutPromise,
            processMessageInternal(userMessage, sessionId, messageId, broadcastStep, workflowLogger),
        ]);
        // Очищаем таймер при успешном завершении
        if (timeoutId) clearTimeout(timeoutId);
        return result;
    } catch (error) {
        // Очищаем таймер
        if (timeoutId) clearTimeout(timeoutId);
        // Глобальный обработчик (включая timeout)
        console.error(`❌ processMessage failed:`, error);
        if (workflowLogger) {
            await workflowLogger.error(String(error));
        }
        throw error;
    }
}

/**
 * ⚡ Быстрый путь для данных без вопроса
 * 
 * Когда маршрутизатор определил hasStructuredData=true и hasQuestion=false,
 * пропускаем Query Planning, Insights, Reminders, Agent Response.
 * Выполняем только: Data Ingestion + Facts + Knowledge Relations.
 */
async function processDataOnlyMessage(
    userMessage: string,
    messageId: number,
    sessionId: string,
    classification: ClassificationResult,
    broadcastStep?: BroadcastStepFn,
    workflowLogger?: WorkflowLogger,
): Promise<OrchestratorResult> {
    const dataClass = classification.dataClassification;

    // 1. Data Ingestion — сохранение структурированных данных
    const dataIngestionResult = await timeStep(
        messageId,
        { id: 'dataIngestion', name: 'Сохранение данных', icon: '📥' },
        () => processDataIngestion(userMessage, dataClass, messageId),
        (result) => ({
            summary: result
                ? `✅ ${result.type}: ${result.summary}`
                : 'Данные не сохранены',
            data: result || { статус: 'Не удалось классифицировать данные' }
        }),
        broadcastStep,
        workflowLogger
    );

    // 2. Post-processing: Knowledge Relations (прямой вызов) + Fact Extraction (через hooks)
    // Fire-and-forget — не блокируем ответ
    Promise.allSettled([
        extractAndSaveKnowledgeRelations(userMessage, messageId)
            .then(result => {
                if (result.relationsCreated > 0) {
                    console.log(`🧠 [DataOnly] KG: ${result.relationsCreated} знаний извлечено`);
                }
            }),

        // Фоновое обновление профиля
        extractProfileUpdatesFromMessage(userMessage)
            .then(result => {
                if (result.count > 0) {
                    console.log(`👤 [DataOnly] Profile updates: ${result.count} записей обновлено`);
                }
            }),
    ]).then(results => logSettledResults(
        results,
        { source: 'DataOnly', sessionId, messageId },
        ['knowledge_relations', 'profile_update'],
    ));

    // 🪝 Lifecycle Hooks: afterMessage — fact extraction (через hooks, не прямым вызовом)
    hooks.emitFireAndForget('afterMessage', {
        userMessage,
        agentResponse: '',  // data-only path — нет ответа агента
        sessionId,
        messageId,
        agentSlug: classification.domain,
        tokensUsed: 0,
    });

    // 3. Обновляем контекст сессии
    await intentClassifier.updateSessionContext(sessionId, {
        activeAgentSlug: classification.domain,
        currentTopics: JSON.stringify(classification.detectedTopics),
    });

    // 4. Формируем системное подтверждение
    const dataTypeLabels: Record<string, string> = {
        'competitor_info': '📊 Информация о конкуренте',
        'financial_metrics': '📈 Финансовые метрики',
        'document': '📄 Документ',
    };
    const typeLabel = dataTypeLabels[dataClass.dataType] || '📥 Данные';

    let response: string;
    if (dataIngestionResult) {
        response = `${typeLabel}: ${dataIngestionResult.summary}`;
    } else {
        response = `⚠️ Не удалось сохранить данные типа "${dataClass.dataType}". Попробуйте отправить повторно.`;
    }

    console.log(`⚡ Data-only complete: ${response.substring(0, 100)}`);

    // 5. Завершаем логирование workflow
    if (workflowLogger) {
        await workflowLogger.complete({
            agentUsed: 'data-ingestion',
            tokensUsed: 0,
            factsCount: 0,
            contextSummary: {
                factsInContext: 0,
                messagesInHistory: 0,
                profileLoaded: false,
            }
        });
    }

    const agentName = await getAgentName(classification.domain);

    return {
        response,
        agentUsed: 'data-ingestion',
        agentName,
        classificationResult: classification,
        factsExtracted: 0,
        tokensUsed: 0,
        insightsShown: 0,
        remindersCreated: 0,
        isDataOnly: true,
    };
}

async function processMessageInternal(
    userMessage: string,
    sessionId: string,
    messageId: number,
    broadcastStep?: BroadcastStepFn,
    workflowLogger?: WorkflowLogger,
): Promise<OrchestratorResult> {
    try {
        // 1. Получаем контекст сессии
        const sessionCtx = await intentClassifier.getOrCreateSessionContext(sessionId);

        // 2. Классификация интента (заменяет маршрутизацию)
        const classification = await timeStep(
            messageId,
            ORCHESTRATOR_STEPS.routing,
            () => intentClassifier.classifyIntent(userMessage, sessionCtx),
            (r) => ({
                summary: `${r.domain}/${r.intent} (${r.complexity}) — ${r.expertiseSlugs.join(',')} (${Math.round(r.confidence * 100)}%)${r.dataClassification?.hasStructuredData ? ` | Данные: ${r.dataClassification.dataType}` : ''}${!r.hasQuestion ? ' | Без вопроса' : ''}`,
                data: {
                    классификация: {
                        домен: r.domain,
                        интент: r.intent,
                        сложность: r.complexity,
                        экспертизы: r.expertiseSlugs,
                        уверенность: `${Math.round(r.confidence * 100)}%`,
                    },
                    обоснование: r.reasoning,
                    темы: r.detectedTopics.length > 0
                        ? r.detectedTopics
                        : ['Общий разговор'],
                    содержит_вопрос: r.hasQuestion,
                    tool_packs: r.toolPacks,
                    данные: r.dataClassification?.hasStructuredData
                        ? { тип: r.dataClassification.dataType, уверенность: r.dataClassification.confidence }
                        : 'нет',
                }
            }),
            broadcastStep,
            workflowLogger,
            { userMessage, sessionContext: sessionCtx }
        );
        console.log(`🎯 Intent: ${classification.domain}/${classification.intent} (complexity: ${classification.complexity}, expertise: ${classification.expertiseSlugs.join(',')}, confidence: ${classification.confidence})`);
        console.log(`📊 Data classification: ${classification.dataClassification?.dataType || 'none'} (hasQuestion: ${classification.hasQuestion})`);

        // ⚡ БЫСТРЫЙ ПУТЬ: данные без вопроса → только сохранение, без Query Planning и ответа агента
        // ТОЛЬКО для competitor_info и financial_metrics — они имеют чёткую структуру.
        // dataType='document' ВСЕГДА проходит через агента — AI сам решает, нужно ли сохранять.
        // Guard: длинные сообщения (>300 символов) — вероятные аудио-транскрипты, направляем в обычный pipeline
        const dataType = classification.dataClassification?.dataType;
        const isAutoIngestible = dataType === 'competitor_info' || dataType === 'financial_metrics';
        const isLikelyTranscript = userMessage.length > 300; // длинные сообщения — вероятно аудио-транскрипты
        if (classification.dataClassification?.hasStructuredData && !classification.hasQuestion && isAutoIngestible && !isLikelyTranscript) {
            console.log(`⚡ Data-only path (${dataType}): пропускаем Query Planning, Insights, Agent Response`);
            return await processDataOnlyMessage(
                userMessage, messageId, sessionId,
                classification, broadcastStep, workflowLogger
            );
        }
        if (isAutoIngestible && isLikelyTranscript) {
            console.log(`🛡️ Data-only path ЗАБЛОКИРОВАН: сообщение слишком длинное (${userMessage.length} символов), вероятный аудио-транскрипт → обычный pipeline`);
        }

        // 2b. Adaptive Planning — для complexity: high генерируем план
        if (classification.complexity === 'high') {
            try {
                classification.plan = await timeStep(
                    messageId,
                    ORCHESTRATOR_STEPS.planning,
                    () => intentClassifier.generatePlan(userMessage, classification),
                    (plan) => ({
                        summary: plan ? `План: ${plan.substring(0, 100)}...` : 'План не сгенерирован',
                        data: { план: plan || 'Не удалось сгенерировать' }
                    }),
                    broadcastStep,
                    workflowLogger
                );
            } catch (error) {
                console.error('⚠️ Adaptive Planning error (продолжаем без плана):', error);
            }
        }
        // 2c. Expertise Resolution — определяем ПЕРЕД сбором контекста, чтобы использовать contextPreferences
        const expertise = classification.expertiseSlugs.length > 0
            ? await getExpertiseBySlug(classification.expertiseSlugs[0])
            : await getExpertiseByDomain(classification.domain);

        // 3. Adaptive контекст — история + профиль + selective data (goals/metrics/competitors по expertise)
        const contextPrefs: ContextPreferences = expertise
            ? { ...DEFAULT_CONTEXT_PREFERENCES, ...(expertise.contextPreferences as Partial<ContextPreferences>) }
            : DEFAULT_CONTEXT_PREFERENCES;

        // ⚡ Quick Path Logic: расширенный быстрый путь
        // Помимо явных распоряжений (isAction), включает простые информационные запросы
        // и другие однокомандные интенты при низкой сложности.
        const QUICK_INTENTS = [
            'manage_calendar', 'manage_notes', 'set_reminder', 'remember', // Действия
            'search', 'quick_lookup', 'daily_overview',                     // Простой поиск / обзор
            'chat',                                                          // Приветствие, small talk
        ];
        const isFastPath = classification.complexity === 'low' && (
            classification.isAction ||                                       // Явные распоряжения
            QUICK_INTENTS.includes(classification.intent)                     // Whitelist простых интентов
        );
        
        // ⚡ Адаптивная загрузка контекста для Fast Path
        // Если классификатор определил, что нужен контекст (упоминания "тот", "это", etc),
        // загружаем больше истории (15 вместо 5) и глубже ищем в памяти.
        const contextOptions: ContextOptions = isFastPath 
            ? { recentMessagesLimit: classification.needsContext ? 15 : 5 }
            : {};

        // Если нужен контекст, повышаем глубину поиска фактов
        if (isFastPath && classification.needsContext) {
            contextPrefs.factSearchDepth = 'deep';
            contextPrefs.maxFacts = 10;
        }

        let memoryContext: RelevantContext;
        memoryContext = await timeStep(
            messageId,
            ORCHESTRATOR_STEPS.context,
            () => buildContext(userMessage, contextPrefs, contextOptions),
            (ctx) => ({
                summary: `${ctx.recentMessages.length} сообщений, ${ctx.relevantFacts?.length || 0} фактов, ${ctx.goalsContext?.goals?.length || 0} целей`,
                data: {
                    mode: 'Adaptive Context (expertise-driven)',
                    авто_факты: ctx.relevantFacts?.length > 0
                        ? ctx.relevantFacts.map((f: any) => `[${f.confidence}] ${f.content}`)
                        : 'Новых фактов не найдено',
                    последние_сообщения: ctx.recentMessages.length > 0
                        ? ctx.recentMessages.slice(-5).map((m: any) => ({
                            отправитель: m.sender === 'user' ? '👤 Вы' : '🤖 Ассистент',
                            текст: m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content,
                        }))
                        : 'История сообщений пуста',
                    профиль: ctx.userProfile
                        ? (typeof ctx.userProfile === 'string' && ctx.userProfile.length > 0 ? '✅ Загружен' : 'Профиль не настроен')
                        : 'Профиль не загружен',
                    цели: ctx.goalsContext?.goals && ctx.goalsContext.goals.length > 0
                        ? ctx.goalsContext.goals.map((g: any) => g.title)
                        : 'Целей нет'
                }
            }),
            broadcastStep,
            workflowLogger
        );

        // Inject session context for tools
        memoryContext.sessionId = sessionId;
        memoryContext.messageId = messageId;
        // Обёртка broadcastStep: шлёт через WebSocket + логирует в workflowLogger (для persistence)
        memoryContext.broadcastStep = (step: ProcessingStep) => {
            broadcastStep?.(step);
            workflowLogger?.logStep(step);
        };

        // 3b. Skill Resolution — Progressive Disclosure (Level 1: каталог, Level 2: triggered)
        try {
            const skillResult = await resolveSkillsForMessage(userMessage);
            if (skillResult.catalog.length > 0) {
                memoryContext.skillsContext = formatSkillsForPrompt(skillResult);
                console.log(`🧩 Skills: ${skillResult.triggered.length} triggered из ${skillResult.catalog.length} доступных${skillResult.triggered.length > 0 ? ': ' + skillResult.triggered.map(s => s.name).join(', ') : ''}`);
            }
        } catch (error) {
            console.error('❗ Ошибка skill resolution:', error);
        }

        // 3c. Preferences — загрузка предпочтений пользователя
        try {
            const prefsCtx = await getPreferencesContext();
            if (prefsCtx) {
                memoryContext.preferencesContext = prefsCtx;
                console.log(`⚙️ Preferences: загружены для промпта`);
            }
        } catch (error) {
            console.error('❗ Ошибка загрузки предпочтений:', error);
        }

        console.log(`📚 Smart Context: ${memoryContext.recentMessages.length} msgs, ${memoryContext.relevantFacts?.length || 0} auto-facts, ${memoryContext.goalsContext?.goals?.length || 0} goals`);

        // ⚡ FAST PATH ACTIVATION
        if (isFastPath) {
            console.log(`⚡ Fast Path: пропускаем Query Planning и Reflection для простого распоряжения`);
            // Помечаем в контексте, что это быстрый путь (для логгера и промптера)
            memoryContext._isFastPath = true;
            
            // Сообщаем UI, что активирован быстрый путь
            broadcastStep?.({
                type: 'processing_step',
                messageId,
                stepId: 'fast_path_executor',
                stepName: 'Быстрое выполнение',
                stepIcon: '⚡',
                status: 'completed',
                timestamp: new Date().toISOString(),
                output: { summary: 'Активирован ускоренный режим выполнения (без расширенного контекста)' }
            });
        }

        // 3c. Think-First — AI Query Planner определяет, какие ещё данные загрузить
        let queryPlan: QueryPlan | null = null;
        if (!isFastPath) {
            try {
                queryPlan = await timeStep(
                    messageId,
                    ORCHESTRATOR_STEPS.queryPlanning,
                    async () => {
                        const dataSources = await getDataSourcesSummary();
                        return planContextQueries(userMessage, dataSources);
                    },
                    (plan) => ({
                        summary: `${plan.queries.length} запросов, profile=${plan.loadProfile}, goals=${plan.loadGoals}`,
                        data: {
                            reasoning: plan.reasoning || 'Нет обоснования',
                            queries: plan.queries.map(q => `"${q.query}" (${q.priority})`),
                            loadProfile: plan.loadProfile,
                            loadGoals: plan.loadGoals,
                        }
                    }),
                    broadcastStep,
                    workflowLogger
                );
            } catch (error) {
                console.error('⚠️ Query Planner error (продолжаем без обогащения):', error);
            }
        }

        // 3d. Context Enrichment — выполняем план и обогащаем контекст
        if (queryPlan && queryPlan.queries.length > 0) {
            try {
                const enrichedData = await timeStep(
                    messageId,
                    ORCHESTRATOR_STEPS.contextEnrich,
                    () => executeQueryPlan(queryPlan!),
                    (data) => ({
                        summary: `+${data.facts.length} фактов из ${data.queryStats.totalQueries} запросов`,
                        data: {
                            новых_фактов: data.facts.length,
                            всего_запросов: data.queryStats.totalQueries,
                            до_дедупликации: data.queryStats.totalFactsBeforeDedup,
                            после_дедупликации: data.queryStats.totalFactsAfterDedup,
                            по_запросам: data.queryStats.factsFoundByQuery,
                            найденные_факты: data.facts.slice(0, 10).map((f: any) => f.content?.substring(0, 100) || '(пусто)'),
                        }
                    }),
                    broadcastStep,
                    workflowLogger,
                    undefined,
                    90_000 // 90с — embedding (30с каждый) + DB поиск по нескольким запросам
                );

                // Merge enriched facts with auto-found facts (deduplicate by ID)
                const existingIds = new Set((memoryContext.relevantFacts || []).map(f => f.id));
                const newFacts = enrichedData.facts.filter(f => !existingIds.has(f.id));
                memoryContext.relevantFacts = [...(memoryContext.relevantFacts || []), ...newFacts];

                // Merge goals if Query Planner requested them
                if (enrichedData.goals.length > 0 && memoryContext.goalsContext) {
                    const existingGoalIds = new Set(memoryContext.goalsContext.goals.map(g => g.id));
                    const newGoals = enrichedData.goals.filter(g => !existingGoalIds.has(g.id));
                    memoryContext.goalsContext.goals = [...memoryContext.goalsContext.goals, ...newGoals];
                    memoryContext.goalsContext.summary = `${memoryContext.goalsContext.goals.length} целей (enriched)`;
                }

                console.log(`✨ Context Enriched: +${newFacts.length} new facts (total: ${memoryContext.relevantFacts?.length || 0})`);
            } catch (error) {
                console.error('⚠️ Context Enrichment error (продолжаем с базовым контекстом):', error);
            }
        }

        // 3e. Reflective Context Loop — "Подумай перед ответом"
        // Агент анализирует собранный контекст и при необходимости дозапрашивает данные
        if (!isFastPath) {
            try {
                memoryContext = await timeStep(
                    messageId,
                    ORCHESTRATOR_STEPS.reflection,
                    () => runReflectionLoop(
                        userMessage,
                        memoryContext,
                        classification.domain,
                        sessionId,
                        messageId,
                        broadcastStep
                    ),
                    (ctx) => {
                        const meta = (ctx as any)._reflectionMeta;
                        return {
                            summary: meta?.toolCalls > 0
                                ? `${meta.iterations} итер., ${meta.toolCalls} tool calls (${meta.tools.join(', ')})`
                                : 'Контекст достаточен, доп. данные не потребовались',
                            data: {
                                итерации: meta?.iterations || 0,
                                вызовов_tools: meta?.toolCalls || 0,
                                инструменты: meta?.tools || [],
                                превью_данных: meta?.preview || 'Нет данных',
                            }
                        };
                    },
                    broadcastStep,
                    workflowLogger,
                    undefined,
                    180_000 // 180с — рефлексия включает до 3 итераций × 5 AI-вызовов
                );
            } catch (error) {
                console.error('⚠️ Reflection loop error (продолжаем):', error);
            }
        }

        // 4. Agent Response — Expertise-based ИЛИ legacy agent
        // Приоритет: экспертиза из classifier → старые агенты → fallback на business


        const agentResponse = await timeStep(
            messageId,
            ORCHESTRATOR_STEPS.response,
            async () => {
                // ═══ Новый путь: Expertise + Prompt Assembler ═══
                if (expertise) {
                    console.log(`🧠 Universal Agent: используем экспертизу "${expertise.name}" (${expertise.slug})`);

                    const aiConfig = await getAIClientForTask('agent_core');

                    // Model Cascade: финальная модель (если настроена)
                    let finalAnswerAiConfig: typeof aiConfig | undefined;
                    try {
                        const finalConfig = await getAIClientForTask('agent_final_answer');
                        if (finalConfig.model !== aiConfig.model) {
                            finalAnswerAiConfig = finalConfig;
                        }
                    } catch (e) { /* agent_final_answer не настроен */ }

                    // Prompt Assembler: 5 слоёв + plan (для high complexity)
                    // Prompt Assembler: 5 слоёв + plan (разбито на сообщения для кеширования)
                    const systemMessages = assemblePrompt({
                        expertise,
                        context: memoryContext,
                        dbPersonaPrompt: aiConfig.systemPrompt ?? undefined,
                        skillsContext: memoryContext.skillsContext ?? undefined,
                        preferencesContext: memoryContext.preferencesContext ?? undefined,
                        plan: classification.plan,
                        contextWindow: aiConfig.contextWindow,
                        modelName: aiConfig.model,
                        isFastPath,
                    });

                    // Формируем историю
                    const lastMessage = memoryContext.recentMessages[memoryContext.recentMessages.length - 1];
                    const isImageMessage = lastMessage?.type === 'image' && lastMessage?.fileUrl;

                    // 🗜️ Session Compaction: загружаем резюме сжатой части диалога
                    let compactionSummary: string | null = null;
                    if (sessionId) {
                        try {
                            const lastCompaction = await getLastCompaction(sessionId);
                            if (lastCompaction) {
                                compactionSummary = lastCompaction.summary;
                                console.log(`🗜️ [SessionCompaction] Вставляем резюме (${compactionSummary.length} символов) в контекст`);
                            }
                        } catch (err) {
                            console.error('[SessionCompaction] ⚠️ Ошибка загрузки компакции:', err);
                        }
                    }

                    const conversationHistory = formatMessagesForPrompt(
                        isImageMessage ? memoryContext.recentMessages : memoryContext.recentMessages.slice(0, -1),
                        compactionSummary
                    );

                    const messages = [
                        ...systemMessages,
                        ...conversationHistory,
                        ...(!isImageMessage ? [{ role: "user" as const, content: userMessage }] : []),
                    ];

                    // Данные рефлектора теперь в reflectionContext (секция контекста),
                    // а Duplicate Guard в executionEngine блокирует повторные вызовы.
                    // Сюда передаём массив tool calls для Duplicate Guard.
                    const reflectionMeta = (memoryContext as any)._reflectionMeta;

                    // Tools: фильтруем web_browser — browser tools доступны ТОЛЬКО browser субагенту
                    const mainAgentPacks = classification.toolPacks.filter((p: string) => p !== 'web_browser');
                    const tools = resolveToolsByPacks(mainAgentPacks);

                    if (tools.length > 0) {
                        try {
                            const reactResult = await executeReActLoop({
                                messages,
                                tools,
                                aiConfig,
                                finalAnswerAiConfig,
                                context: {
                                    sessionId: memoryContext.sessionId || '',
                                    messageId: memoryContext.messageId || 0,
                                    isSubagent: false,
                                    _isFastPath: isFastPath, // ⚡ Передаём флаг в контекст выполнения
                                },
                                complexity: classification.complexity,
                                agentSlug: expertise.slug,
                                broadcastStep: memoryContext.broadcastStep,
                                messageId: memoryContext.messageId,
                                phase: 'response',
                                reflectionToolCalls: reflectionMeta?.allToolCallDetails || [],
                                // Response Phase: контекст для двухфазной генерации ответа
                                responsePhaseOptions: {
                                    expertise,
                                    context: memoryContext,
                                    dbPersonaPrompt: aiConfig.systemPrompt ?? undefined,
                                    skillsContext: memoryContext.skillsContext ?? undefined,
                                    preferencesContext: memoryContext.preferencesContext ?? undefined,
                                    plan: classification.plan,
                                    contextWindow: aiConfig.contextWindow,
                                    modelName: aiConfig.model,
                                    isFastPath,
                                },
                            });

                            return {
                                content: reactResult.content,
                                agentSlug: expertise.slug,
                                tokensUsed: reactResult.tokensUsed,
                                toolCalls: reactResult.toolCalls.map(tc => ({
                                    toolName: tc.toolName,
                                    success: tc.result.success,
                                    durationMs: tc.durationMs,
                                })),
                            };
                        } catch (error: any) {
                            const errorName = error?.constructor?.name || 'Unknown';
                            const errorMsg = error?.message || String(error);
                            const errorStack = error?.stack?.split('\n').slice(0, 4).join('\n') || '';
                            console.error(`[Expertise:${expertise.slug}] 🔴 ReAct Loop ошибка [${errorName}], fallback на прямой вызов:`, errorMsg);
                            if (errorStack) console.error(`[Expertise:${expertise.slug}] Stack:`, errorStack);
                        }
                    }

                    // Fallback: прямой вызов без tools
                    const result = await callWithFallback(aiConfig, messages);
                    return {
                        content: result.content,
                        agentSlug: expertise.slug,
                        tokensUsed: result.tokensUsed,
                    };
                }

                // Expertise не найдена — fallback через general
                console.warn(`⚠️ No expertise found for domain "${classification.domain}", using general expertise`);
                const fallbackExpertise = await getExpertiseBySlug('general');
                if (fallbackExpertise) {
                    const aiConfig = await getAIClientForTask('agent_core');
                    const systemMessages = assemblePrompt({
                        expertise: fallbackExpertise,
                        context: memoryContext,
                        dbPersonaPrompt: aiConfig.systemPrompt ?? undefined,
                        skillsContext: memoryContext.skillsContext ?? undefined,
                        preferencesContext: memoryContext.preferencesContext ?? undefined,
                        contextWindow: aiConfig.contextWindow,
                        isFastPath,
                    });
                    const lastMsg = memoryContext.recentMessages[memoryContext.recentMessages.length - 1];
                    const isImg = lastMsg?.type === 'image' && lastMsg?.fileUrl;
                    const convHistory = formatMessagesForPrompt(
                        isImg ? memoryContext.recentMessages : memoryContext.recentMessages.slice(0, -1)
                    );
                    const msgs = [
                        ...systemMessages,
                        ...convHistory,
                        ...(!isImg ? [{ role: "user" as const, content: userMessage }] : []),
                    ];
                    const result = await callWithFallback(aiConfig, msgs);
                    return {
                        content: result.content,
                        agentSlug: 'general',
                        tokensUsed: result.tokensUsed,
                    };
                }
                // Абсолютный fallback без каких-либо expertises
                throw new Error('No expertises available');
            },
            (resp) => ({
                summary: `Ответ сгенерирован (${resp.tokensUsed} токенов)`,
                data: {
                    агент: resp.agentSlug,
                    режим: 'expertise',
                    использовано_токенов: resp.tokensUsed,
                    контекст_для_AI: {
                        фактов_в_контексте: memoryContext.relevantFacts?.length || 0,
                        сообщений_в_истории: memoryContext.recentMessages?.length || 0,
                    },
                    tool_calls: resp.toolCalls?.map(tc => `${tc.toolName} (${tc.success ? '✅' : '❌'})`) || [],
                    превью_ответа: resp.content.length > 200
                        ? resp.content.substring(0, 200) + '...'
                        : resp.content
                }
            }),
            broadcastStep,
            workflowLogger,
            undefined,
            420_000 // 420с — ReAct Loop: до 15 итераций при high complexity (60-80с каждая) + tool calls
        );

        console.log(`🤖 Response generated by ${classification.domain}`);

        // 5. Post-processing (fire-and-forget — не блокирует ответ)
        // Knowledge Graph + Profile + Preferences — остаются как timeStep (привязаны к UI pipeline)
        // Fact Extraction, Self-Reflection, Session Compaction — переведены на lifecycle hooks
        const postProcessingTasks: Promise<any>[] = [
            timeStep(
                messageId,
                ORCHESTRATOR_STEPS.knowledge,
                () => extractAndSaveKnowledgeRelations(userMessage, messageId),
                (result) => ({
                    summary: result.relationsCreated > 0
                        ? `${result.relationsCreated} знаний извлечено`
                        : 'Новых знаний не найдено',
                    data: {
                        созданных_связей: result.relationsCreated,
                        триплеты: result.triplets
                    }
                }),
                broadcastStep,
                workflowLogger
            ).catch(err => console.error('⚠️ Ошибка извлечения знаний:', err)),

            // Фоновое обновление профиля
            timeStep(
                messageId,
                ORCHESTRATOR_STEPS.profileUpdate,
                () => extractProfileUpdatesFromMessage(userMessage),
                (result) => ({
                    summary: result.count > 0
                        ? `${result.count} записей обновлено`
                        : 'Нет обновлений профиля',
                    data: {
                        обновлено: result.count,
                        детали: result.details.length > 0 ? result.details : ['Новых данных профиля не найдено'],
                    }
                }),
                broadcastStep,
                workflowLogger
            ).catch(err => console.error('⚠️ Ошибка фонового обновления профиля:', err)),

            // Фоновое извлечение предпочтений
            timeStep(
                messageId,
                ORCHESTRATOR_STEPS.preferenceExtraction,
                () => extractPreferencesFromMessage(userMessage, agentResponse?.content || ''),
                (result) => ({
                    summary: result.count > 0
                        ? `${result.count} предпочтений обновлено`
                        : 'Нет новых предпочтений',
                    data: {
                        обновлено: result.count,
                        детали: result.details.length > 0 ? result.details : ['Новых предпочтений не обнаружено'],
                    }
                }),
                broadcastStep,
                workflowLogger
            ).catch(err => console.error('⚠️ Ошибка извлечения предпочтений:', err)),
        ];

        // Ежедневный decay устаревших предпочтений
        if (!lastDecayRun || (Date.now() - lastDecayRun.getTime()) > 24 * 60 * 60 * 1000) {
            postProcessingTasks.push(
                decayStalePreferences()
                    .then(result => {
                        if (result.decayed > 0 || result.deleted > 0) {
                            console.log(`🕐 Preference decay: ${result.decayed} decayed, ${result.deleted} deleted`);
                        }
                        lastDecayRun = new Date();
                    })
                    .catch(err => console.error('⚠️ Ошибка decay предпочтений:', err))
            );
        }

        // Data Ingestion — если есть структурированные данные
        if (classification.dataClassification?.hasStructuredData) {
            postProcessingTasks.push(
                processDataIngestion(userMessage, classification.dataClassification, messageId || 0)
                    .then(result => {
                        if (result) {
                            console.log(`📥 Data: ${result.type}: ${result.summary}`);
                        }
                    })
                    .catch(err => console.error('⚠️ Ошибка сохранения данных:', err))
            );
        }

        // 🚀 Асинхронное выполнение пост-процессинга и завершение workflow (не блокирует ответ)
        (async () => {
            try {
                // Ждём завершения всех фоновых задач
                const settledResults = await Promise.allSettled(postProcessingTasks);
                logSettledResults(
                    settledResults,
                    { source: 'PostProcessing', sessionId, messageId },
                );

                // 6. Обновляем контекст сессии
                await intentClassifier.updateSessionContext(sessionId, {
                    activeAgentSlug: classification.domain,
                    currentTopics: JSON.stringify(classification.detectedTopics),
                });

                console.log(`✅ Background post-processing (timeStep) complete for session ${sessionId}`);

                // 🪝 Lifecycle Hooks: afterMessage — fact extraction, self-reflection, session compaction
                // Fire-and-forget — не блокирует ответ. Ошибки изолированы per-handler.
                hooks.emitFireAndForget('afterMessage', {
                    userMessage,
                    agentResponse: agentResponse.content,
                    sessionId,
                    messageId,
                    agentSlug: classification.domain,
                    tokensUsed: agentResponse.tokensUsed,
                    toolCalls: agentResponse.toolCalls,
                    recentMessages: memoryContext.recentMessages,
                    broadcastStep,
                });

                // 8. Завершаем логирование workflow
                if (workflowLogger) {
                    await workflowLogger.complete({
                        agentUsed: classification.domain,
                        tokensUsed: agentResponse.tokensUsed,
                        factsCount: 0,
                        contextSummary: {
                            factsInContext: memoryContext.relevantFacts?.length || 0,
                            messagesInHistory: memoryContext.recentMessages.length,
                            profileLoaded: !!memoryContext.userProfile
                        }
                    });
                }
            } catch (err) {
                console.error('❌ Ошибка в фоновом пост-процессинге:', err);
                hooks.emitFireAndForget('onError', {
                    error: err instanceof Error ? err : String(err),
                    source: 'post_processing',
                    sessionId,
                    messageId,
                });
                if (workflowLogger) {
                    await workflowLogger.error(String(err));
                }
            }
        })();

        // 7. Получаем имя агента для UI (нужно для мгновенного ответа)
        const agentName = await getAgentName(classification.domain);

        console.log(`⚡ Response returned to user, post-processing continues in background...`);

        return {
            response: cleanAgentResponse(agentResponse.content),
            agentUsed: classification.domain,
            agentName,
            classificationResult: classification,
            factsExtracted: 0,
            tokensUsed: agentResponse.tokensUsed,
            insightsShown: 0,
            remindersCreated: 0,
            toolCalls: agentResponse.toolCalls,
        };
    } catch (error) {
        // Логируем ошибку через lifecycle hooks и workflow
        hooks.emitFireAndForget('onError', {
            error: error instanceof Error ? error : String(error),
            source: 'orchestrator',
            sessionId,
            messageId,
        });
        if (workflowLogger) {
            await workflowLogger.error(String(error));
        }
        throw error;
    }
}

/**
 * Получение списка доступных агентов
 */
export async function getAvailableAgents(): Promise<Agent[]> {
    const allAgents = await db.select().from(agents).where(eq(agents.isActive, true));
    return allAgents;
}

/**
 * Переключение статуса агента
 */
export async function toggleAgent(slug: string, isActive: boolean): Promise<void> {
    await db.update(agents)
        .set({ isActive })
        .where(eq(agents.slug, slug));
}
