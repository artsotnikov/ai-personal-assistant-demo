/**
 * Tool: delete_goal — Удалить цель
 * 
 * Поддерживает soft-delete (status → deleted) и hard-delete (физическое удаление).
 * По умолчанию — soft-delete (безопаснее, можно восстановить).
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals, goalMilestones, goalTasks, goalKeyResults, goalActivityLog } from '@shared/schema';
import { eq } from 'drizzle-orm';

interface DeleteGoalInput {
    goalId: number;
    /** Тип удаления: soft (status→deleted, по умолчанию) или hard (физическое удаление из БД) */
    mode?: 'soft' | 'hard';
}

export const deleteGoalTool: ToolDefinition<DeleteGoalInput> = {
    name: 'delete_goal',
    description: `Удалить цель пользователя. Используй когда пользователь просит удалить, убрать или отменить цель.

Режимы:
- soft (по умолчанию): помечает цель как удалённую (status='deleted'), можно восстановить
- hard: полностью удаляет из базы данных вместе с milestones, tasks, key results и activity log

Для «заморозки» цели лучше используй update_goal(goalId, status: "abandoned").`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели для удаления (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
            mode: {
                type: 'string',
                enum: ['soft', 'hard'],
                description: 'Режим удаления: soft (по умолчанию) или hard',
            },
        },
        required: ['goalId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Проверяем существование цели
            const existing = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);

            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `Цель с ID ${input.goalId} не найдена.`,
                };
            }

            const goal = existing[0];
            const mode = input.mode || 'soft';

            if (mode === 'soft') {
                // Soft delete — помечаем как deleted
                await db.update(goals).set({
                    status: 'deleted',
                    updatedAt: new Date(),
                }).where(eq(goals.id, input.goalId));

                // Записываем в activity log
                await db.insert(goalActivityLog).values({
                    goalId: input.goalId,
                    activityType: 'status_change',
                    description: `Цель удалена (soft-delete): "${goal.title}"`,
                    metadata: { previousStatus: goal.status, action: 'soft_delete' },
                });

                return {
                    success: true,
                    data: { goalId: input.goalId, mode: 'soft', title: goal.title },
                    displayText: `🗑️ Цель "${goal.title}" помечена как удалённая.`,
                };
            } else {
                // Hard delete — полное удаление из БД
                // Удаляем связанные данные
                await db.delete(goalTasks).where(eq(goalTasks.goalId, input.goalId));
                await db.delete(goalMilestones).where(eq(goalMilestones.goalId, input.goalId));
                await db.delete(goalKeyResults).where(eq(goalKeyResults.goalId, input.goalId));
                await db.delete(goalActivityLog).where(eq(goalActivityLog.goalId, input.goalId));
                await db.delete(goals).where(eq(goals.id, input.goalId));

                return {
                    success: true,
                    data: { goalId: input.goalId, mode: 'hard', title: goal.title },
                    displayText: `🗑️ Цель "${goal.title}" полностью удалена из базы данных.`,
                };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления цели: ${error?.message || error}`,
            };
        }
    },
};
