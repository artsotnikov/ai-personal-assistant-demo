/**
 * Tool: calendar_update_event — Обновить событие в Google Календаре
 * 
 * Делегирует вызов MCP серверу google-calendar через mcpClientService.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { mcpClientService } from '../../services/mcpClientService';
import { ensureCalendarConnected } from './calendarHelpers';

interface CalendarUpdateEventInput {
    eventId: string;
    summary?: string;
    startTime?: string;
    endTime?: string;
    description?: string;
    location?: string;
    calendarId?: string;
}

export const calendarUpdateEventTool: ToolDefinition<CalendarUpdateEventInput> = {
    name: 'calendar_update_event',
    description: `Обновить существующее событие в Google Календаре.

⚠️ СТРОГО ЗАПРЕЩЕНО вызывать этот инструмент по своей инициативе!
Используй ТОЛЬКО если пользователь ЯВНО попросил: «перенеси встречу», «измени событие», «обнови время».
Никогда не изменяй события в календаре без прямой просьбы пользователя.
Для обновления нужен eventId — его можно получить через calendar_list_events.`,
    category: 'planning',
    toolPack: 'calendar',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            eventId: {
                type: 'string',
                description: 'ID события (можно получить через calendar_list_events)',
            },
            summary: {
                type: 'string',
                description: 'Новое название события (опционально)',
            },
            startTime: {
                type: 'string',
                description: 'Новое время начала в ISO 8601 (опционально)',
            },
            endTime: {
                type: 'string',
                description: 'Новое время окончания в ISO 8601 (опционально)',
            },
            description: {
                type: 'string',
                description: 'Новое описание (опционально)',
            },
            location: {
                type: 'string',
                description: 'Новое место (опционально)',
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
            const result = await mcpClientService.callTool('google-calendar', 'update_event', {
                eventId: input.eventId,
                summary: input.summary,
                startTime: input.startTime,
                endTime: input.endTime,
                description: input.description,
                location: input.location,
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
                displayText: `Ошибка обновления события: ${error?.message || error}`,
            };
        }
    },
};
