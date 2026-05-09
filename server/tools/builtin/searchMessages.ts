/**
 * Tool: search_messages — Семантический поиск по истории сообщений
 * 
 * Hybrid Search: Vector (семантическое сходство) + FTS (точное совпадение слов)
 * Возвращает найденные сообщения с окружающим контекстом (±2 соседних сообщения).
 */

import type { ToolDefinition, ToolResult } from '../types';
import { hybridSearchMessages } from '../../embeddingService';
import { db } from '../../db';
import { messages } from '@shared/schema';
import { and, gte, lte, asc } from 'drizzle-orm';

interface SearchMessagesInput {
    query: string;
    sender?: 'user' | 'assistant' | 'all';
    limit?: number;
    includeContext?: boolean;
}

/**
 * Подгружает ±contextWindow соседних сообщений для каждого найденного
 */
async function loadContextMessages(
    messageIds: number[],
    contextWindow: number = 2
): Promise<Map<number, { before: any[]; after: any[] }>> {
    const contextMap = new Map<number, { before: any[]; after: any[] }>();

    for (const id of messageIds) {
        try {
            // Сообщения ДО найденного
            const before = await db.select({
                id: messages.id,
                content: messages.content,
                sender: messages.sender,
                timestamp: messages.timestamp,
            })
                .from(messages)
                .where(
                    and(
                        lte(messages.id, id - 1),
                        gte(messages.id, id - contextWindow),
                    )
                )
                .orderBy(asc(messages.id));

            // Сообщения ПОСЛЕ найденного
            const after = await db.select({
                id: messages.id,
                content: messages.content,
                sender: messages.sender,
                timestamp: messages.timestamp,
            })
                .from(messages)
                .where(
                    and(
                        gte(messages.id, id + 1),
                        lte(messages.id, id + contextWindow),
                    )
                )
                .orderBy(asc(messages.id));

            contextMap.set(id, { before, after });
        } catch (e) {
            contextMap.set(id, { before: [], after: [] });
        }
    }

    return contextMap;
}

export const searchMessagesTool: ToolDefinition<SearchMessagesInput> = {
    name: 'search_messages',
    description:
        'Поиск по всей истории сообщений чата (семантический + полнотекстовый). ' +
        'Используй когда пользователь хочет вспомнить прошлый разговор, найти конкретное сообщение, ' +
        'или спрашивает "помнишь, мы обсуждали...", "напомни текст...", "что я говорил про...". ' +
        'Возвращает найденные сообщения с окружающим контекстом для понимания диалога. ' +
        'НЕ используй для получения последних сообщений — для этого есть get_recent_messages.',
    category: 'memory',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    timeout: 45_000, // hybrid: embedding (10с+10с fallback) + pgvector + FTS + context loading
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос — тема, ключевые слова или описание того, что ищем',
            },
            sender: {
                type: 'string',
                enum: ['user', 'assistant', 'all'],
                description: 'Фильтр по отправителю: user (только пользователь), assistant (только ИИ), all (все). По умолчанию all.',
            },
            limit: {
                type: 'number',
                description: 'Максимум результатов (по умолчанию 5, максимум 15)',
            },
            includeContext: {
                type: 'string',
                description: 'Подгружать ±2 соседних сообщения для контекста (по умолчанию true)',
            },
        },
        required: ['query'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        const { query, sender = 'all', limit: rawLimit = 5, includeContext = true } = input;

        if (!query || query.trim().length < 2) {
            return {
                success: false,
                displayText: 'Запрос слишком короткий — укажи хотя бы 2 символа',
            };
        }

        const limit = Math.min(Math.max(rawLimit, 1), 15);

        // ID текущего сообщения — исключаем его и все более новые,
        // т.к. они уже находятся в контексте диалога AI
        const currentMessageId = ctx.messageId;

        try {
            // Запрашиваем больше результатов, т.к. часть отфильтруем
            const results = await hybridSearchMessages(query, {
                limit: limit + 5,
                sender,
            });

            // Фильтруем: убираем текущее сообщение и все более новые (они уже в контексте AI)
            const filtered = results.filter(r => r.id < currentMessageId);
            const trimmed = filtered.slice(0, limit);

            if (trimmed.length === 0) {
                return {
                    success: true,
                    data: { messages: [], count: 0 },
                    displayText: `По запросу "${query}" ничего не найдено в истории сообщений`,
                };
            }

            // Подгружаем контекст если нужно
            let contextMap: Map<number, { before: any[]; after: any[] }> | null = null;
            if (includeContext) {
                contextMap = await loadContextMessages(trimmed.map(r => r.id), 2);
            }

            // Формируем текстовый ответ
            const parts: string[] = [];
            for (const r of trimmed) {
                const ctx = contextMap?.get(r.id);
                const senderLabel = r.sender === 'ai' ? 'ИИ' : 'Пользователь';
                const timestamp = r.timestamp ? new Date(r.timestamp).toLocaleString('ru-RU') : '';
                const similarity = Math.round((r as any).similarity * 100);

                // Контекст до
                if (ctx?.before?.length) {
                    for (const m of ctx.before) {
                        const s = m.sender === 'ai' ? 'ИИ' : 'Пользователь';
                        const short = m.content?.slice(0, 200) + (m.content?.length > 200 ? '...' : '');
                        parts.push(`  [контекст] ${s}: ${short}`);
                    }
                }

                // Само найденное сообщение
                parts.push(`► [${senderLabel}, ${timestamp}, ${similarity}%]: ${r.content}`);

                // Контекст после
                if (ctx?.after?.length) {
                    for (const m of ctx.after) {
                        const s = m.sender === 'ai' ? 'ИИ' : 'Пользователь';
                        const short = m.content?.slice(0, 200) + (m.content?.length > 200 ? '...' : '');
                        parts.push(`  [контекст] ${s}: ${short}`);
                    }
                }

                parts.push('---');
            }

            return {
                success: true,
                data: {
                    count: trimmed.length,
                    query,
                },
                displayText: `Найдено ${trimmed.length} сообщений по запросу "${query}":\n\n${parts.join('\n')}`,
            };
        } catch (error: any) {
            console.error('❌ search_messages error:', error);
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска сообщений: ${error?.message || error}`,
            };
        }
    },
};
