/**
 * Tool: toggle_note_item — Отметить/снять отметку с пункта
 */

import type { ToolDefinition, ToolResult } from '../types';
import { toggleNoteItem, formatNoteForDisplay } from '../../noteManager';

interface ToggleNoteItemInput {
    noteId: number;
    itemId?: string;
    itemText?: string;
    checked?: boolean;
}

export const toggleNoteItemTool: ToolDefinition<ToggleNoteItemInput> = {
    name: 'toggle_note_item',
    description: `Отметить пункт как выполненный (купленный, сделанный) или снять отметку. Используй когда пользователь говорит "купил молоко", "сделал задачу" или "отменить отметку".`,
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
                description: 'ID пункта (если известен)',
            },
            itemText: {
                type: 'string',
                description: 'Текст пункта (нечёткий поиск). Используй если itemId неизвестен.',
            },
            checked: {
                type: 'boolean',
                description: 'Установить статус: true = отмечено, false = не отмечено. Если не указано — переключает.',
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
                    displayText: '❌ Укажи itemId или itemText для отметки пункта.',
                };
            }

            const result = await toggleNoteItem(
                input.noteId,
                { itemId: input.itemId, itemText: input.itemText },
                input.checked
            );

            if (!result) {
                return {
                    success: false,
                    error: 'Заметка или пункт не найдены',
                    displayText: `❌ Не удалось найти пункт "${input.itemText || input.itemId}" в заметке #${input.noteId}.`,
                };
            }

            const status = result.toggledItem.checked ? '☑ отмечен' : '☐ снята отметка';
            return {
                success: true,
                data: { noteId: result.note.id, item: result.toggledItem },
                displayText: `${result.toggledItem.checked ? '✅' : '↩️'} Пункт "${result.toggledItem.content}" — ${status}:\n\n${formatNoteForDisplay(result.note)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка отметки пункта: ${error?.message || error}`,
            };
        }
    },
};
