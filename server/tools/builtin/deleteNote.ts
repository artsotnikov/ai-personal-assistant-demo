/**
 * Tool: delete_note — Удалить заметку
 */

import type { ToolDefinition, ToolResult } from '../types';
import { deleteNote, getNote } from '../../noteManager';

interface DeleteNoteInput {
    noteId: number;
}

export const deleteNoteTool: ToolDefinition<DeleteNoteInput> = {
    name: 'delete_note',
    description: `Удалить заметку, список или черновик. Используй когда пользователь просит удалить или убрать заметку.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            noteId: {
                type: 'number',
                description: 'ID заметки для удаления',
            },
        },
        required: ['noteId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Получим заметку перед удалением для отображения
            const note = await getNote(input.noteId);
            const deleted = await deleteNote(input.noteId);

            if (!deleted) {
                return {
                    success: false,
                    error: `Заметка с ID ${input.noteId} не найдена`,
                    displayText: `❌ Заметка #${input.noteId} не найдена или уже удалена.`,
                };
            }

            return {
                success: true,
                data: { id: input.noteId, deleted: true },
                displayText: `🗑️ Заметка удалена: "${note?.title || `#${input.noteId}`}"`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления заметки: ${error?.message || error}`,
            };
        }
    },
};
