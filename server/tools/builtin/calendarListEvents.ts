/**
 * Tool: calendar_list_events — Получить события из Google Календаря
 * 
 * Делегирует вызов MCP серверу google-calendar через mcpClientService.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { mcpClientService } from '../../services/mcpClientService';
import { ensureCalendarConnected } from './calendarHelpers';

interface CalendarListEventsInput {
    timeMin: string;
    timeMax: string;
    query?: string;
    calendarId?: string;
    maxResults?: number;
}

export const calendarListEventsTool: ToolDefinition<CalendarListEventsInput> = {
    name: 'calendar_list_events',
    description: `Получить события из Google Календаря за указанный период.
Используй когда пользователь спрашивает о событиях, встречах, расписании.
Время указывай в ISO 8601 с таймзоной +03:00 (Москва).`,
    category: 'planning',
    toolPack: 'calendar',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            timeMin: {
                type: 'string',
                description: 'Начало периода в ISO 8601, например "2026-03-23T00:00:00+03:00"',
            },
            timeMax: {
                type: 'string',
                description: 'Конец периода в ISO 8601, например "2026-03-24T00:00:00+03:00"',
            },
            query: {
                type: 'string',
                description: 'Текстовый поиск по событиям (опционально)',
            },
            calendarId: {
                type: 'string',
                description: 'ID календаря (по умолчанию "primary")',
            },
            maxResults: {
                type: 'string',
                description: 'Максимум событий (по умолчанию 20)',
            },
        },
        required: ['timeMin', 'timeMax'],
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
            const result = await mcpClientService.callTool('google-calendar', 'list_events', {
                timeMin: input.timeMin,
                timeMax: input.timeMax,
                query: input.query,
                calendarId: input.calendarId,
                maxResults: input.maxResults,
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
                displayText: `Ошибка получения событий: ${error?.message || error}`,
            };
        }
    },
};
