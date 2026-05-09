/**
 * Tool: ticktick_get_tasks — Получить задачи из TickTick
 * 
 * Получает задачи из конкретного проекта или все задачи из всех проектов.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService, type TickTickTask } from '../../services/tickTickService';

interface GetTasksInput {
    projectId?: string;
    dateFilter?: string;
    tags?: string[];
    minPriority?: number;
    search?: string;
    limit?: number;
    showCompleted?: boolean;
}

export const ticktickGetTasksTool: ToolDefinition<GetTasksInput> = {
    name: 'ticktick_get_tasks',
    description: `Получить отфильтрованные задачи из TickTick. 
Используй для показа списка дел, поиска конкретных задач по контексту или получения задач на сегодня/неделю.

📥 **ИНБОКС (Входящие)**:
- Чтобы посмотреть только входящие, передай projectId="inbox".
- Если projectId не указан — ищет по ВСЕМ проектам (включая Inbox).

📅 **ФИЛЬТРЫ ПО ДАТЕ (dateFilter)**:
- "today" — задачи на сегодня.
- "tomorrow" — задачи на завтра.
- "thisWeek" — задачи на ближайшие 7 дней.
- "overdue" — просроченные задачи.
- "noDate" — задачи без установленного срока.

🔍 **ДОПОЛНИТЕЛЬНО**:
- tags: список тегов через запятую (напр. ["работа", "срочно"]).
- search: текстовый поиск внутри результатов.
- minPriority: фильтр "не ниже чем" (1=низкий, 3=средний, 5=высокий).
- limit: ограничение количества (по умолчанию 30).

Сортировка: Сначала ВАЖНЫЕ (высокий приоритет), затем БЛИЖАЙШИЕ по сроку.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            projectId: {
                type: 'string',
                description: 'ID или название проекта (если не указан — поиск по всем проектам)',
            },
            dateFilter: {
                type: 'string',
                description: 'Фильтр по сроку выполнения',
                enum: ['today', 'tomorrow', 'thisWeek', 'overdue', 'noDate'],
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Список тегов для фильтрации (например, ["работа"])',
            },
            minPriority: {
                type: 'number',
                description: 'Минимальный приоритет (1=низкий, 3=средний, 5=высокий). Используй одно из значений: 0 (нет), 1 (низкий), 3 (средний), 5 (высокий).',
            },
            search: {
                type: 'string',
                description: 'Текстовый поиск в названии или описании',
            },
            limit: {
                type: 'number',
                description: 'Максимальное количество задач (по умолчанию 30)',
            },
            showCompleted: {
                type: 'boolean',
                description: 'Показывать ли завершённые задачи (по умолчанию false)',
            },
        },
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
            const tasks = await tickTickService.getTasksFiltered({
                projectId: input.projectId,
                dateFilter: input.dateFilter as any,
                tags: input.tags,
                minPriority: input.minPriority,
                search: input.search,
                limit: input.limit || 30,
                showCompleted: input.showCompleted,
            });

            // Форматируем заголовок для отображения
            let title = '📋 Список задач';
            if (input.dateFilter === 'today') title = '📅 Задачи на сегодня';
            else if (input.dateFilter === 'overdue') title = '🔴 Просроченные задачи';
            else if (input.projectId === 'inbox' || input.projectId === 'входящие') title = '📥 Входящие (Inbox)';

            return {
                success: true,
                data: tasks,
                displayText: tickTickService.formatTaskList(tasks, title),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка фильтрации задач TickTick: ${error?.message || error}`,
            };
        }
    },
};
