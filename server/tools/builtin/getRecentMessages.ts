/**
 * Tool: get_recent_messages — Получить последние сообщения из чата
 * 
 * Прямой SQL через drizzle к таблице messages.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { messages } from '@shared/schema';
import { desc, eq, and } from 'drizzle-orm';

interface GetRecentMessagesInput {
    limit?: number;
    sender?: string;
}

export const getRecentMessagesTool: ToolDefinition<GetRecentMessagesInput> = {
    name: 'get_recent_messages',
    description: `Получить последние сообщения из чата. Используй когда нужно вспомнить контекст недавнего разговора, проверить что обсуждали ранее, или найти конкретную информацию в истории чата.`,
    category: 'memory',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            limit: {
                type: 'number',
                description: 'Количество последних сообщений (по умолчанию 20)',
            },
            sender: {
                type: 'string',
                description: 'Фильтр по отправителю',
                enum: ['user', 'assistant', 'all'],
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const limit = input.limit || 20;
            const sender = input.sender || 'all';

            let results;
            if (sender !== 'all') {
                // Маппим 'assistant' → 'ai' (в схеме sender = 'user' | 'ai' | 'system')
                const dbSender = sender === 'assistant' ? 'ai' : sender;
                results = await db.select().from(messages)
                    .where(eq(messages.sender, dbSender))
                    .orderBy(desc(messages.timestamp))
                    .limit(limit);
            } else {
                results = await db.select().from(messages)
                    .orderBy(desc(messages.timestamp))
                    .limit(limit);
            }

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: 'Сообщений не найдено.',
                };
            }

            // Переворачиваем для хронологического порядка
            const chronological = results.reverse();

            const messagesText = chronological
                .map((m, i) => {
                    const senderLabel = m.sender === 'ai' ? 'Ассистент' : m.sender === 'user' ? 'Пользователь' : 'Система';
                    const preview = m.content.length > 150 ? m.content.substring(0, 150) + '...' : m.content;
                    return `[${senderLabel}] ${preview}`;
                })
                .join('\n');

            return {
                success: true,
                data: chronological.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    content: m.content,
                    timestamp: m.timestamp,
                    type: m.type,
                })),
                displayText: `Последние ${chronological.length} сообщений:\n${messagesText}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения сообщений: ${error?.message || error}`,
            };
        }
    },
};
