/**
 * MCP Client Service — Универсальный клиент для подключения к MCP серверам
 * 
 * Singleton-сервис. Может подключаться к нескольким MCP серверам одновременно.
 * Каждый сервер спавнится как child process и общается через stdio.
 * 
 * Использование:
 *   mcpClientService.connect({ name: 'google-calendar', command: 'node', args: ['...'] })
 *   mcpClientService.callTool('google-calendar', 'list_events', { timeMin, timeMax })
 *   mcpClientService.disconnect('google-calendar')
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ============================================================================
// Types
// ============================================================================

export interface MCPServerConfig {
    /** Уникальное имя сервера (например 'google-calendar') */
    name: string;
    /** Команда для запуска (например 'node' или 'npx') */
    command: string;
    /** Аргументы команды */
    args: string[];
    /** Переменные окружения для child process */
    env?: Record<string, string>;
    /** Включён ли сервер */
    enabled: boolean;
}

export interface MCPToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}

interface MCPConnection {
    client: Client;
    transport: StdioClientTransport;
    config: MCPServerConfig;
    tools: MCPToolInfo[];
    connectedAt: Date;
}

export interface MCPCallResult {
    success: boolean;
    content: string;
    isError?: boolean;
    raw?: unknown;
}

// ============================================================================
// Service
// ============================================================================

class MCPClientService {
    private connections = new Map<string, MCPConnection>();

    /**
     * Подключиться к MCP серверу
     */
    async connect(config: MCPServerConfig): Promise<MCPToolInfo[]> {
        if (!config.enabled) {
            console.log(`[MCPClient] ⏭️ Сервер "${config.name}" отключён (enabled=false)`);
            return [];
        }

        // Если уже подключены — отключаемся
        if (this.connections.has(config.name)) {
            console.log(`[MCPClient] 🔄 Переподключение к "${config.name}"...`);
            await this.disconnect(config.name);
        }

        try {
            const client = new Client(
                { name: `ai-assistant-${config.name}`, version: '1.0.0' },
                { capabilities: {} }
            );

            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: {
                    ...process.env,
                    ...config.env,
                } as Record<string, string>,
            });

            await client.connect(transport);

            // Получаем список инструментов
            const toolsResult = await client.listTools();
            const tools: MCPToolInfo[] = (toolsResult.tools || []).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            }));

            this.connections.set(config.name, {
                client,
                transport,
                config,
                tools,
                connectedAt: new Date(),
            });

            console.log(
                `[MCPClient] ✅ Подключён к "${config.name}" — tools: [${tools.map(t => t.name).join(', ')}]`
            );

            return tools;
        } catch (error: any) {
            console.error(`[MCPClient] ❌ Ошибка подключения к "${config.name}":`, error?.message || error);
            throw error;
        }
    }

    /**
     * Вызвать инструмент на MCP сервере
     */
    async callTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<MCPCallResult> {
        const connection = this.connections.get(serverName);
        if (!connection) {
            return {
                success: false,
                content: `MCP сервер "${serverName}" не подключён`,
                isError: true,
            };
        }

        try {
            const result = await connection.client.callTool({
                name: toolName,
                arguments: args,
            });

            // Извлекаем текст из content
            const contentParts = (result.content as Array<{ type: string; text?: string }>) || [];
            const text = contentParts
                .filter(part => part.type === 'text')
                .map(part => part.text || '')
                .join('\n');

            return {
                success: !result.isError,
                content: text || 'Нет данных',
                isError: !!result.isError,
                raw: result,
            };
        } catch (error: any) {
            console.error(`[MCPClient] ❌ Ошибка вызова ${serverName}.${toolName}:`, error?.message || error);

            // Определяем, нужна ли попытка реконнекта
            const errorMsg = String(error?.message || '').toLowerCase();
            const needsReconnect = 
                errorMsg.includes('closed') || 
                errorMsg.includes('disconnected') ||
                errorMsg.includes('epipe') ||
                errorMsg.includes('spawn') ||
                errorMsg.includes('exit') ||
                errorMsg.includes('killed') ||
                errorMsg.includes('econnreset') ||
                errorMsg.includes('channel') ||
                errorMsg.includes('transport');

            if (needsReconnect) {
                console.log(`[MCPClient] 🔄 Попытка реконнекта к "${serverName}" (причина: ${errorMsg.substring(0, 80)})...`);
                try {
                    await this.connect(connection.config);
                    // Повторный вызов после реконнекта
                    return await this.callTool(serverName, toolName, args);
                } catch (reconnectError: any) {
                    console.error(`[MCPClient] ❌ Реконнект не удался:`, reconnectError?.message);
                }
            }

            return {
                success: false,
                content: `Ошибка MCP: ${error?.message || error}`,
                isError: true,
            };
        }
    }

    /**
     * Получить список инструментов сервера
     */
    getTools(serverName: string): MCPToolInfo[] {
        return this.connections.get(serverName)?.tools || [];
    }

    /**
     * Проверить, подключён ли сервер
     */
    isConnected(serverName: string): boolean {
        return this.connections.has(serverName);
    }

    /**
     * Получить список всех подключённых серверов
     */
    getAllConnectedServers(): Array<{ name: string; tools: string[]; connectedAt: Date }> {
        return Array.from(this.connections.entries()).map(([name, conn]) => ({
            name,
            tools: conn.tools.map(t => t.name),
            connectedAt: conn.connectedAt,
        }));
    }

    /**
     * Отключиться от сервера
     */
    async disconnect(serverName: string): Promise<void> {
        const connection = this.connections.get(serverName);
        if (!connection) return;

        try {
            await connection.client.close();
            console.log(`[MCPClient] 🔌 Отключён от "${serverName}"`);
        } catch (error: any) {
            console.error(`[MCPClient] ⚠️ Ошибка отключения от "${serverName}":`, error?.message);
        } finally {
            this.connections.delete(serverName);
        }
    }

    /**
     * Отключиться от всех серверов
     */
    async disconnectAll(): Promise<void> {
        const names = Array.from(this.connections.keys());
        for (const name of names) {
            await this.disconnect(name);
        }
        console.log(`[MCPClient] 🔌 Все MCP серверы отключены`);
    }
}

/** Глобальный singleton */
export const mcpClientService = new MCPClientService();
