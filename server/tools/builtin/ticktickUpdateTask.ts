/**
 * Tool: ticktick_update_task — Обновить задачу в TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface UpdateTaskInput {
    taskId: string;
    projectId: string;
    title?: string;
    content?: string;
    priority?: string;
    dueDate?: string;
    isAllDay?: boolean;
    tags?: string;
    newProjectId?: string;
}

export const ticktickUpdateTaskTool: ToolDefinition<UpdateTaskInput> = {
    name: 'ticktick_update_task',
    description: `Обновить существующую задачу в TickTick. Можно изменить название, описание, приоритет, срок, теги.
Также можно ПЕРЕМЕСТИТЬ задачу в другой проект/список, указав newProjectId.

⚠️ КРИТИЧЕСКИ ВАЖНО:
- taskId и projectId ОБЯЗАТЕЛЬНЫ. Бери их ТОЛЬКО из результатов ticktick_get_tasks или ticktick_search_tasks.
- НИКОГДА не придумывай taskId или projectId. Если не знаешь — сначала используй ticktick_search_tasks.
- taskId и projectId видны в комментарии в результатах.

Для добавления подзадач (чеклист) используй инструмент ticktick_add_checklist_item.
Приоритеты: 0=нет, 1=низкий, 3=средний, 5=высокий.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'ID задачи для обновления',
            },
            projectId: {
                type: 'string',
                description: 'ID или название проекта, в котором сейчас находится задача',
            },
            title: {
                type: 'string',
                description: 'Новое название задачи',
            },
            content: {
                type: 'string',
                description: 'Новое описание задачи',
            },
            priority: {
                type: 'string',
                description: 'Новый приоритет: 0=нет, 1=низкий, 3=средний, 5=высокий',
                enum: ['0', '1', '3', '5'],
            },
            dueDate: {
                type: 'string',
                description: 'Новый срок в ISO 8601',
            },
            isAllDay: {
                type: 'boolean',
                description: 'Флаг задачи на весь день (без конкретного времени)',
            },
            tags: {
                type: 'string',
                description: 'Новые теги через запятую',
            },
            newProjectId: {
                type: 'string',
                description: 'ID или название проекта, в который переместить задачу (для перемещения между проектами/списками)',
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
            const tagList = input.tags
                ? input.tags.split(',').map(t => t.trim()).filter(Boolean)
                : undefined;

            // Умный поиск проектов по имени
            let resolvedProjectId = input.projectId;
            let resolvedNewProjectId = input.newProjectId;

            const needsResolve = (id?: string) => id && id.length < 20 && id !== 'inbox' && !id.startsWith('inbox');
            
            if (needsResolve(resolvedProjectId) || needsResolve(resolvedNewProjectId)) {
                const projects = await tickTickService.getProjects();
                const resolve = (id: string) => {
                    const term = id.toLowerCase();
                    if (term === 'inbox' || 'входящие'.includes(term)) {
                        // Inbox нужно запрашивать через getInboxTasks, но для update пробуем найти inbox id
                        const inboxProject = projects.find(p => p.name.toLowerCase().includes('inbox'));
                        return inboxProject?.id || id;
                    }
                    const matched = projects.find(p => p.name.toLowerCase() === term) ||
                                    projects.find(p => p.name.toLowerCase().includes(term));
                    return matched?.id || id;
                };
                if (needsResolve(resolvedProjectId)) resolvedProjectId = resolve(resolvedProjectId);
                if (needsResolve(resolvedNewProjectId)) resolvedNewProjectId = resolve(resolvedNewProjectId!);
            }

            const task = await tickTickService.updateTask({
                taskId: input.taskId,
                projectId: resolvedProjectId,
                title: input.title,
                content: input.content,
                priority: input.priority !== undefined ? Number(input.priority) : undefined,
                dueDate: input.dueDate,
                isAllDay: input.isAllDay,
                tags: tagList,
                newProjectId: resolvedNewProjectId,
            });

            const movedText = input.newProjectId ? '\n📦 Задача перемещена в другой проект.' : '';

            return {
                success: true,
                data: task,
                displayText: `✅ Задача обновлена:${movedText}\n\n${tickTickService.formatTask(task)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка обновления задачи: ${error?.message || error}`,
            };
        }
    },
};
