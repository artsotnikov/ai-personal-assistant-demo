/**
 * Tool: search_documents — Поиск по сохранённым документам
 * 
 * Делегирует к documentManager.searchDocuments()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { searchDocuments } from '../../documentManager';

interface SearchDocumentsInput {
    query: string;
    limit?: number;
}

export const searchDocumentsTool: ToolDefinition<SearchDocumentsInput> = {
    name: 'search_documents',
    description: `Поиск по сохранённым документам пользователя (отчёты, анализы, стратегии). Используй когда нужно найти ранее сохранённый документ по ключевым словам или теме.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос (поддерживается семантический поиск)',
            },
            limit: {
                type: 'number',
                description: 'Максимальное количество результатов (по умолчанию 5)',
            },
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const results = await searchDocuments(input.query, input.limit || 5);

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: `По запросу "${input.query}" документов не найдено.`,
                };
            }

            const docsText = results
                .map((d: any, i: number) => `${i + 1}. "${d.title}" (${d.documentType || 'документ'}) — ${d.summary?.substring(0, 100) || 'без описания'}`)
                .join('\n');

            return {
                success: true,
                data: results.map((d: any) => ({
                    id: d.id,
                    title: d.title,
                    summary: d.summary,
                    documentType: d.documentType,
                    content: d.content?.substring(0, 500),
                })),
                displayText: `Найдено ${results.length} документов:\n${docsText}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска документов: ${error?.message || error}`,
            };
        }
    },
};
