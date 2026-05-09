/**
 * Tool: list_scheduled_tasks — Просмотр cron-задач AI
 * 
 * Делегирует к aiTaskScheduler.listTasks()
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as aiTaskScheduler from '../../aiTaskScheduler';

interface ListScheduledTasksInput {
    status?: string;
    search?: string;
}

export const listScheduledTasksTool: ToolDefinition<ListScheduledTasksInput> = {
    name: 'list_scheduled_tasks',
    description: `Получить список всех cron-задач (периодических задач по расписанию). 
Используй для просмотра активных, приостановленных и отменённых задач.
Возвращает массив задач с ID — используй ID для update_scheduled_task или delete_scheduled_task.

Статусы: active, paused, error_paused (авто-пауза после ошибок), cancelled.`,
    category: 'system',
    toolPack: 'scheduling',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description: 'Фильтр по статусу. Без фильтра — все задачи.',
                enum: ['active', 'paused', 'error_paused', 'cancelled'],
            },
            search: {
                type: 'string',
                description: 'Поиск по названию задачи (нечёткий)',
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            let tasks = await aiTaskScheduler.listTasks(
                input.status ? { status: input.status } : undefined
            );

            // Фильтрация по ключевому слову в названии
            if (input.search) {
                const searchLower = input.search.toLowerCase();
                tasks = tasks.filter(t => t.title.toLowerCase().includes(searchLower));
            }

            if (tasks.length === 0) {
                return {
                    success: true,
                    data: { tasks: [], count: 0 },
                    displayText: `📅 Cron-задач${input.status ? ` со статусом "${input.status}"` : ''}${input.search ? ` по запросу "${input.search}"` : ''} не найдено`,
                };
            }

            // Компактное представление для AI — включая ВСЮ необходимую информацию
            const summary = tasks.map(t => ({
                id: t.id,
                title: t.title,
                cronExpression: t.cronExpression,
                status: t.status,
                runCount: t.runCount,
                maxRuns: t.maxRuns,
                consecutiveErrors: t.consecutiveErrors || 0,
                nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : null,
                lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : null,
                prompt: t.prompt.length > 150 ? t.prompt.substring(0, 150) + '...' : t.prompt,
            }));

            const statusCounts = {
                active: tasks.filter(t => t.status === 'active').length,
                paused: tasks.filter(t => t.status === 'paused').length,
                error_paused: tasks.filter(t => t.status === 'error_paused').length,
                cancelled: tasks.filter(t => t.status === 'cancelled').length,
            };

            // Формируем информативный displayText с ID (как getNotes)
            const statusIcons: Record<string, string> = {
                active: '🟢',
                paused: '⏸️',
                error_paused: '🔴',
                cancelled: '❌',
            };

            const displayLines = summary.map((t, i) => {
                const icon = statusIcons[t.status] || '❓';
                const runs = t.maxRuns ? `${t.runCount}/${t.maxRuns}` : `${t.runCount}`;
                const errors = t.consecutiveErrors > 0 ? ` ⚠️${t.consecutiveErrors}err` : '';
                const next = t.nextRunAt ? ` → ${t.nextRunAt}` : '';
                return `${i + 1}. ${icon} **${t.title}** [${t.cronExpression}] — запусков: ${runs}${errors}${next} (id:${t.id})`;
            });

            const statusParts: string[] = [];
            if (statusCounts.active) statusParts.push(`активных: ${statusCounts.active}`);
            if (statusCounts.paused) statusParts.push(`на паузе: ${statusCounts.paused}`);
            if (statusCounts.error_paused) statusParts.push(`ошибка: ${statusCounts.error_paused}`);
            if (statusCounts.cancelled) statusParts.push(`отменённых: ${statusCounts.cancelled}`);

            return {
                success: true,
                data: { tasks: summary, count: tasks.length, statusCounts },
                displayText: `📅 Найдено ${tasks.length} cron-задач (${statusParts.join(', ')}):\n${displayLines.join('\n')}\n\n_Используй update_scheduled_task(taskId) или delete_scheduled_task(taskId) для управления._`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения списка задач: ${error?.message || error}`,
            };
        }
    },
};
