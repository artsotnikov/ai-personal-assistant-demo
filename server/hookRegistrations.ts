/**
 * Hook Registrations — Регистрация lifecycle hooks при инициализации
 * 
 * Центральный файл, где side-effect модули подписываются на lifecycle events.
 * Вызывается из agentOrchestrator.initializeAgents().
 * 
 * Переведённые модули:
 * 1. factExtractor → afterMessage (priority: 20)
 * 2. selfReflection → afterMessage (priority: 50)
 * 3. sessionCompactor → afterMessage (priority: 60)
 * 
 * Emoji-префикс в логах: 🪝
 */

import { hooks, type AfterMessageData, type OnErrorData } from './lifecycleHooks';
import { extractAndSaveFacts } from './factExtractor';
import { analyzeConversation as selfReflect } from './selfReflection';
import { shouldCompact, applyCompaction } from './sessionCompactor';
import { logToolCall } from './lib/logger';

// ============================================================================
// afterMessage hooks
// ============================================================================

/**
 * Fact Extraction Hook — фоновое извлечение фактов из сообщения пользователя
 * 
 * Дополняет агентский remember_fact: ловит факты, которые агент не сохранил.
 * Priority 20 — запускается одним из первых.
 */
function registerFactExtractionHook(): void {
    hooks.register('afterMessage', {
        name: 'fact_extraction',
        priority: 20,
        handler: async (data: AfterMessageData) => {
            const dialogContext = data.recentMessages
                ?.slice(-5)
                .map((m: any) => m.content) || [];

            const facts = await extractAndSaveFacts(
                data.userMessage,
                data.messageId,
                dialogContext,
                data.broadcastStep as any,
            );

            if (facts.length > 0) {
                console.log(`🪝 [Hook:fact_extraction] ${facts.length} фактов извлечено`);
            }
        },
    });
}

/**
 * Self-Reflection Hook — анализ качества диалога
 * 
 * «Мог ли я ответить лучше?» — проверяет неудачные tool calls,
 * упущенные знания, аномальный расход токенов.
 * Priority 50 — средний приоритет.
 */
function registerSelfReflectionHook(): void {
    hooks.register('afterMessage', {
        name: 'self_reflection',
        priority: 50,
        handler: async (data: AfterMessageData) => {
            const result = await selfReflect({
                userMessage: data.userMessage,
                agentResponse: data.agentResponse,
                toolCalls: data.toolCalls,
                agentSlug: data.agentSlug,
                tokensUsed: data.tokensUsed,
            });

            if (result.findings.length > 0) {
                console.log(`🪝 [Hook:self_reflection] ${result.findings.length} findings`);
            }
        },
    });
}

/**
 * Session Compaction Hook — сжатие длинных диалогов
 * 
 * Если история > 30 сообщений или > 15K символов, старая часть
 * сжимается LLM в краткое summary.
 * Priority 60 — запускается после fact extraction (чтобы факты успели сохраниться).
 */
function registerSessionCompactionHook(): void {
    hooks.register('afterMessage', {
        name: 'session_compaction',
        priority: 60,
        handler: async (data: AfterMessageData) => {
            if (!data.recentMessages || !data.sessionId) return;

            if (shouldCompact(data.recentMessages)) {
                const result = await applyCompaction(data.recentMessages, data.sessionId);
                if (result.compactedCount > 0) {
                    console.log(`🪝 [Hook:session_compaction] Сжато ${result.compactedCount} сообщений, сэкономлено ~${result.savedTokens} токенов`);
                }
            }
        },
    });
}

// ============================================================================
// onError hooks
// ============================================================================

/**
 * Error Logging Hook — логирование ошибок pipeline в tool_call_logs
 * Priority 10 — ранний запуск.
 */
function registerErrorLoggingHook(): void {
    hooks.register('onError', {
        name: 'error_logging',
        priority: 10,
        handler: async (data: OnErrorData) => {
            const errorMsg = typeof data.error === 'string'
                ? data.error
                : data.error?.message || String(data.error);

            console.error(`🪝 [Hook:error_logging] Ошибка в ${data.source}: ${errorMsg}`);

            // Персистим в tool_call_logs для видимости
            await logToolCall({
                toolName: '__lifecycle_error__',
                input: { source: data.source },
                result: { error: errorMsg },
                success: false,
                error: `[${data.source}] ${errorMsg}`,
                durationMs: 0,
                agentSlug: data.source,
                messageId: data.messageId,
                sessionId: data.sessionId,
                iteration: 0,
                displayText: `🔴 Lifecycle error in "${data.source}": ${errorMsg.substring(0, 200)}`,
            }).catch(() => {}); // fire-and-forget
        },
    });
}

// ============================================================================
// Точка входа — регистрация всех hooks
// ============================================================================

/**
 * Регистрирует все lifecycle hooks.
 * Вызывается из agentOrchestrator.initializeAgents() при старте приложения.
 */
export function registerLifecycleHooks(): void {
    // afterMessage hooks
    registerFactExtractionHook();
    registerSelfReflectionHook();
    registerSessionCompactionHook();

    // onError hooks
    registerErrorLoggingHook();

    console.log(`🪝 [LifecycleHooks] ✅ Зарегистрировано: ${hooks.getSummary()}`);
}
