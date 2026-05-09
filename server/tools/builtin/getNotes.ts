/**
 * Tool: get_notes — Получить список заметок и документов
 * 
 * Заменяет search_documents (теперь документы — часть notes с type='document').
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getNotes } from '../../noteManager';
import type { NoteBlock } from '@shared/schema';

interface GetNotesInput {
    type?: 'note' | 'document';
    tag?: string;
    search?: string;
    includeArchived?: boolean;
    limit?: number;
}

export const getNotesTool: ToolDefinition<GetNotesInput> = {
    name: 'get_notes',
    description: `Получить список заметок и документов (заголовки, теги, превью блоков).

ФИЛЬТРЫ:
- type='note' — только пользовательские заметки
- type='document' — только сохранённые документы (НДА, регламенты, отчёты)
- tag — фильтр по тегу (например, "покупки", "финансы")
- search — поиск по заголовку

Для поиска по СОДЕРЖИМОМУ используй search_notes.
Для полного текста — get_note_detail с id.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                description: 'Фильтр по типу: "note" или "document"',
                enum: ['note', 'document'],
            },
            tag: {
                type: 'string',
                description: 'Фильтр по тегу (нечёткий поиск): "покупки", "черновик", "работа"',
            },
            search: {
                type: 'string',
                description: 'Поиск по заголовку',
            },
            includeArchived: {
                type: 'boolean',
                description: 'Включить архивированные (по умолчанию false)',
            },
            limit: {
                type: 'number',
                description: 'Максимальное количество (по умолчанию 30)',
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            let notesList = await getNotes({
                type: input.type,
                tag: input.tag,
                includeArchived: input.includeArchived,
                limit: input.limit,
            });

            // Фильтрация по заголовку
            if (input.search) {
                const searchLower = input.search.toLowerCase();
                notesList = notesList.filter(n =>
                    n.title.toLowerCase().includes(searchLower)
                );
            }

            if (notesList.length === 0) {
                const typeLabel = input.type === 'document' ? ' среди документов' : input.type ? ` типа "${input.type}"` : '';
                return {
                    success: true,
                    data: [],
                    displayText: `Записей${typeLabel} не найдено.`,
                };
            }

            const formatted = notesList.map(n => {
                const blocks = (n.blocks as NoteBlock[]) || [];
                const checkBlocks = blocks.filter(b => b.type === 'check');
                const textBlocks = blocks.filter(b => b.type === 'text');
                const firstText = textBlocks[0]?.content?.substring(0, 100) || null;

                return {
                    id: n.id,
                    title: n.title,
                    type: n.type,
                    blockCount: blocks.length,
                    itemCount: checkBlocks.length,
                    checkedCount: checkBlocks.filter(b => b.checked).length,
                    isPinned: n.isPinned,
                    isImmutable: (n as any).isImmutable,
                    tags: n.tags,
                    contentPreview: firstText,
                    updatedAt: n.updatedAt,
                };
            });

            const displayLines = formatted.map((n, i) => {
                const icon = n.type === 'document' ? '📄' : '📝';
                const pin = n.isPinned ? '📌 ' : '';
                const tags = (n.tags as string[])?.length > 0 ? ` [${(n.tags as string[]).join(', ')}]` : '';
                const items = n.itemCount > 0 ? ` (${n.checkedCount}/${n.itemCount} ✓)` : '';
                const preview = n.contentPreview ? ` — ${n.contentPreview}...` : '';
                return `${i + 1}. ${pin}${icon} **${n.title}**${items}${tags}${preview} (id:${n.id})`;
            });

            const typeLabel = input.type === 'document' ? 'документов' : 'записей';
            return {
                success: true,
                data: formatted,
                displayText: `📋 Найдено ${notesList.length} ${typeLabel}:\n${displayLines.join('\n')}\n\n_Для полного текста вызови get_note_detail с нужным id._`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения заметок: ${error?.message || error}`,
            };
        }
    },
};
