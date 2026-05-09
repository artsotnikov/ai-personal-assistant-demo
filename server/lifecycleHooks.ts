/**
 * Lifecycle Hooks — Глобальная event-based система lifecycle hooks
 * 
 * Декаплит side-effect модули (fact extraction, self-reflection, session compaction и др.)
 * от core-модулей (agentOrchestrator). Модули подписываются на события вместо прямых import.
 * 
 * Поддерживает:
 * - 7 типов событий lifecycle pipeline
 * - Priority-based ordering (меньше = раньше)
 * - Fire-and-forget семантику для async side-effects
 * - Изоляцию ошибок: падение одного handler не блокирует остальные
 * 
 * Emoji-префикс в логах: 🪝
 */

// ============================================================================
// Типы событий
// ============================================================================

/** Все поддерживаемые lifecycle events */
export type HookEvent =
    | 'beforeMessage'      // перед обработкой сообщения пользователя
    | 'afterMessage'       // после ответа агента (fire-and-forget)
    | 'beforeToolCall'     // перед вызовом tool
    | 'afterToolCall'      // после вызова tool
    | 'onContextBuild'     // при сборке контекста
    | 'onError'            // при ошибке в pipeline
    | 'onCronComplete';    // после выполнения cron-задачи

// ============================================================================
// Типы данных для каждого события
// ============================================================================

/** Данные для beforeMessage */
export interface BeforeMessageData {
    userMessage: string;
    sessionId: string;
    messageId: number;
}

/** Данные для afterMessage */
export interface AfterMessageData {
    userMessage: string;
    agentResponse: string;
    sessionId: string;
    messageId: number;
    agentSlug: string;
    tokensUsed: number;
    toolCalls?: Array<{ toolName: string; success: boolean; durationMs: number }>;
    recentMessages?: any[];
    broadcastStep?: Function;
}

/** Данные для beforeToolCall / afterToolCall */
export interface ToolCallHookData {
    toolName: string;
    input: Record<string, unknown>;
    sessionId: string;
    messageId: number;
    /** Только для afterToolCall */
    result?: { success: boolean; error?: string; displayText?: string };
    /** Только для afterToolCall */
    durationMs?: number;
}

/** Данные для onContextBuild */
export interface ContextBuildData {
    userMessage: string;
    sessionId?: string;
    contextSections: string[];
}

/** Данные для onError */
export interface OnErrorData {
    error: Error | string;
    source: string;
    sessionId?: string;
    messageId?: number;
}

/** Данные для onCronComplete */
export interface OnCronCompleteData {
    taskId: number;
    taskTitle: string;
    success: boolean;
    result?: string;
    error?: string;
    durationMs: number;
}

/** Маппинг событий → типы данных */
export interface HookEventMap {
    beforeMessage: BeforeMessageData;
    afterMessage: AfterMessageData;
    beforeToolCall: ToolCallHookData;
    afterToolCall: ToolCallHookData;
    onContextBuild: ContextBuildData;
    onError: OnErrorData;
    onCronComplete: OnCronCompleteData;
}

// ============================================================================
// Handler
// ============================================================================

/** Обработчик lifecycle hook */
export interface HookHandler<T = any> {
    /** Уникальное имя (для логирования и unregister) */
    name: string;
    /** Функция-обработчик */
    handler: (data: T) => Promise<void>;
    /** Приоритет: меньше = выполняется раньше (default: 50) */
    priority: number;
}

// ============================================================================
// Registry
// ============================================================================

class HookRegistry {
    private handlers = new Map<HookEvent, HookHandler[]>();
    private emitCounts = new Map<HookEvent, number>();

