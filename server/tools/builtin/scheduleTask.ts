/**
 * Tool: schedule_task — Создать периодическую задачу (cron)
 * 
 * Делегирует к aiTaskScheduler.createTask()
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as aiTaskScheduler from '../../aiTaskScheduler';

interface ScheduleTaskInput {
    title: string;
    prompt: string;
    cronExpression: string;
    timezone?: string;
    maxRuns?: number;
}

export const scheduleTaskTool: ToolDefinition<ScheduleTaskInput> = {
    name: 'schedule_task',
    description: `Создать периодическую задачу по расписанию (cron). AI будет автоматически выполнять prompt по расписанию. Используй когда пользователь хочет автоматизировать повторяющиеся действия.

Примеры cron:
- "0 9 * * 1" — каждый понедельник в 9:00
- "0 10 * * *" — каждый день в 10:00
- "0 0 1 * *" — первого числа каждого месяца`,
    category: 'system',
    toolPack: 'scheduling',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Название задачи',
            },
            prompt: {
                type: 'string',
                description: 'Промпт — что AI будет делать при каждом запуске',
            },
            cronExpression: {
                type: 'string',
                description: 'Cron-выражение расписания (5 полей: минуты часы день месяц день_недели)',
            },
            timezone: {
                type: 'string',
                description: 'Часовой пояс (по умолчанию Europe/Moscow)',
            },
            maxRuns: {
                type: 'number',
                description: 'Максимальное количество запусков (null = бесконечно)',
            },
        },
        required: ['title', 'prompt', 'cronExpression'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const task = await aiTaskScheduler.createTask({
                title: input.title,
                prompt: input.prompt,
                cronExpression: input.cronExpression,
                timezone: input.timezone || 'Europe/Moscow',
                maxRuns: input.maxRuns,
                createdByAi: true,
            });

            return {
                success: true,
                data: { id: task.id, title: task.title, cronExpression: task.cronExpression, nextRunAt: task.nextRunAt },
                displayText: `⏰ Задача создана: "${task.title}" (расписание: ${task.cronExpression}, следующий запуск: ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'рассчитывается'})`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка создания задачи: ${error?.message || error}`,
            };
        }
    },
};
