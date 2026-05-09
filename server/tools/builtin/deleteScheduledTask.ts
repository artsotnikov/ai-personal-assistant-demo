/**
 * Tool: delete_scheduled_task — Удалить cron-задачу
 * 
 * Делегирует к aiTaskScheduler.deleteTask()
 * Поддерживает удаление одной или нескольких задач.
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as aiTaskScheduler from '../../aiTaskScheduler';

interface DeleteScheduledTaskInput {
    taskId?: number;
    taskIds?: number[];
}

export const deleteScheduledTaskTool: ToolDefinition<DeleteScheduledTaskInput> = {
    name: 'delete_scheduled_task',
    description: `Удалить одну или несколько cron-задач (периодических задач) по ID. 
Задачи удаляются из базы данных безвозвратно вместе с журналом выполнений.
Используй list_scheduled_tasks чтобы узнать ID задач перед удалением.`,
    category: 'system',
    toolPack: 'scheduling',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'number',
                description: 'ID задачи для удаления (одна задача)',
            },
            taskIds: {
                type: 'array',
                items: { type: 'number' },
                description: 'Массив ID задач для массового удаления',
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const ids: number[] = [];

            if (input.taskIds && Array.isArray(input.taskIds)) {
                ids.push(...input.taskIds);
            } else if (input.taskId) {
                ids.push(input.taskId);
            }

            if (ids.length === 0) {
                return {
                    success: false,
                    error: 'Укажите taskId или taskIds для удаления',
                    displayText: '❌ Не указан ID задачи для удаления',
                };
            }

            const results: { id: number; deleted: boolean; error?: string }[] = [];

            for (const id of ids) {
                try {
                    // Проверяем, что задача существует
                    const task = await aiTaskScheduler.getTask(id);
                    if (!task) {
                        results.push({ id, deleted: false, error: 'Задача не найдена' });
                        continue;
                    }

                    await aiTaskScheduler.deleteTask(id);
                    results.push({ id, deleted: true });
                } catch (error: any) {
                    results.push({ id, deleted: false, error: error?.message || String(error) });
                }
            }

            const deletedCount = results.filter(r => r.deleted).length;
            const failedCount = results.filter(r => !r.deleted).length;

            let displayText = `🗑️ Удалено ${deletedCount} из ${ids.length} задач`;
            if (failedCount > 0) {
                const failed = results.filter(r => !r.deleted).map(r => `#${r.id}: ${r.error}`);
                displayText += `\n⚠️ Не удалось: ${failed.join(', ')}`;
            }

            return {
                success: deletedCount > 0,
                data: { results, deletedCount, failedCount },
                displayText,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления задач: ${error?.message || error}`,
            };
        }
    },
};
