/**
 * Tool: search_notes — Семантический поиск заметок И документов
 * 
 * Заменяет search_documents. Теперь ищет по всем записям: note + document.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { searchNotesByQuery } from '../../embeddingService';
import { getNote } from '../../noteManager';
import type { NoteBlock } from '@shared/schema';

interface SearchNotesInput {
    query: string;
    limit?: number;
    type?: 'note' | 'document';
}

export const searchNotesTool: ToolDefinition<SearchNotesInput> = {
    name: 'search_notes',
    description: `Семантический поиск по содержимому заметок и документов.

ЗАМЕНЯЕТ search_documents — теперь все документы хранятся среди notes (type='document').

Используй когда:
- Пользователь ищет по описанию содержимого ("найди про NDA", "есть ли регламент")  
- Нужно найти конкретную заметку без знания точного названия

Для просмотра всех заметок/фильтрации по тегу → get_notes
Для полного текста → get_note_detail`,
    category: 'documents',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    timeout: 45_000, // embedding (10с primary + 10с fallback) + pgvector/O(N) поиск
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос (описание содержимого)',
            },
            limit: {
                type: 'number',
                description: 'Максимум результатов (по умолчанию 5)',
            },
            type: {
                type: 'string',
                description: 'Опционально: искать только среди "note" или "document"',
                enum: ['note', 'document'],
            },
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const results = await searchNotesByQuery(
                input.query,
                input.limit || 5,
                0.35
            );

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: `По запросу "${input.query}" ничего не найдено. Попробуй get_notes для просмотра всех записей.`,
                };
            }

            const enriched = await Promise.all(results.map(async (r) => {
                const note = await getNote(r.id);
                if (!note) return null;
                if (input.type && note.type !== input.type) return null;

                const blocks = (note.blocks as NoteBlock[]) || [];
                const firstText = blocks.find(b => b.type === 'text')?.content?.substring(0, 150) || null;
                const checkCount = blocks.filter(b => b.type === 'check').length;

                return {
                    id: note.id,
                    title: note.title,
                    type: note.type,
                    similarity: Math.round(r.similarity * 100),
                    contentPreview: firstText,
                    blockCount: blocks.length,
                    checkCount,
                    tags: note.tags,
                    isPinned: note.isPinned,
                };
            }));

            const filtered = enriched.filter(Boolean) as NonNullable<typeof enriched[0]>[];

            if (filtered.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: `По запросу "${input.query}" ничего не найдено (с учётом фильтра типа).`,
                };
            }

            const displayLines = filtered.map((n, i) => {
                const icon = n!.type === 'document' ? '📄' : '📝';
                const preview = n!.contentPreview ? ` — ${n!.contentPreview}...` : '';
                return `${i + 1}. ${icon} **${n!.title}** (${n!.similarity}% совпадение)${preview} (id:${n!.id})`;
            });

            return {
                success: true,
                data: filtered,
                displayText: `🔍 По запросу "${input.query}" найдено ${filtered.length} записей:\n${displayLines.join('\n')}\n\n_Для полного текста вызови get_note_detail с нужным id._`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска: ${error?.message || error}`,
            };
        }
    },
};
