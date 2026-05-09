/**
 * Tool: create_note — Создать заметку (с блочной структурой)
 * 
 * Заменяет save_document и старый create_note.
 * Тип: 'note' (редактируемая) или 'document' (иммутабельный сохранённый текст).
 * Категоризация через теги вместо типов.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { createNote, createTextBlock, createCheckBlock, formatNoteForDisplay } from '../../noteManager';
import type { NoteBlock } from '@shared/schema';

interface CreateNoteInput {
    title: string;
    type?: 'note' | 'document';
    blocks?: Array<{
        type: 'text' | 'check';
        content: string;
        checked?: boolean;
    }>;
    // Упрощённые параметры для быстрого создания
    content?: string;
    items?: string[];
    tags?: string[];
    isPinned?: boolean;
    isImmutable?: boolean;
    sourceUrl?: string;
}

export const createNoteTool: ToolDefinition<CreateNoteInput> = {
    name: 'create_note',
    description: `Создать заметку или сохранить документ. Единый инструмент вместо save_document, create_note и других.

ТИПЫ:
- type='note' (по умолчанию) — редактируемая пользовательская заметка
- type='document' — сохранённый текст/отчёт (нельзя редактировать блоки, isImmutable=true)

КАТЕГОРИЗАЦИЯ через теги:
- Вместо типов shopping_list/checklist/draft/bookmark используй tags: ["покупки"], ["черновик"], ["ссылки"] и т.д.

БЛОКИ (универсальная структура):
- blocks: [{type:'text', content:'...'}, {type:'check', content:'Задача', checked:false}]
- Можно смешивать текстовые абзацы и пункты чеклиста

БЫСТРЫЕ ПАРАМЕТРЫ (вместо blocks):
- content — текст заметки → автоматически создаёт text-блок
- items — массив строк → автоматически создаёт check-блоки

КОГДА ИСПОЛЬЗОВАТЬ:
✅ Пользователь говорит: "запиши", "создай список", "сделай чеклист"
✅ Нужно сохранить сгенерированный отчёт/регламент/NDA → type='document'
⛔ Пользователь просто рассказывает или задаёт вопрос → отвечай, не создавай заметку!
⛔ Факты о пользователе → remember_fact, не заметка`,
    category: 'documents',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Название заметки',
            },
            type: {
                type: 'string',
                description: 'Тип: "note" (редактируемая) или "document" (иммутабельный сохранённый текст)',
                enum: ['note', 'document'],
            },
            blocks: {
                type: 'array',
                description: 'Массив блоков контента. Позволяет смешивать текст и чеклист.',
                items: {
                    type: 'string',
                    description: 'Блок: {type:"text"|"check", content:"...", checked:true|false}',
                } as any,
            },
            content: {
                type: 'string',
                description: 'Быстрый параметр: текст заметки. Создаёт один text-блок. Используй вместо blocks если нет чеклиста.',
            },
            items: {
                type: 'array',
                description: 'Быстрый параметр: пункты чеклиста. Массив строк: ["Молоко", "Хлеб"]. Можно сочетать с content.',
                items: { type: 'string' },
            },
            tags: {
                type: 'array',
                description: 'Теги вместо типов: ["покупки"], ["черновик"], ["важно"], ["финансы"], ["документ"] и т.д.',
                items: { type: 'string' },
            },
            isPinned: {
                type: 'boolean',
                description: 'Закрепить заметку наверху списка',
            },
            isImmutable: {
                type: 'boolean',
                description: 'Только для type=document. Запрещает редактирование блоков через UI.',
            },
            sourceUrl: {
                type: 'string',
                description: 'URL источника (для сохранённых веб-страниц)',
            },
        },
        required: ['title'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            // Строим blocks из переданных параметров
            let blocks: NoteBlock[] | undefined;

            if (input.blocks && input.blocks.length > 0) {
                blocks = input.blocks.map(b =>
                    b.type === 'text'
                        ? createTextBlock(b.content)
                        : createCheckBlock(b.content, b.checked)
                );
            }

            const isDocument = input.type === 'document';

            const note = await createNote({
                title: input.title,
                type: input.type || 'note',
                blocks,
                content: input.content,
                items: input.items,
                tags: input.tags,
                isPinned: input.isPinned,
                isImmutable: input.isImmutable || isDocument,
                sourceUrl: input.sourceUrl,
                sourceMessageId: ctx.messageId || undefined,
            });

            const emoji = isDocument ? '📄' : '📝';
            return {
                success: true,
                data: { id: note.id, title: note.title, type: note.type },
                displayText: `${emoji} Создано:\n\n${formatNoteForDisplay(note)}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка создания заметки: ${error?.message || error}`,
            };
        }
    },
};
