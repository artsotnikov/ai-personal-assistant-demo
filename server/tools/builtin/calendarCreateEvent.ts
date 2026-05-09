/**
 * Tool: calendar_create_event — Создать событие в Google Календаре
 * 
 * Делегирует вызов MCP серверу google-calendar через mcpClientService.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { mcpClientService } from '../../services/mcpClientService';
import { ensureCalendarConnected } from './calendarHelpers';

interface CalendarCreateEventInput {
    summary: string;
    startTime: string;
    endTime: string;
    description?: string;
    location?: string;
    calendarId?: string;
}

export const calendarCreateEventTool: ToolDefinition<CalendarCreateEventInput> = {
    name: 'calendar_create_event',
    description: `Создать новое событие в Google Календаре.

⚠️ СТРОГО ЗАПРЕЩЕНО вызывать этот инструмент по своей инициативе!
Используй ТОЛЬКО если пользователь ЯВНО попросил: «запиши в календарь», «создай событие», «добавь встречу», «поставь напоминание в календарь».
Если пользователь просто упоминает встречу или событие в разговоре — НЕ записывай в календарь без прямой просьбы.
Время указывай в ISO 8601 с таймзоной +03:00 (Москва).`,
    category: 'planning',
    toolPack: 'calendar',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'Название события',
            },
            startTime: {
                type: 'string',
                description: 'Начало события в ISO 8601, например "2026-03-24T15:00:00+03:00"',
            },
            endTime: {
                type: 'string',
                description: 'Конец события в ISO 8601, например "2026-03-24T16:00:00+03:00"',
            },
            description: {
                type: 'string',
                description: 'Описание события (опционально)',
            },
            location: {
                type: 'string',
                description: 'Место проведения (опционально)',
            },
            calendarId: {
                type: 'string',
                description: 'ID календаря (по умолчанию "primary")',
            },
        },
        required: ['summary', 'startTime', 'endTime'],
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
            const result = await mcpClientService.callTool('google-calendar', 'create_event', {
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
                displayText: `Ошибка создания события: ${error?.message || error}`,
            };
        }
    },
};
