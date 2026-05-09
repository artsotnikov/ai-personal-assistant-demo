/**
 * Tool: ticktick_get_projects — Получить список проектов (списков) TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

export const ticktickGetProjectsTool: ToolDefinition = {
    name: 'ticktick_get_projects',
    description: `Получить список всех проектов (списков) из TickTick.
Используй, когда пользователь спрашивает о своих проектах, списках задач, или нужен projectId для другого tool.

📥 Примечание: TickTick API может не возвращать папку «Входящие» (Inbox) в общем списке проектов.
Если нужны задачи из Inbox — используй ticktick_get_tasks с projectId="inbox".`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },

    handler: async (_input, _ctx): Promise<ToolResult> => {
        if (!tickTickService.isAuthenticated()) {
            return {
                success: false,
                error: 'TickTick не подключён',
                displayText: '❌ TickTick не подключён. Попросите пользователя авторизоваться через настройки.',
            };
        }

        try {
            const projects = await tickTickService.getProjects();
            
            // Добавляем Inbox если его нет в списке (API обычно не возвращает его)
            const hasInbox = projects.some(p => p.id.startsWith('inbox'));
            if (!hasInbox) {
                const inboxId = await tickTickService.getInboxId();
                if (inboxId) {
                    projects.unshift({
                        id: inboxId,
                        name: '📥 Входящие (Inbox)',
                        color: '',
                        sortOrder: -1,
                    } as any);
                }
            }
            
            return {
                success: true,
                data: projects,
                displayText: tickTickService.formatProjectList(projects),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка получения проектов TickTick: ${error?.message || error}`,
            };
        }
    },
};
