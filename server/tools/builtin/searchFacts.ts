/**
 * Tool: search_facts — Поиск фактов в памяти
 * 
 * Делегирует к embeddingService.hybridSearchFacts()
 * Hybrid Search: Vector (семантическое сходство) + FTS (точное совпадение слов)
 */

import type { ToolDefinition, ToolResult } from '../types';
import { hybridSearchFacts } from '../../embeddingService';

interface SearchFactsInput {
    query: string;
    limit?: number;
}

export const searchFactsTool: ToolDefinition<SearchFactsInput> = {
    name: 'search_facts',
    description: `Поиск фактов о пользователе в памяти. Используй когда нужно найти ранее сохранённую информацию — факты о бизнесе, привычках, предпочтениях, решениях пользователя.`,
    category: 'memory',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    timeout: 45_000, // hybrid: embedding (10с+10с fallback) + pgvector + FTS
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос (гибридный поиск: семантический + полнотекстовый)',
            },
            limit: {
                type: 'number',
                description: 'Максимальное количество результатов (по умолчанию 10)',
            },
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const results = await hybridSearchFacts(
                input.query,
                input.limit || 10,
                0.35,
            );

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: `По запросу "${input.query}" фактов не найдено.`,
                };
            }

            const factsText = results
                .map((r, i) => {
                    const sources = r.sources?.join('+') || 'vector';
                    return `${i + 1}. ${r.content || r.name} (совпадение: ${Math.round(r.similarity * 100)}%, источник: ${sources})`;
                })
                .join('\n');

            return {
                success: true,
                data: results.map(r => ({ content: r.content || r.name, similarity: r.similarity, sources: r.sources })),
                displayText: `Найдено ${results.length} фактов:\n${factsText}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска фактов: ${error?.message || error}`,
            };
        }
    },
};
