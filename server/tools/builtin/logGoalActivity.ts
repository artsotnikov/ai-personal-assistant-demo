/**
 * Tool: log_goal_activity — Записать активность в журнал цели
 * 
 * Позволяет AI привязывать разговоры, заметки и обновления
 * прогресса к конкретным целям.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logGoalActivity } from '../../goalManager';

interface LogGoalActivityInput {
    goalId: number;
    activityType: 'progress_update' | 'note' | 'review' | 'milestone_reached' | 'task_completed';
    description: string;
    metadata?: Record<string, any>;
}

export const logGoalActivityTool: ToolDefinition<LogGoalActivityInput> = {
    name: 'log_goal_activity',
    description: `Записать активность в журнал цели. Используй для:
- Заметок о прогрессе ("обсуждали стратегию продвижения")
- Связывания разговоров с целями
- Обзоров прогресса (review)
- Любых обновлений, не связанных с завершением задач

Типы: progress_update, note, review, milestone_reached, task_completed`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
            activityType: {
                type: 'string',
                description: 'Тип активности',
                enum: ['progress_update', 'note', 'review', 'milestone_reached', 'task_completed'],
            },
            description: {
                type: 'string',
                description: 'Описание активности',
            },
            metadata: {
                type: 'object',
                description: 'Дополнительные данные (опционально)',
            },
        },
        required: ['goalId', 'activityType', 'description'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            // 1. Проверяем существование цели
            const existing = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);
            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `Цель с ID ${input.goalId} не найдена.`,
                };
            }

            const goal = existing[0];

            // 2. Записываем в журнал
            const activity = await logGoalActivity(
                input.goalId,
                input.activityType,
                input.description,
                input.metadata,
                ctx.messageId,
            );

            const typeEmoji: Record<string, string> = {
                progress_update: '📊',
                note: '📝',
                review: '🔍',
                milestone_reached: '🏆',
                task_completed: '✅',
            };

            return {
                success: true,
                data: { activityId: activity.id, goalId: input.goalId },
                displayText: `${typeEmoji[input.activityType] || '📋'} Записано в журнал цели "${goal.title}": ${input.description}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка записи активности: ${error?.message || error}`,
            };
        }
    },
};