    /**
     * Зарегистрировать handler для события.
     * Handlers сортируются по priority (меньше = раньше).
     */
    register<E extends HookEvent>(
        event: E,
        handler: HookHandler<HookEventMap[E]>,
    ): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }

        const handlers = this.handlers.get(event)!;

        // Проверка дублей по имени
        const existing = handlers.findIndex(h => h.name === handler.name);
        if (existing !== -1) {
            console.warn(`🪝 [LifecycleHooks] Handler "${handler.name}" для "${event}" уже зарегистрирован, перезаписываю`);
            handlers[existing] = handler;
        } else {
            handlers.push(handler);
        }

        // Сортировка по priority
        handlers.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Удалить handler по имени
     */
    unregister(event: HookEvent, handlerName: string): void {
        const handlers = this.handlers.get(event);
        if (!handlers) return;

        const idx = handlers.findIndex(h => h.name === handlerName);
        if (idx !== -1) {
            handlers.splice(idx, 1);
            console.log(`🪝 [LifecycleHooks] Handler "${handlerName}" удалён из "${event}"`);
        }
    }

    /**
     * Последовательный вызов всех handlers.
     * Ждём каждый handler в порядке приоритета.
     * Ошибка одного handler НЕ останавливает остальных.
     */
    async emit<E extends HookEvent>(event: E, data: HookEventMap[E]): Promise<void> {
        const handlers = this.handlers.get(event);
        if (!handlers || handlers.length === 0) return;

        this.incrementCount(event);

        for (const h of handlers) {
            try {
                await h.handler(data);
            } catch (error) {
                console.error(`🪝 [LifecycleHooks] ❌ Handler "${h.name}" ошибка при "${event}":`, error);
            }
        }
    }

    /**
     * Fire-and-forget: запускаем все handlers параллельно, не ждём результатов.
     * Ошибки логируются, но не пробрасываются.
     * 
     * Идеально для afterMessage side-effects (fact extraction, self-reflection и т.д.)
     */
    emitFireAndForget<E extends HookEvent>(event: E, data: HookEventMap[E]): void {
        const handlers = this.handlers.get(event);
        if (!handlers || handlers.length === 0) return;

        this.incrementCount(event);

        // Запускаем все параллельно через Promise.allSettled
        Promise.allSettled(
            handlers.map(h =>
                h.handler(data).catch(error => {
                    console.error(`🪝 [LifecycleHooks] ❌ Handler "${h.name}" ошибка при "${event}" (fire-and-forget):`, error);
                    throw error; // re-throw для allSettled статистики
                })
            )
        ).then(results => {
            const failed = results.filter(r => r.status === 'rejected').length;
            if (failed > 0) {
                console.warn(`🪝 [LifecycleHooks] ⚠️ ${event}: ${failed}/${results.length} handlers failed`);
            }
        });
    }

    /**
     * Получить список зарегистрированных handlers для события
     */
    getHandlers(event: HookEvent): HookHandler[] {
        return this.handlers.get(event) || [];
    }

    /**
     * Статистика: количество emit для каждого события
     */
    getStats(): Record<string, { handlers: number; emits: number }> {
        const stats: Record<string, { handlers: number; emits: number }> = {};

        const allEvents: HookEvent[] = [
            'beforeMessage', 'afterMessage', 'beforeToolCall', 'afterToolCall',
            'onContextBuild', 'onError', 'onCronComplete',
        ];

        for (const event of allEvents) {
            stats[event] = {
                handlers: (this.handlers.get(event) || []).length,
                emits: this.emitCounts.get(event) || 0,
            };
        }

        return stats;
    }

    /**
     * Сводка для логирования при инициализации
     */
    getSummary(): string {
        const parts: string[] = [];
        const entries = Array.from(this.handlers.entries());
        for (const [event, handlers] of entries) {
            if (handlers.length > 0) {
                parts.push(`${event}: ${handlers.map((h: HookHandler) => h.name).join(', ')}`);
            }
        }
        return parts.length > 0 ? parts.join(' | ') : 'нет зарегистрированных handlers';
    }

    private incrementCount(event: HookEvent): void {
        this.emitCounts.set(event, (this.emitCounts.get(event) || 0) + 1);
    }
}

// ============================================================================
// Глобальный singleton
// ============================================================================

/** Глобальный lifecycle hook registry */
export const hooks = new HookRegistry();
