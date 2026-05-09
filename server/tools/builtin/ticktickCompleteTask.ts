/**
 * Tool: ticktick_complete_task — Завершить задачу в TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface CompleteTaskInput {
    taskId: string;
    projectId: string;
}

export const ticktickCompleteTaskTool: ToolDefinition<CompleteTaskInput> = {
    name: 'ticktick_complete_task',
    description: `Отметить задачу как выполненную в TickTick.

Используй, когда пользователь говорит: «задача выполнена», «отметь как сделано», «закрой задачу», «завершил X».
Для вызова нужны taskId и projectId — используй ticktick_get_tasks, чтобы узнать их.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'ID задачи для завершения',
            },
            projectId: {
                type: 'string',
                description: 'ID проекта, в котором находится задача',
            },
        },
        required: ['taskId', 'projectId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        if (!tickTickService.isAuthenticated()) {
            return {
                success: false,
                error: 'TickTick не подключён',
                displayText: '❌ TickTick не подключён. Попросите пользователя авторизоваться через настройки.',
            };
        }

        try {
            // Сначала получаем задачу, чтобы показать название
            let taskTitle = input.taskId;
            try {
                const task = await tickTickService.getTask(input.projectId, input.taskId);
                taskTitle = task.title;
            } catch {
                // Если не удалось получить — используем ID
            }

            await tickTickService.completeTask(input.projectId, input.taskId);

            return {
                success: true,
                data: { taskId: input.taskId, projectId: input.projectId },
                displayText: `✅ Задача «${taskTitle}» отмечена как выполненная!`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка завершения задачи: ${error?.message || error}`,
            };
        }
    },
};
