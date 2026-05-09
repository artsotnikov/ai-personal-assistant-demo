/**
 * Smart Tool: ticktick_smart_add_checklist — Добавить подзадачу по текстовому описанию
 * 
 * Compound tool: автоматически ищет задачу → добавляет подзадачу.
 * Один вызов вместо цепочки search → add_checklist_item.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface SmartAddChecklistInput {
    query: string;
    items: string[];
}

export const ticktickSmartAddChecklistTool: ToolDefinition<SmartAddChecklistInput> = {
    name: 'ticktick_smart_add_checklist',
    description: `🧠 SMART TOOL: Добавить подзадачу (чеклист) к задаче по текстовому описанию.
Автоматически ИЩЕТ задачу по query и ДОБАВЛЯЕТ подзадачи — всё за один вызов.

Используй ЭТОТ инструмент, когда пользователь говорит:
- «добавь подзадачу к задаче про X»
- «добавь пункт Y в задачу Z»
- «в задаче про прогулку добавь: купить цветы»

💡 Не нужно знать taskId/projectId — инструмент найдёт задачу сам по тексту.
items — массив подзадач (можно несколько за раз).`,
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
            items: {
                type: 'array',
                items: { type: 'string' },
                description: 'Подзадачи для добавления (текст каждого пункта)',
            },
        },
        required: ['query', 'items'],
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
            results = results.filter(t => t.status !== 2);

            if (results.length === 0) {
                return {
                    success: false,
                    error: 'Задача не найдена',
                    displayText: `🔍 Задача по запросу «${input.query}» не найдена. Попробуй другой запрос.`,
                };
            }

            // Шаг 2: Disambiguation
            if (results.length > 1) {
                return {
                    success: true,
                    data: { ambiguous: true, candidates: results },
                    displayText: `🔍 По запросу «${input.query}» найдено ${results.length} задач — уточни к какой добавить подзадачи:\n\n${tickTickService.formatTaskList(results, 'Найденные задачи')}`,
                };
            }

            // Шаг 3: Один результат — добавляем подзадачи
            const task = results[0];
            let updated = task;
            for (const itemTitle of input.items) {
                updated = await tickTickService.addChecklistItem(
                    task.projectId,
                    task.id,
                    itemTitle,
                );
            }

            const addedList = input.items.map(i => `  ☐ ${i}`).join('\n');
            return {
                success: true,
                data: updated,
                displayText: `✅ Подзадачи добавлены к «${task.title}»:\n${addedList}\n\n${tickTickService.formatTask(updated)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка добавления подзадач: ${error?.message || error}`,
            };
        }
    },
};
