/**
 * Tool: ticktick_delete_task — Удалить задачу из TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface DeleteTaskInput {
    taskId: string;
    projectId: string;
}

export const ticktickDeleteTaskTool: ToolDefinition<DeleteTaskInput> = {
    name: 'ticktick_delete_task',
    description: `Удалить задачу из TickTick.
Используй, когда пользователь просит удалить задачу (не завершить, а именно удалить).
taskId и projectId видны в списке задач (скрытый комментарий <!-- id: ... | proj: ... -->).
projectId может быть как ID, так и НАЗВАНИЕМ проекта.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'ID задачи для удаления',
            },
            projectId: {
                type: 'string',
                description: 'ID или название проекта, в котором находится задача',
            },
        },
        required: ['taskId', 'projectId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        if (!tickTickService.isAuthenticated()) {
            return {
                success: false,
                error: 'TickTick не подключён',
                displayText: '❌ TickTick не подключён.',
            };
        }

        try {
            // Умный поиск проекта по имени
            let resolvedProjectId = input.projectId;
            if (resolvedProjectId && resolvedProjectId.length < 20 && resolvedProjectId !== 'inbox' && !resolvedProjectId.startsWith('inbox')) {
                const projects = await tickTickService.getProjects();
                const term = resolvedProjectId.toLowerCase();
                const matched = projects.find(p => p.name.toLowerCase() === term) ||
                                projects.find(p => p.name.toLowerCase().includes(term));
                if (matched) resolvedProjectId = matched.id;
            }

            let taskTitle = input.taskId;
            try {
                const task = await tickTickService.getTask(resolvedProjectId, input.taskId);
                taskTitle = task.title;
            } catch { /* fallback to ID */ }

            await tickTickService.deleteTask(resolvedProjectId, input.taskId);

            return {
                success: true,
                data: { taskId: input.taskId, projectId: input.projectId },
                displayText: `✅ Задача «${taskTitle}» удалена.`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка удаления задачи: ${error?.message || error}`,
            };
        }
    },
};
