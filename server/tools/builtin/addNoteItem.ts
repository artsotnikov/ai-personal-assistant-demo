/**
 * Tool: add_note_item — Добавить пункт в список/чеклист
 */

import type { ToolDefinition, ToolResult } from '../types';
import { addNoteItem, formatNoteForDisplay } from '../../noteManager';

interface AddNoteItemInput {
    noteId: number;
    text: string;
    position?: string;
}

export const addNoteItemTool: ToolDefinition<AddNoteItemInput> = {
    name: 'add_note_item',
    description: `Добавить пункт в список покупок, чеклист или другой список. Используй когда пользователь хочет добавить что-то в существующий список.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            noteId: {
                type: 'number',
                description: 'ID заметки-списка',
            },
            text: {
                type: 'string',
                description: 'Текст пункта (например: "Молоко 2л")',
            },
            position: {
                type: 'string',
                description: 'Куда добавить: "start" (в начало) или "end" (в конец, по умолчанию)',
                enum: ['start', 'end'],
            },
        },
        required: ['noteId', 'text'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const result = await addNoteItem(
                input.noteId,
                input.text,
                (input.position as 'start' | 'end') || 'end'
            );

            if (!result) {
                return {
                    success: false,
                    error: `Заметка с ID ${input.noteId} не найдена`,
                    displayText: `❌ Заметка #${input.noteId} не найдена.`,
                };
            }

            return {
                success: true,
                data: { noteId: result.note.id, newItemId: result.newItem.id },
                displayText: `➕ Добавлен пункт "${input.text}" в "${result.note.title}":\n\n${formatNoteForDisplay(result.note)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка добавления пункта: ${error?.message || error}`,
            };
        }
    },
};
