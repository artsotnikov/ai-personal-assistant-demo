/**
 * Smart Tool: ticktick_smart_update — Обновить задачу по текстовому описанию
 * 
 * Compound tool: автоматически ищет задачу → обновляет.
 * Один вызов вместо цепочки search → update.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface SmartUpdateInput {
    query: string;
    title?: string;
    content?: string;
    priority?: number;
    dueDate?: string;
    startDate?: string;
    isAllDay?: boolean;
    tags?: string[];
}

export const ticktickSmartUpdateTool: ToolDefinition<SmartUpdateInput> = {
    name: 'ticktick_smart_update',
    description: `🧠 SMART TOOL: Обновить задачу в TickTick по текстовому описанию.
Автоматически ИЩЕТ задачу по query и ОБНОВЛЯЕТ её — всё за один вызов.

Используй ЭТОТ инструмент, когда пользователь говорит:
- «измени задачу про X»
- «обнови описание задачи Y»  
- «поставь высокий приоритет задаче Z»
- «перенеси дедлайн задачи на завтра»

💡 Не нужно знать taskId/projectId — инструмент найдёт задачу сам по тексту.
Если найдено несколько задач — покажет список для уточнения.

Приоритеты: 0=нет, 1=низкий, 3=средний, 5=высокий.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Текст для поиска задачи (по названию, описанию, подзадачам)',
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
                type: 'number',
                description: 'Новый приоритет: 0=нет, 1=низкий, 3=средний, 5=высокий',
            },
            dueDate: {
                type: 'string',
                description: 'Новый дедлайн (ISO 8601)',
            },
            startDate: {
                type: 'string',
                description: 'Новая дата начала (ISO 8601)',
            },
            isAllDay: {
                type: 'boolean',
                description: 'Задачу на весь день (без конкретного времени)',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Новые теги задачи',
            },
        },
        required: ['query'],
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
            // Шаг 1: Поиск задачи
            let results = await tickTickService.searchTasks(input.query);
            results = results.filter(t => t.status !== 2); // только активные

            if (results.length === 0) {
                return {
                    success: false,
                    error: 'Задача не найдена',
                    displayText: `🔍 Задача по запросу «${input.query}» не найдена. Попробуй другой запрос.`,
                };
            }

            // Шаг 2: Disambiguation — если найдено несколько
            if (results.length > 1) {
                return {
                    success: true,
                    data: { ambiguous: true, candidates: results },
                    displayText: `🔍 По запросу «${input.query}» найдено ${results.length} задач — уточни какую обновить:\n\n${tickTickService.formatTaskList(results, 'Найденные задачи')}`,
                };
            }

            // Шаг 3: Один результат — обновляем
            const task = results[0];
            const updated = await tickTickService.updateTask({
                taskId: task.id,
                projectId: task.projectId,
                title: input.title,
                content: input.content,
                priority: input.priority,
                dueDate: input.dueDate,
                startDate: input.startDate,
                isAllDay: input.isAllDay,
                tags: input.tags,
            });

            return {
                success: true,
                data: updated,
                displayText: `✅ Задача обновлена:\n\n${tickTickService.formatTask(updated)}`,
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
