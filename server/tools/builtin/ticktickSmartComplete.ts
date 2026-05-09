/**
 * Smart Tool: ticktick_smart_complete — Завершить задачу по текстовому описанию
 * 
 * Compound tool: автоматически ищет задачу → завершает.
 * Один вызов вместо цепочки search → complete.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface SmartCompleteInput {
    query: string;
}

export const ticktickSmartCompleteTool: ToolDefinition<SmartCompleteInput> = {
    name: 'ticktick_smart_complete',
    description: `🧠 SMART TOOL: Завершить задачу в TickTick по текстовому описанию.
Автоматически ИЩЕТ задачу по query и ЗАВЕРШАЕТ её — всё за один вызов.

Используй ЭТОТ инструмент, когда пользователь говорит:
- «выполнил задачу про X»
- «закрой задачу Y»
- «задача Z — готово»
- «сделал дело про W»

💡 Не нужно знать taskId/projectId — инструмент найдёт задачу сам по тексту.
Если найдено несколько задач — покажет список для уточнения.`,
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
                    displayText: `🔍 По запросу «${input.query}» найдено ${results.length} задач — уточни какую завершить:\n\n${tickTickService.formatTaskList(results, 'Найденные задачи')}`,
                };
            }

            // Шаг 3: Один результат — завершаем
            const task = results[0];
            await tickTickService.completeTask(task.projectId, task.id);

            return {
                success: true,
                data: { taskId: task.id, projectId: task.projectId, title: task.title },
                displayText: `✅ Задача «${task.title}» отмечена как выполненная!`,
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
