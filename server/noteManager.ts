/**
 * Note Manager — Управление заметками пользователя (блочная архитектура)
 * 
 * Функции:
 * - CRUD операции для заметок (note, document)
 * - Управление блоками (addBlock, removeBlock, toggleBlock)
 * - Фильтрация и поиск заметок
 */

import { db } from "./db";
import { notes, type InsertNote, type Note, type NoteBlock, type NoteItem } from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createNoteEmbedding } from "./embeddingService";
import { syncNoteToVault, removeNoteFromVault } from "./vault/VaultManager";

// ============================================================================
// Хелперы для работы с блоками
// ============================================================================

/** Создать текстовый блок */
export function createTextBlock(content: string): NoteBlock {
    return {
        id: randomUUID().substring(0, 8),
        type: 'text',
        content,
        addedAt: new Date().toISOString(),
    };
}

/** Создать блок чеклиста */
export function createCheckBlock(content: string, checked = false): NoteBlock {
    return {
        id: randomUUID().substring(0, 8),
        type: 'check',
        content,
        checked,
        addedAt: new Date().toISOString(),
    };
}

/** Получить весь текстовый контент заметки (для embedding) */
export function getTextContent(note: Note): string {
    const blocks = (note.blocks as NoteBlock[]) || [];
    if (blocks.length > 0) {
        return blocks.map(b => b.content).join('\n');
    }
    // Fallback для устаревших данных
    return note.content || '';
}

/** Получить все check-блоки заметки */
export function getCheckBlocks(note: Note): NoteBlock[] {
    const blocks = (note.blocks as NoteBlock[]) || [];
    return blocks.filter(b => b.type === 'check');
}

// ============================================================================
// CRUD операции
// ============================================================================

/** Создать заметку */
export async function createNote(input: {
    title: string;
    type?: string;
    blocks?: NoteBlock[];
    // Устаревшие параметры (для обратной совместимости)
    content?: string;
    items?: string[];
    tags?: string[];
    isPinned?: boolean;
    isImmutable?: boolean;
    sourceUrl?: string;
    sourceMessageId?: number;
    /** Пропустить синхронизацию в Vault/YD (используется при pull из облака) */
    skipVaultSync?: boolean;
}): Promise<Note> {
    // Строим массив блоков
    let noteBlocks: NoteBlock[] = input.blocks || [];

    // Обратная совместимость: content → text-блок
    if (noteBlocks.length === 0 && input.content) {
        noteBlocks.push(createTextBlock(input.content));
    }

    // Обратная совместимость: items → check-блоки (только если blocks не были переданы)
    if (noteBlocks.length === 0 && input.items && input.items.length > 0) {
        const checkBlocks = input.items.map(text => createCheckBlock(text));
        noteBlocks = [...noteBlocks, ...checkBlocks];
    }

    const [note] = await db.insert(notes).values({
        title: input.title,
        type: input.type || 'note',
        blocks: noteBlocks,
        tags: input.tags || [],
        isPinned: input.isPinned || false,
        isImmutable: input.isImmutable || false,
        sourceUrl: input.sourceUrl || null,
        sourceMessageId: input.sourceMessageId || null,
    }).returning();

    // Асинхронно создаём embedding
    const textForEmbedding = noteBlocks.map(b => b.content).join('\n');
    createNoteEmbedding(note.id, note.title, textForEmbedding, input.tags).catch(() => { });

    // Синхронизируем с локальным Vault (Obsidian)
    // skipVaultSync: true = данные пришли ИЗ облака, обратная выгрузка не нужна
    if (!input.skipVaultSync) {
        syncNoteToVault(note).catch(() => {});
    }

    return note;
}

