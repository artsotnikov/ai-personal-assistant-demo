/**
 * Vault Manager — Мост между базой данных и .md файлами Obsidian
 * 
 * Функции:
 * - Конвертация Note -> Markdown (.md) и обратно
 * - Сохранение в локальный Vault
 * - Подготовка метаданных (YAML Frontmatter)
 * - Парсинг Obsidian [[links]]
 */

import fs from "fs/promises";
import path from "path";
import { type Note, type NoteBlock } from "@shared/schema";

import { storage } from "../storage";
import { YandexDiskService } from "./YandexDiskService";

const VAULT_ROOT = path.resolve(process.cwd(), "vault");

/**
 * Gets the current Vault configuration.
 * Priority: DB Settings > Environment Variables
 */
async function getVaultConfig() {
    const dbToken = await storage.getSetting("yandex_disk_token");
    const dbRoot = await storage.getSetting("yandex_disk_root");

    return {
        token: dbToken || process.env.YANDEX_DISK_TOKEN || "",
        remoteRoot: dbRoot || process.env.YANDEX_DISK_ROOT || "Assistant/Vault"
    };
}

/**
 * Gets an initialized YandexDiskService if a token is available.
 */
async function getYandexDisk() {
    const config = await getVaultConfig();
    if (config.token) {
        return new YandexDiskService(config);
    }
    return null;
}

/**
 * Санитизация названий для файлов (удаление запрещенных символов)
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[\\/:"*?<>|]/g, "-") // убираем недопустимые символы
        .replace(/\s+/g, " ")          // схлопываем пробелы
        .trim()
        .substring(0, 100);            // ограничение по длине
}

/**
 * Конвертация блоков в Markdown
 */
function blocksToMarkdown(blocks: any[]): string {
    if (!Array.isArray(blocks)) return "";
    return blocks.map(block => {
        if (!block || typeof block !== 'object') return "";
        if (block.type === 'check') {
            return `- [${block.checked ? 'x' : ' '}] ${block.content || ""}`;
        }
        return block.content || "";
    }).filter(Boolean).join('\n\n');
}

/**
 * Генерация YAML Frontmatter
 */
function generateFrontmatter(note: Note): string {
    const tags = Array.isArray(note.tags) ? note.tags : [];
    
    // Helper for date formatting
    const dToIso = (d: any) => {
        if (!d) return new Date().toISOString();
        if (d instanceof Date) return d.toISOString();
        return new Date(d).toISOString();
    };

    const lines = [
        "---",
        `assistant_id: ${note.id}`, // Safety ownership tag
        `title: "${(note.title || "Unknown").replace(/"/g, '\\"')}"`,
        `type: ${note.type || 'note'}`,
        `tags: [${tags.join(", ")}]`,
        `created: ${dToIso(note.createdAt)}`,
        `updated: ${dToIso(note.updatedAt)}`,
        `is_pinned: ${note.isPinned ?? false}`,
        `is_archived: ${note.isArchived ?? false}`,
        "---",
        ""
    ];
    return lines.join("\n");
}

/**
 * Обновить файл заметки в Vault
 */
export async function syncNoteToVault(note: Note): Promise<string> {
    try {
        if (!note || !note.title) {
            throw new Error(`Invalid note data: ${JSON.stringify(note)}`);
        }

        const filename = `${sanitizeFilename(note.title)}.md`;
        const filePath = path.join(VAULT_ROOT, filename);
        
        console.log(`[Vault] Syncing note ${note.id}: "${note.title}" -> "${filename}"`);

        // Defensive checks for Date objects (Drizzle might return strings in some environments)
        const frontmatter = generateFrontmatter(note);
        const content = blocksToMarkdown(note.blocks as any[]);
        
        const fullContent = `${frontmatter}\n# ${note.title || 'Untitled'}\n\n${content}`;
        
        // Ensure Vault directory exists
        await fs.mkdir(VAULT_ROOT, { recursive: true }).catch(() => {});

        // Safety Strategy: Check if file exists and belongs to us
        const existingContent = await fs.readFile(filePath, "utf-8").catch(() => null);
        if (existingContent && !existingContent.includes("assistant_id:")) {
            console.warn(`[Vault] 🛡️ Protected file found at "${filename}". Skipping sync to prevent overwriting user data.`);
            return filePath;
        }

        await fs.writeFile(filePath, fullContent, "utf-8");
        console.log(`[Vault] Local file updated: ${filePath}`);

        // Sync to Yandex Disk if enabled
        const yDisk = await getYandexDisk().catch(() => null);
        if (yDisk) {
            try {
                console.log(`[Vault] Uploading ${filename} to Yandex Disk...`);
                await yDisk.uploadFile(filename, fullContent);
                console.log(`[Vault] Yandex Disk Upload Complete: ${filename}`);
                setSyncLock(); // Защита от sync-loop
            } catch (yError) {
                console.error(`[VaultManager] ☁️ Yandex Disk Upload Failed for ${note.id}:`, yError);
                // We DON'T throw here so that the local sync is still considered successful
            }
        }

        return filePath;
    } catch (error) {
        console.error(`[VaultManager] ❌ Ошибка синхронизации заметки ${note?.id || 'unknown'}:`, error);
        throw error;
    }
}

/**
 * Удалить файл из Vault
 */
