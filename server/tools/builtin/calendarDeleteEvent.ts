/**
 * Tool: calendar_delete_event — Удалить событие из Google Календаря
 * 
 * Делегирует вызов MCP серверу google-calendar через mcpClientService.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { mcpClientService } from '../../services/mcpClientService';
import { ensureCalendarConnected } from './calendarHelpers';

interface CalendarDeleteEventInput {
    eventId: string;
    calendarId?: string;
}

export const calendarDeleteEventTool: ToolDefinition<CalendarDeleteEventInput> = {
    name: 'calendar_delete_event',
    description: `Удалить событие из Google Календаря.

⚠️ СТРОГО ЗАПРЕЩЕНО вызывать этот инструмент по своей инициативе!
Используй ТОЛЬКО если пользователь ЯВНО попросил: «удали событие», «отмени встречу», «убери из календаря».
Никогда не удаляй события без прямой просьбы пользователя.
Для удаления нужен eventId — его можно получить через calendar_list_events.`,
    category: 'planning',
    toolPack: 'calendar',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            eventId: {
                type: 'string',
                description: 'ID события для удаления (можно получить через calendar_list_events)',
            },
            calendarId: {
                type: 'string',
                description: 'ID календаря (по умолчанию "primary")',
            },
        },
        required: ['eventId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        // Авто-реконнект если MCP сервер не подключён
        const { connected, error: connectError } = await ensureCalendarConnected();
        if (!connected) {
            return {
                success: false,
                error: connectError || 'Google Calendar MCP сервер не подключён',
                displayText: `❌ ${connectError || 'Google Calendar не подключён. Проверьте настройки MCP_GOOGLE_CALENDAR_ENABLED.'}`,
            };
        }

        try {
            const result = await mcpClientService.callTool('google-calendar', 'delete_event', {
                eventId: input.eventId,
                calendarId: input.calendarId,
            });

            return {
                success: result.success,
                data: result.raw,
                error: result.isError ? result.content : undefined,
                displayText: result.content,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления события: ${error?.message || error}`,
            };
        }
    },
};
