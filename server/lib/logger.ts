import { db } from '../db';
import { toolCallLogs } from '@shared/schema';

export interface ToolCallLogParams {
    toolName: string;
    input: unknown;
    result: unknown;
    success: boolean;
    error?: string;
    durationMs: number;
    agentSlug?: string;
    messageId?: number;
    sessionId?: string;
    iteration?: number;
    displayText?: string;
}

/**
 * Логирование вызова инструмента в базу данных
 */
export async function logToolCall(params: ToolCallLogParams): Promise<void> {
    try {
        await db.insert(toolCallLogs).values({
            toolName: params.toolName,
            input: params.input,
            resultData: params.result, // В схеме это может быть jsonb
            success: params.success,
            error: params.error,
            durationMs: params.durationMs,
            agentSlug: params.agentSlug || 'unknown',
            messageId: params.messageId,
            sessionId: params.sessionId,
            iteration: params.iteration,
            displayText: params.displayText,
            createdAt: new Date(),
        });
    } catch (error) {
        console.error('[Logger] ❌ Failed to log tool call:', error);
        // Не выбрасываем ошибку, чтобы не ломать основной флоу
    }
}
