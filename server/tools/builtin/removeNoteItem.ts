/**
 * Tool: remove_note_item — Удалить пункт из списка
 */

import type { ToolDefinition, ToolResult } from '../types';
import { removeNoteItem, formatNoteForDisplay } from '../../noteManager';

interface RemoveNoteItemInput {
    noteId: number;
    itemId?: string;
    itemText?: string;
}

export const removeNoteItemTool: ToolDefinition<RemoveNoteItemInput> = {
    name: 'remove_note_item',
    description: `Удалить пункт из списка покупок, чеклиста или другого списка. Можно указать itemId (точно) или itemText (нечёткий поиск по тексту). Используй когда пользователь хочет убрать что-то из списка.`,
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
            itemId: {
                type: 'string',
                description: 'ID пункта для удаления (если известен)',
            },
            itemText: {
                type: 'string',
                description: 'Текст пункта для удаления (нечёткий поиск). Используй если itemId неизвестен.',
            },
        },
        required: ['noteId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            if (!input.itemId && !input.itemText) {
                return {
                    success: false,
                    error: 'Нужно указать itemId или itemText',
                    displayText: '❌ Укажи itemId или itemText для удаления пункта.',
                };
            }

            const result = await removeNoteItem(input.noteId, {
                itemId: input.itemId,
                itemText: input.itemText,
            });

            if (!result) {
                return {
                    success: false,
                    error: 'Заметка или пункт не найдены',
                    displayText: `❌ Не удалось найти пункт "${input.itemText || input.itemId}" в заметке #${input.noteId}.`,
                };
            }

            return {
                success: true,
                data: { noteId: result.note.id, removedItem: result.removedItem },
                displayText: `➖ Удалён пункт "${result.removedItem.content}" из "${result.note.title}":\n\n${formatNoteForDisplay(result.note)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления пункта: ${error?.message || error}`,
            };
        }
    },
};
