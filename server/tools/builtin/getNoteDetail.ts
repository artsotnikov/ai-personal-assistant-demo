/**
 * Tool: get_note_detail — Получить полный контент одной заметки по ID
 * 
 * Возвращает полный текст, все items, теги, метаданные.
 * Используй после get_notes, когда нужно посмотреть конкретную заметку.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getNote, formatNoteForDisplay } from '../../noteManager';

interface GetNoteDetailInput {
    noteId: number;
}

export const getNoteDetailTool: ToolDefinition<GetNoteDetailInput> = {
    name: 'get_note_detail',
    description: `Получить полный контент одной заметки по ID. Возвращает весь текст, все пункты списка, теги. Используй после get_notes — сначала покажи список, потом загружай нужную заметку.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            noteId: {
                type: 'number',
                description: 'ID заметки (получи из get_notes)',
            },
        },
        required: ['noteId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const note = await getNote(input.noteId);

            if (!note) {
                return {
                    success: false,
                    error: 'Заметка не найдена',
                    displayText: `Заметка с ID ${input.noteId} не найдена.`,
                };
            }

            return {
                success: true,
                data: {
                    id: note.id,
                    title: note.title,
                    type: note.type,
                    content: note.content,
                    items: note.items,
                    tags: note.tags,
                    isPinned: note.isPinned,
                    isArchived: note.isArchived,
                    sourceMessageId: note.sourceMessageId,
                    createdAt: note.createdAt,
                    updatedAt: note.updatedAt,
                },
                displayText: formatNoteForDisplay(note),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения заметки: ${error?.message || error}`,
            };
        }
    },
};