export async function removeNoteFromVault(title: string): Promise<void> {
    try {
        const filename = `${sanitizeFilename(title)}.md`;
        const filePath = path.join(VAULT_ROOT, filename);
        
        // Safety Strategy: Only delete if it belongs to us
        const existingContent = await fs.readFile(filePath, "utf-8").catch(() => null);
        if (existingContent && !existingContent.includes("assistant_id:")) {
            console.warn(`[Vault] 🛡️ Protected file found at "${filename}". Skipping deletion.`);
            return;
        }

        await fs.unlink(filePath).catch(() => {}); // игнорируем если не найден
        
        // We also need the ID to check Yandex Disk if possible, 
        // but for now, we rely on the local cache check for Stage 2.

        // Remove from Yandex Disk if enabled
        const yDisk = await getYandexDisk();
        if (yDisk) {
            try {
                await yDisk.deleteResource(filename);
            } catch (yError) {
                console.error(`[VaultManager] ☁️ Yandex Disk Deletion Failed for ${title}:`, yError);
            }
        }
    } catch (error) {
        console.error(`[VaultManager] ❌ Ошибка удаления заметки ${title}:`, error);
    }
}

// ============================================================================
// Sync Lock — Защита от sync-loop (DB→Disk→DB→...)
// ============================================================================

let syncLockUntil = 0;

/** Установить lock (вызывается при DB→Disk записи) */
export function setSyncLock(durationMs = 30_000): void {
    syncLockUntil = Date.now() + durationMs;
    console.log(`[Vault] 🔒 Sync lock set for ${durationMs}ms`);
}

/** Проверить, активен ли lock */
export function isSyncLocked(): boolean {
    return Date.now() < syncLockUntil;
}

// ============================================================================
// Обратный парсер: Markdown → Note (для pull из облака)
// ============================================================================

export interface ParsedNote {
    assistantId?: number;
    title: string;
    type: string;
    tags: string[];
    blocks: NoteBlock[];
    isPinned: boolean;
    isArchived: boolean;
}

/**
 * Разбирает Markdown-файл (с YAML frontmatter) обратно в структуру Note.
 */
export function parseMarkdownToNote(content: string): ParsedNote {
    const result: ParsedNote = {
        title: 'Untitled',
        type: 'note',
        tags: [],
        blocks: [],
        isPinned: false,
        isArchived: false,
    };

    // 1. Разделяем frontmatter и body
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let body: string;

    if (fmMatch) {
        const frontmatter = fmMatch[1];
        body = fmMatch[2];

        // Парсим YAML-like frontmatter (простой парсер, не полный YAML)
        for (const line of frontmatter.split('\n')) {
            const kvMatch = line.match(/^(\w+):\s*(.*)$/);
            if (!kvMatch) continue;
            const [, key, rawValue] = kvMatch;
            const value = rawValue.trim();

            switch (key) {
                case 'assistant_id': {
                    const id = parseInt(value, 10);
                    if (!isNaN(id)) result.assistantId = id;
                    break;
                }
                case 'title':
                    result.title = value.replace(/^"|"$/g, '').replace(/\\"/g, '"');
                    break;
                case 'type':
                    result.type = value || 'note';
                    break;
                case 'tags': {
                    // [tag1, tag2, tag3]
                    const tagsMatch = value.match(/^\[(.*)?\]$/);
                    if (tagsMatch && tagsMatch[1]) {
                        result.tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean);
                    }
                    break;
                }
                case 'is_pinned':
                    result.isPinned = value === 'true';
                    break;
                case 'is_archived':
                    result.isArchived = value === 'true';
                    break;
            }
        }
    } else {
        body = content;
    }

    // 2. Парсим body
    // Убираем заголовок H1 если он совпадает с title из frontmatter
    const lines = body.split('\n');
    let startIdx = 0;

    // Пропускаем пустые строки в начале
    while (startIdx < lines.length && lines[startIdx].trim() === '') startIdx++;

    // Если первая непустая строка — H1, используем как title (если не из frontmatter)
    if (startIdx < lines.length && lines[startIdx].startsWith('# ')) {
        const h1Title = lines[startIdx].substring(2).trim();
        if (!fmMatch) {
            result.title = h1Title;
        }
        startIdx++;
    }

    // 3. Парсим оставшиеся строки в блоки
    let currentTextBuffer: string[] = [];

    const flushText = () => {
        const text = currentTextBuffer.join('\n').trim();
        if (text) {
            result.blocks.push({
                id: randomId(),
                type: 'text',
                content: convertObsidianLinks(text),
                addedAt: new Date().toISOString(),
            });
        }
        currentTextBuffer = [];
    };

    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];

        // Check-блок: - [x] или - [ ]
        const checkMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (checkMatch) {
            flushText();
            result.blocks.push({
                id: randomId(),
                type: 'check',
                content: convertObsidianLinks(checkMatch[2]),
                checked: checkMatch[1].toLowerCase() === 'x',
                addedAt: new Date().toISOString(),
            });
            continue;
        }

        currentTextBuffer.push(line);
    }

    flushText();

    return result;
}

/**
 * Конвертирует Obsidian [[links]] в читаемый текст.
 * [[Имя заметки]] → Имя заметки
 * [[Имя заметки|Отображаемый текст]] → Отображаемый текст
 */
export function convertObsidianLinks(text: string): string {
    return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, display) => {
        return display || target;
    });
}

/**
 * Генерирует Obsidian [[link]] из заголовка заметки.
 * Используется при генерации MD для создания кросс-ссылок.
 */
export function createObsidianLink(noteTitle: string, displayText?: string): string {
    if (displayText && displayText !== noteTitle) {
        return `[[${noteTitle}|${displayText}]]`;
    }
    return `[[${noteTitle}]]`;
}

/** Генерация короткого ID для блока */
function randomId(): string {
    return Math.random().toString(36).substring(2, 10);
}
