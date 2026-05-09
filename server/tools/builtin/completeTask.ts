/**
 * Tool: complete_task — Завершить задачу внутри milestone
 * 
 * Помечает задачу как выполненную и автоматически
 * пересчитывает прогресс milestone → goal.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goalTasks } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { recalculateGoalProgress, logGoalActivity } from '../../goalManager';

interface CompleteTaskInput {
    taskId: number;
    notes?: string;
}

export const completeTaskTool: ToolDefinition<CompleteTaskInput> = {
    name: 'complete_task',
    description: `Завершить задачу (task) внутри milestone цели. Автоматически пересчитывает прогресс:
- Задача → done
- Milestone: % = done/total tasks
- Goal: % = среднее по milestones

Используй когда пользователь сообщает о выполнении конкретной задачи из плана цели.`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'number',
                description: 'ID задачи для завершения (числовой ID из БД, отображается как [task ID: X] в деталях цели. НЕ порядковый номер!)',
            },
            notes: {
                type: 'string',
                description: 'Комментарий к завершению задачи',
            },
        },
        required: ['taskId'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            // 1. Проверяем существование задачи
            const existing = await db.select().from(goalTasks).where(eq(goalTasks.id, input.taskId)).limit(1);
            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Задача с ID ${input.taskId} не найдена`,
                    displayText: `Задача с ID ${input.taskId} не найдена.`,
                };
            }

            const task = existing[0];

            if (task.status === 'done') {
                return {
                    success: true,
                    data: { taskId: task.id, status: 'done' },
                    displayText: `Задача "${task.title}" уже была завершена.`,
                };
            }

            // 2. Обновляем статус задачи
            await db.update(goalTasks)
                .set({
                    status: 'done',
                    completedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(goalTasks.id, input.taskId));

            // 3. Записываем в activity log
            await logGoalActivity(task.goalId, 'task_completed',
                `Задача завершена: "${task.title}"${input.notes ? ` — ${input.notes}` : ''}`,
                { taskId: task.id, milestoneId: task.milestoneId, notes: input.notes },
                ctx.messageId,
            );

            // 4. Пересчитываем прогресс цели
            const progressResult = await recalculateGoalProgress(task.goalId);

            // 5. Формируем ответ
            const parts: string[] = [
                `✅ Задача "${task.title}" завершена!`,
                `📊 Прогресс цели: ${progressResult.oldProgress}% → ${progressResult.newProgress}%`,
            ];

            if (progressResult.goalCompleted) {
                parts.push(`🎉 Цель полностью завершена!`);
            }

            if (progressResult.milestonesUpdated > 0) {
                parts.push(`📦 Обновлено milestones: ${progressResult.milestonesUpdated}`);
            }

            return {
                success: true,
                data: {
                    taskId: task.id,
                    goalId: task.goalId,
                    ...progressResult,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка завершения задачи: ${error?.message || error}`,
            };
        }
    },
};
