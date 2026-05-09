/**
 * Tool: ticktick_add_checklist_item — Добавить подзадачу к задаче в TickTick
 * 
 * Добавляет элемент чеклиста (подзадачу) к существующей задаче.
 * Требует taskId и projectId — используй ticktick_search_tasks для нахождения.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface AddChecklistItemInput {
    taskId: string;
    projectId: string;
    title: string;
}

export const ticktickAddChecklistItemTool: ToolDefinition<AddChecklistItemInput> = {
    name: 'ticktick_add_checklist_item',
    description: `Добавить подзадачу (элемент чеклиста) к существующей задаче в TickTick.

Используй, когда пользователь просит: «добавь подпункт», «добавь подзадачу», «добавь к задаче X пункт Y».

⚠️ КРИТИЧЕСКИ ВАЖНО:
- Для вызова ОБЯЗАТЕЛЬНО нужны реальные taskId и projectId.
- Если у тебя нет taskId/projectId — СНАЧАЛА используй ticktick_search_tasks, чтобы найти задачу.
- НИКОГДА не придумывай taskId или projectId. Бери ТОЛЬКО из результатов ticktick_search_tasks или ticktick_get_tasks.
- taskId и projectId видны в комментарии <!-- id: ... | proj: ... --> в результатах.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: {
                type: 'string',
                description: 'ID задачи, к которой добавить подзадачу',
            },
            projectId: {
                type: 'string',
                description: 'ID проекта, в котором находится задача',
            },
            title: {
                type: 'string',
                description: 'Текст подзадачи (элемента чеклиста)',
            },
        },
        required: ['taskId', 'projectId', 'title'],
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
            const updated = await tickTickService.addChecklistItem(
                input.projectId,
                input.taskId,
                input.title,
            );

            return {
                success: true,
                data: updated,
                displayText: `✅ Подзадача добавлена:\n\n${tickTickService.formatTask(updated)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка добавления подзадачи: ${error?.message || error}`,
            };
        }
    },
};
