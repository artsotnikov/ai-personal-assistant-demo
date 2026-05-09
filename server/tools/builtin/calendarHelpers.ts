/**
 * Calendar Tools — общие хелперы
 * 
 * Auto-reconnect к MCP серверу google-calendar при обнаружении разрыва.
 */

import { mcpClientService } from '../../services/mcpClientService';
import { getCalendarMCPConfig } from '../../agentOrchestrator';

const MCP_SERVER_NAME = 'google-calendar';

/**
 * Проверяет подключение к MCP Calendar серверу.
 * Если сервер не подключён, но конфигурация есть — пытается переподключиться.
 * 
 * @returns true если подключён (или переподключился), false если невозможно
 */
export async function ensureCalendarConnected(): Promise<{ connected: boolean; error?: string }> {
    // Уже подключён
    if (mcpClientService.isConnected(MCP_SERVER_NAME)) {
        return { connected: true };
    }

    // Пытаемся переподключиться
    const config = getCalendarMCPConfig();
    if (!config) {
        return {
            connected: false,
            error: 'Google Calendar MCP не настроен (MCP_GOOGLE_CALENDAR_ENABLED != true)',
        };
    }

    try {
        console.log(`[CalendarTools] 🔄 Авто-реконнект к "${MCP_SERVER_NAME}"...`);
        await mcpClientService.connect(config);
        console.log(`[CalendarTools] ✅ Реконнект успешен`);
        return { connected: true };
    } catch (error: any) {
        console.error(`[CalendarTools] ❌ Реконнект не удался:`, error?.message);
        return {
            connected: false,
            error: `Google Calendar MCP не подключён. Авто-реконнект не удался: ${error?.message}`,
        };
    }
}