/** Обновить заметку */
export async function updateNote(
    id: number,
    updates: {
        title?: string;
        blocks?: NoteBlock[];
        tags?: string[];
        isPinned?: boolean;
        isArchived?: boolean;
    },
    /** Пропустить синхронизацию в Vault/YD (используется при pull из облака) */
    skipVaultSync = false
): Promise<Note | null> {
    const setValues: Record<string, any> = { updatedAt: new Date() };

    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.blocks !== undefined) setValues.blocks = updates.blocks;
    if (updates.tags !== undefined) setValues.tags = updates.tags;
    if (updates.isPinned !== undefined) setValues.isPinned = updates.isPinned;
    if (updates.isArchived !== undefined) setValues.isArchived = updates.isArchived;

    const [updated] = await db.update(notes)
        .set(setValues)
        .where(and(eq(notes.id, id), eq(notes.isActive, true)))
        .returning();

    // Пересоздаём embedding при изменении контента
    if (updated && (updates.blocks !== undefined || updates.title !== undefined || updates.tags !== undefined)) {
        const blocks = (updated.blocks as NoteBlock[]) || [];
        const textForEmbedding = blocks.map(b => b.content).join('\n');
        createNoteEmbedding(
            updated.id,
            updated.title,
            textForEmbedding,
            (updated.tags as string[]) || []
        ).catch(() => { });
    }

    // Синхронизируем с локальным Vault
    // skipVaultSync: true = данные пришли ИЗ облака, обратная выгрузка не нужна
    if (updated && updated.isActive && !skipVaultSync) {
        syncNoteToVault(updated).catch(() => {});
    }

    return updated || null;
}

/** Удалить заметку (soft delete) */
export async function deleteNote(id: number): Promise<boolean> {
    const [deleted] = await db.update(notes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(notes.id, id), eq(notes.isActive, true)))
        .returning();

    // Удаляем из локального Vault
    if (deleted) {
        removeNoteFromVault(deleted.title).catch(() => {});
    }

    return !!deleted;
}

/** Получить заметку по ID */
export async function getNote(id: number): Promise<Note | null> {
    const [note] = await db.select().from(notes)
        .where(and(eq(notes.id, id), eq(notes.isActive, true)));
    return note || null;
}

/** Получить заметки с фильтрацией */
export async function getNotes(filters?: {
    type?: string;
    tag?: string;
    includeArchived?: boolean;
    pinnedOnly?: boolean;
    limit?: number;
}): Promise<Note[]> {
    const conditions = [eq(notes.isActive, true)];

    if (filters?.type) {
        conditions.push(eq(notes.type, filters.type));
    }
    if (!filters?.includeArchived) {
        conditions.push(eq(notes.isArchived, false));
    }
    if (filters?.pinnedOnly) {
        conditions.push(eq(notes.isPinned, true));
    }

    let query = db.select().from(notes)
        .where(and(...conditions))
        .orderBy(desc(notes.isPinned), desc(notes.updatedAt));

    const limit = filters?.limit || 30;
    const result = await query.limit(limit);

    // Фильтрация по тегу
    if (filters?.tag) {
        return result.filter(n => {
            const tags = (n.tags as string[]) || [];
            return tags.some(t => t.toLowerCase().includes(filters.tag!.toLowerCase()));
        });
    }

    return result;
}

// ============================================================================
// Операции с блоками
// ============================================================================

/** Добавить блок к заметке */
export async function addBlock(
    noteId: number,
    block: NoteBlock,
    position: 'start' | 'end' = 'end'
): Promise<{ note: Note; block: NoteBlock } | null> {
    const note = await getNote(noteId);
    if (!note) return null;
    if ((note as any).isImmutable) return null; // нельзя редактировать документы

    const blocks = (note.blocks as NoteBlock[]) || [];
    if (position === 'start') {
        blocks.unshift(block);
    } else {
        blocks.push(block);
    }

    const updated = await updateNote(noteId, { blocks });
    return updated ? { note: updated, block } : null;
}

/** Удалить блок из заметки по ID */
export async function removeBlock(
    noteId: number,
    blockId: string
): Promise<Note | null> {
    const note = await getNote(noteId);
    if (!note) return null;
    if ((note as any).isImmutable) return null; // нельзя редактировать документы

    const blocks = (note.blocks as NoteBlock[]) || [];
    const filtered = blocks.filter(b => b.id !== blockId);

    return updateNote(noteId, { blocks: filtered });
}

/** Переключить статус check-блока */
export async function toggleBlock(
    noteId: number,
    blockId: string,
    forceChecked?: boolean
): Promise<{ note: Note; block: NoteBlock } | null> {
    const note = await getNote(noteId);
    if (!note) return null;
    if ((note as any).isImmutable) return null; // нельзя редактировать документы

    const blocks = (note.blocks as NoteBlock[]) || [];
    const target = blocks.find(b => b.id === blockId);
    if (!target || target.type !== 'check') return null;

    target.checked = forceChecked !== undefined ? forceChecked : !target.checked;

    const updated = await updateNote(noteId, { blocks });
    return updated ? { note: updated, block: target } : null;
}

