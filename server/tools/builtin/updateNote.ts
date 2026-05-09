/**
 * Tool: update_note — Обновить заметку / добавить или отметить блок
 * 
 * Заменяет add_note_item, remove_note_item, toggle_note_item.
 * Работает через обновление полного массива blocks.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { updateNote, getNote, addBlock, removeBlock, toggleBlock, createCheckBlock, createTextBlock, formatNoteForDisplay } from '../../noteManager';
import type { NoteBlock } from '@shared/schema';

interface UpdateNoteInput {
    noteId: number;
    title?: string;
    tags?: string[];
    isPinned?: boolean;
    isArchived?: boolean;
    // Операции с блоками
    addTextBlock?: string;
    addCheckItem?: string;
    toggleBlockId?: string;
    toggleItemText?: string;
    removeBlockId?: string;
    // Полная замена блоков
    blocks?: Array<{
        type: 'text' | 'check';
        content: string;
        checked?: boolean;
        id?: string;
    }>;
}

export const updateNoteTool: ToolDefinition<UpdateNoteInput> = {
    name: 'update_note',
    description: `Обновить заметку: изменить название, теги, добавить/удалить/отметить блок.

ЗАМЕНА add_note_item, remove_note_item, toggle_note_item:
- Добавить текстовый блок: addTextBlock='текст'
- Добавить пункт чеклиста: addCheckItem='задача'
- Отметить пункт выполненным: toggleBlockId='id блока' (или toggleItemText='текст пункта')
- Удалить блок: removeBlockId='id блока'

Для получения ID блоков сначала вызови get_note_detail.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            noteId: {
                type: 'number',
                description: 'ID заметки для обновления',
            },
            title: {
                type: 'string',
                description: 'Новое название заметки',
            },
            tags: {
                type: 'array',
                description: 'Новые теги (заменяют старые)',
                items: { type: 'string' },
            },
            isPinned: {
                type: 'boolean',
                description: 'Закрепить/открепить заметку',
            },
            isArchived: {
                type: 'boolean',
                description: 'Архивировать/разархивировать заметку',
            },
            addTextBlock: {
                type: 'string',
                description: 'Добавить текстовый блок в конец заметки',
            },
            addCheckItem: {
                type: 'string',
                description: 'Добавить пункт чеклиста в конец заметки',
            },
            toggleBlockId: {
                type: 'string',
                description: 'ID блока-чеклиста для переключения checked (вкл/выкл)',
            },
            toggleItemText: {
                type: 'string',
                description: 'Текст пункта чеклиста для переключения (если ID неизвестен)',
            },
            removeBlockId: {
                type: 'string',
                description: 'ID блока для удаления',
            },
            blocks: {
                type: 'array',
                description: 'Полный новый массив блоков (заменяет все текущие блоки)',
                items: {
                    type: 'string',
                    description: 'Блок: {type:"text"|"check", content:"...", checked:true|false, id?:"..."}',
                } as any,
            },
        },
        required: ['noteId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            let resultNote = null;

            // Операции с блоками (по одной)
            if (input.addTextBlock) {
                const block = createTextBlock(input.addTextBlock);
                const r = await addBlock(input.noteId, block);
                if (!r) {
                    return { success: false, error: 'Заметка не найдена или иммутабельна', displayText: `❌ Не удалось добавить блок.` };
                }
                resultNote = r.note;
            } else if (input.addCheckItem) {
                const block = createCheckBlock(input.addCheckItem);
                const r = await addBlock(input.noteId, block);
                if (!r) {
                    return { success: false, error: 'Заметка не найдена или иммутабельна', displayText: `❌ Не удалось добавить пункт.` };
                }
                resultNote = r.note;
            } else if (input.removeBlockId) {
                resultNote = await removeBlock(input.noteId, input.removeBlockId);
            } else if (input.toggleBlockId) {
                const r = await toggleBlock(input.noteId, input.toggleBlockId);
                resultNote = r?.note || null;
            } else if (input.toggleItemText) {
                // Найти блок по тексту
                const note = await getNote(input.noteId);
                if (note) {
                    const blocks = (note.blocks as NoteBlock[]) || [];
                    const target = blocks.find(b =>
                        b.type === 'check' && b.content.toLowerCase().includes(input.toggleItemText!.toLowerCase())
                    );
                    if (target) {
                        const r = await toggleBlock(input.noteId, target.id);
                        resultNote = r?.note || null;
                    }
                }
            }

            // Обновление основных полей или полная замена блоков
            const hasMetaUpdates = input.title !== undefined || input.tags !== undefined ||
                input.isPinned !== undefined || input.isArchived !== undefined;
            const hasBlocksReplace = input.blocks !== undefined;

            if (hasMetaUpdates || hasBlocksReplace) {
                const updates: any = {};
                if (input.title !== undefined) updates.title = input.title;
                if (input.tags !== undefined) updates.tags = input.tags;
                if (input.isPinned !== undefined) updates.isPinned = input.isPinned;
                if (input.isArchived !== undefined) updates.isArchived = input.isArchived;
                if (input.blocks !== undefined) {
                    updates.blocks = input.blocks.map(b =>
                        b.type === 'text'
                            ? { ...createTextBlock(b.content), ...(b.id ? { id: b.id } : {}) }
                            : { ...createCheckBlock(b.content, b.checked), ...(b.id ? { id: b.id } : {}) }
                    );
                }
                resultNote = await updateNote(resultNote?.id || input.noteId, updates);
            }

            if (!resultNote) {
                // Если не было операций — просто проверим существование
                resultNote = await getNote(input.noteId);
                if (!resultNote) {
                    return {
                        success: false,
                        error: `Заметка с ID ${input.noteId} не найдена`,
                        displayText: `❌ Заметка #${input.noteId} не найдена.`,
                    };
                }
            }

            return {
                success: true,
                data: { id: resultNote.id, title: resultNote.title },
                displayText: `✏️ Заметка обновлена:\n\n${formatNoteForDisplay(resultNote)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка обновления заметки: ${error?.message || error}`,
            };
        }
    },
};
