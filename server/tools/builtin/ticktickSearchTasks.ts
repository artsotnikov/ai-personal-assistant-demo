/**
 * Tool: ticktick_search_tasks — Поиск задач в TickTick по тексту
 * 
 * Ищет задачи по совпадению в названии, описании и подзадачах
 * среди всех проектов и Inbox.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface SearchTasksInput {
    query: string;
    showCompleted?: string;
}

export const ticktickSearchTasksTool: ToolDefinition<SearchTasksInput> = {
    name: 'ticktick_search_tasks',
    description: `Поиск задач в TickTick по текстовому запросу.
Ищет совпадения в названии, описании и подзадачах (case-insensitive).
Поиск автоматически включает задачи из ВСЕХ проектов и из папки «Входящие» (Inbox).
Используй, когда пользователь просит «найди задачу про X», «есть ли задача Y», «поищи в списке дел Z».

⚠️ ОБЯЗАТЕЛЬНО вызови этот инструмент ПЕРЕД любой операцией с задачей, если у тебя нет taskId и projectId.
НЕ ВЫДУМЫВАЙ taskId или projectId — сначала найди задачу через этот инструмент.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Текст для поиска (ищет в названии, описании и подзадачах)',
            },
            showCompleted: {
                type: 'string',
                description: 'Показывать завершённые задачи (по умолчанию false)',
                enum: ['true', 'false'],
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
            const showCompleted = input.showCompleted === 'true';
            const results = await tickTickService.searchTasks(input.query, showCompleted);

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: `🔍 По запросу «${input.query}» задач не найдено.`,
                };
            }

            return {
                success: true,
                data: results,
                displayText: tickTickService.formatTaskList(results, `Результаты поиска: «${input.query}»`),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка поиска задач: ${error?.message || error}`,
            };
        }
    },
};