/**
 * @deprecated Используйте addBlock(noteId, createCheckBlock(text)) вместо этого
 * Оставлен для обратной совместимости
 */
export async function addNoteItem(
    noteId: number,
    text: string,
    position: 'start' | 'end' = 'end'
): Promise<{ note: Note; newItem: NoteBlock } | null> {
    const block = createCheckBlock(text);
    const result = await addBlock(noteId, block, position);
    return result ? { note: result.note, newItem: result.block } : null;
}

/**
 * @deprecated Используйте removeBlock(noteId, blockId) вместо этого
 */
export async function removeNoteItem(
    noteId: number,
    identifier: { itemId?: string; itemText?: string }
): Promise<{ note: Note; removedItem: NoteBlock } | null> {
    const note = await getNote(noteId);
    if (!note) return null;

    const blocks = (note.blocks as NoteBlock[]) || [];
    let target: NoteBlock | undefined;

    if (identifier.itemId) {
        target = blocks.find(b => b.id === identifier.itemId);
    } else if (identifier.itemText) {
        const searchText = identifier.itemText.toLowerCase();
        target = blocks.find(b => b.type === 'check' && b.content.toLowerCase().includes(searchText));
    }

    if (!target) return null;

    const updated = await removeBlock(noteId, target.id);
    return updated ? { note: updated, removedItem: target } : null;
}

/**
 * @deprecated Используйте toggleBlock(noteId, blockId) вместо этого
 */
export async function toggleNoteItem(
    noteId: number,
    identifier: { itemId?: string; itemText?: string },
    forceChecked?: boolean
): Promise<{ note: Note; toggledItem: NoteBlock } | null> {
    const note = await getNote(noteId);
    if (!note) return null;

    const blocks = (note.blocks as NoteBlock[]) || [];
    let target: NoteBlock | undefined;

    if (identifier.itemId) {
        target = blocks.find(b => b.id === identifier.itemId && b.type === 'check');
    } else if (identifier.itemText) {
        const searchText = identifier.itemText.toLowerCase();
        target = blocks.find(b => b.type === 'check' && b.content.toLowerCase().includes(searchText));
    }

    if (!target) return null;

    const result = await toggleBlock(noteId, target.id, forceChecked);
    return result ? { note: result.note, toggledItem: result.block } : null;
}

// ============================================================================
// Утилиты
// ============================================================================

/** Форматировать заметку для отображения в чате */
export function formatNoteForDisplay(
    note: Note,
    options?: { maxContentLength?: number; maxItems?: number }
): string {
    const maxContentLength = options?.maxContentLength ?? 300;
    const maxItems = options?.maxItems ?? 5;

    const typeLabels: Record<string, string> = {
        note: '📝 Заметка',
        document: '📄 Документ',
    };

    const header = `${typeLabels[note.type] || '📝 Заметка'}: **${note.title}**`;
    const parts = [header];

    if (note.isPinned) parts[0] = `📌 ${parts[0]}`;
    if ((note as any).isImmutable) parts[0] += ' *(только чтение)*';

    const blocks = (note.blocks as NoteBlock[]) || [];

    let textBlockCount = 0;
    let checkBlockCount = 0;
    let shownCheckCount = 0;

    for (const block of blocks) {
        if (block.type === 'text') {
            textBlockCount++;
            if (textBlockCount <= 1) {
                // Показываем первый текстовый блок с ограничением длины
                const text = block.content;
                if (maxContentLength > 0 && text.length > maxContentLength) {
                    parts.push(text.substring(0, maxContentLength) + '…');
                } else {
                    parts.push(text);
                }
            }
        } else if (block.type === 'check') {
            checkBlockCount++;
            if (shownCheckCount < maxItems) {
                parts.push(`${block.checked ? '☑' : '☐'} ${block.content}`);
                shownCheckCount++;
            }
        }
    }

    if (checkBlockCount > maxItems) {
        parts.push(`_...и ещё ${checkBlockCount - maxItems} пунктов_`);
    }

    const checkedCount = blocks.filter(b => b.type === 'check' && b.checked).length;
    if (checkBlockCount > 0) {
        parts.push(`_Выполнено: ${checkedCount}/${checkBlockCount}_`);
    }

    // Tags
    const tags = (note.tags as string[]) || [];
    if (tags.length > 0) {
        parts.push(`🏷 ${tags.join(', ')}`);
    }

    return parts.join('\n\n');
}
