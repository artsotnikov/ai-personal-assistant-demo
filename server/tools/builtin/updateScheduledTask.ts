/**
 * Tool: update_scheduled_task — Обновить cron-задачу
 * 
 * Позволяет AI:
 * - Приостановить / возобновить / отменить задачу
 * - Обновить промпт, расписание (cron), лимит запусков
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as aiTaskScheduler from '../../aiTaskScheduler';

interface UpdateScheduledTaskInput {
    taskId: number;
    status?: 'active' | 'paused' | 'cancelled';
    title?: string;
    prompt?: string;
    cronExpression?: string;
    maxRuns?: number | null;
}

export const updateScheduledTaskTool: ToolDefinition<UpdateScheduledTaskInput> = {
    name: 'update_scheduled_task',
    description: `Обновить cron-задачу (периодическую задачу) по ID.

Возможности:
- Приостановить (status: "paused") — задача перестанет выполняться, но сохранится
- Возобновить (status: "active") — после паузы или после error_paused (сбросит счётчик ошибок)
- Отменить (status: "cancelled") — задача больше не будет запускаться
- Обновить title, prompt, cronExpression, maxRuns

Статусы задач: active, paused, error_paused (авто-пауза после 10 ошибок подряд), cancelled.
Используй list_scheduled_tasks чтобы узнать ID задач.`,
    category: 'system',
    toolPack: 'scheduling',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'number',
                description: 'ID задачи для обновления',
            },
            status: {
                type: 'string',
                description: 'Новый статус: "active" (возобновить), "paused" (пауза), "cancelled" (отмена)',
                enum: ['active', 'paused', 'cancelled'],
            },
            title: {
                type: 'string',
                description: 'Новое название задачи',
            },
            prompt: {
                type: 'string',
                description: 'Новый промпт (что AI делает при каждом запуске)',
            },
            cronExpression: {
                type: 'string',
                description: 'Новое cron-выражение расписания (5 полей)',
            },
            maxRuns: {
                type: 'number',
                description: 'Новый лимит запусков (null = бесконечно)',
            },
        },
        required: ['taskId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const { taskId, status, title, prompt, cronExpression, maxRuns } = input;

            // Проверяем, что задача существует
            const existing = await aiTaskScheduler.getTask(taskId);
            if (!existing) {
                return {
                    success: false,
                    error: `Задача #${taskId} не найдена`,
                    displayText: `❌ Задача #${taskId} не найдена`,
                };
            }

            const changes: string[] = [];
            let updatedTask = existing;

            // 1. Обновление статуса (через специализированные функции)
            if (status && status !== existing.status) {
                if (status === 'paused') {
                    const result = await aiTaskScheduler.pauseTask(taskId);
                    if (result) updatedTask = result;
                    changes.push(`статус: ${existing.status} → paused`);
                } else if (status === 'active') {
                    const result = await aiTaskScheduler.resumeTask(taskId);
                    if (result) updatedTask = result;
                    changes.push(`статус: ${existing.status} → active`);
                } else if (status === 'cancelled') {
                    const result = await aiTaskScheduler.cancelTask(taskId);
                    if (result) updatedTask = result;
                    changes.push(`статус: ${existing.status} → cancelled`);
                }
            }

            // 2. Обновление полей контента (title, prompt, cron, maxRuns)
            const fieldsToUpdate: Record<string, any> = {};
            if (title && title !== existing.title) {
                fieldsToUpdate.title = title;
                changes.push(`название: "${title}"`);
            }
            if (prompt && prompt !== existing.prompt) {
                fieldsToUpdate.prompt = prompt;
                changes.push(`промпт обновлён`);
            }
            if (cronExpression && cronExpression !== existing.cronExpression) {
                fieldsToUpdate.cronExpression = cronExpression;
                changes.push(`расписание: ${existing.cronExpression} → ${cronExpression}`);
            }
            if (maxRuns !== undefined) {
                fieldsToUpdate.maxRuns = maxRuns;
                changes.push(`лимит запусков: ${maxRuns === null ? 'без ограничений' : maxRuns}`);
            }

            if (Object.keys(fieldsToUpdate).length > 0) {
                const result = await aiTaskScheduler.updateTask(taskId, fieldsToUpdate);
                if (result) updatedTask = result;
            }

            if (changes.length === 0) {
                return {
                    success: true,
                    data: { task: { id: existing.id, title: existing.title, status: existing.status } },
                    displayText: `📅 Задача #${taskId} "${existing.title}" — изменений не обнаружено`,
                };
            }

            return {
                success: true,
                data: {
                    task: {
                        id: updatedTask.id,
                        title: updatedTask.title,
                        status: updatedTask.status,
                        cronExpression: updatedTask.cronExpression,
                        nextRunAt: updatedTask.nextRunAt
                            ? new Date(updatedTask.nextRunAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
                            : null,
                    },
                    changes,
                },
                displayText: `📅 Задача #${taskId} обновлена: ${changes.join(', ')}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка обновления задачи: ${error?.message || error}`,
            };
        }
    },
};
