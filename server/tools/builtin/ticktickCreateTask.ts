/**
 * Tool: ticktick_create_task — Создать задачу в TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface CreateTaskInput {
    title: string;
    content?: string;
    projectId?: string;
    priority?: string;
    dueDate?: string;
    tags?: string;
    isAllDay?: boolean;
}

export const ticktickCreateTaskTool: ToolDefinition<CreateTaskInput> = {
    name: 'ticktick_create_task',
    description: `Создать новую задачу в TickTick (планировщике задач пользователя).

⚠️ Используй ТОЛЬКО если пользователь ЯВНО попросил: «поставь задачу», «добавь в список дел», 
«запиши задачу», «создай задачу», «напомни сделать X» и подобные явные просьбы.
НЕ создавай задачи по своей инициативе.

Приоритеты: 0=нет (по умолчанию), 1=низкий, 3=средний, 5=высокий.
Дата в ISO 8601: «2026-03-28T15:00:00+03:00».
Если projectId не указан — задача создаётся во входящих (Inbox).`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Название задачи',
            },
            content: {
                type: 'string',
                description: 'Описание/заметки к задаче (опционально)',
            },
            projectId: {
                type: 'string',
                description: 'ID или название проекта. Если не указан — задача попадёт во «Входящие» (Inbox)',
            },
            priority: {
                type: 'string',
                description: 'Приоритет: 0=нет, 1=низкий, 3=средний, 5=высокий',
                enum: ['0', '1', '3', '5'],
            },
            dueDate: {
                type: 'string',
                description: 'Срок выполнения в ISO 8601, например «2026-03-30T10:00:00+03:00»',
            },
            isAllDay: {
                type: 'boolean',
                description: 'Флаг задачи на весь день (без конкретного времени)',
            },
            tags: {
                type: 'string',
                description: 'Теги через запятую, например «работа, важное»',
            },
        },
        required: ['title'],
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
            const tagList = input.tags
                ? input.tags.split(',').map(t => t.trim()).filter(Boolean)
                : undefined;

            let targetProjectId = input.projectId;

            // Умный поиск проекта по имени, если передан не точный ID
            if (targetProjectId && targetProjectId.length < 20 && !targetProjectId.startsWith('inbox') && targetProjectId !== 'inbox') {
                const projects = await tickTickService.getProjects();
                const searchTerm = targetProjectId.toLowerCase();
                
                // Ищем точное или частичное совпадение
                const matched = projects.find(p => p.name.toLowerCase() === searchTerm) || 
                                projects.find(p => p.name.toLowerCase().includes(searchTerm));
                
                if (matched) {
                    targetProjectId = matched.id;
                } else if (searchTerm === 'входящие' || searchTerm === 'inbox' || searchTerm === 'вход' || 'входящие'.startsWith(searchTerm)) {
                    targetProjectId = undefined; // TickTickService создает в Inbox если projectId === undefined
                } else {
                    // Если проект не найден, создаем во входящих, но сообщаем об этом
                    console.warn(`[ticktick_create_task] Проект "${targetProjectId}" не найден, задача будет создана во "Входящие"`);
                    targetProjectId = undefined;
                }
            } else if (targetProjectId === 'inbox') {
                targetProjectId = undefined;
            }

            const task = await tickTickService.createTask({
                title: input.title,
                content: input.content,
                projectId: targetProjectId,
                priority: input.priority ? Number(input.priority) : 0,
                dueDate: input.dueDate,
                isAllDay: input.isAllDay,
                tags: tagList,
            });

            const projectLabel = task.projectId ? `проект: \`${task._projectName || task.projectId}\`` : 'Входящие (Inbox)';
            return {
                success: true,
                data: task,
                displayText: `✅ Задача создана в TickTick (${projectLabel}):\n\n${tickTickService.formatTask(task)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка создания задачи: ${error?.message || error}`,
            };
        }
    },
};
