/**
 * Cloud Sync Watcher — Фоновый сервис обратной синхронизации Yandex Disk → DB
 * 
 * Функции:
 * - Периодический опрос Yandex Disk (polling)
 * - Обнаружение изменённых/новых файлов по md5
 * - Скачивание и парсинг MD → Note
 * - Создание/обновление заметок в БД
 */

import { storage } from "../storage";
import { YandexDiskService, type RemoteFileInfo } from "./YandexDiskService";
import { parseMarkdownToNote, isSyncLocked, type ParsedNote } from "./VaultManager";
import { createNote, updateNote, getNote, getNotes } from "../noteManager";
import type { Note } from "@shared/schema";

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

interface SyncState {
    lastSyncAt: string;
    fileHashes: Record<string, string>; // filename → md5
}

interface PullResult {
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
}

/**
 * Получить текущее состояние синхронизации из БД
 */
async function getSyncState(): Promise<SyncState> {
    const raw = await storage.getSetting("vault_sync_state");
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch {
            // Сброс если JSON невалиден
        }
    }
    return { lastSyncAt: '', fileHashes: {} };
}

/**
 * Сохранить состояние синхронизации в БД
 */
async function saveSyncState(state: SyncState): Promise<void> {
    await storage.setSetting("vault_sync_state", JSON.stringify(state));
}

/**
 * Получить инициализированный YandexDiskService
 */
async function getYandexDisk(): Promise<YandexDiskService | null> {
    const token = await storage.getSetting("yandex_disk_token");
    const root = await storage.getSetting("yandex_disk_root") || "app:/";
    if (token) {
        return new YandexDiskService({ token, remoteRoot: root });
    }
    return null;
}

/**
 * Получить список изменённых файлов на Yandex Disk (diff)
 */
export async function getRemoteChanges(): Promise<{
    changed: RemoteFileInfo[];
    newFiles: RemoteFileInfo[];
    total: number;
}> {
    const yDisk = await getYandexDisk();
    if (!yDisk) {
        return { changed: [], newFiles: [], total: 0 };
    }

    const remoteFiles = await yDisk.listFiles();
    const syncState = await getSyncState();

    const changed: RemoteFileInfo[] = [];
    const newFiles: RemoteFileInfo[] = [];

    for (const file of remoteFiles) {
        const knownHash = syncState.fileHashes[file.name];
        if (!knownHash) {
            newFiles.push(file);
        } else if (knownHash !== file.md5) {
            changed.push(file);
        }
    }

    return { changed, newFiles, total: remoteFiles.length };
}

/**
 * Pull: скачать изменения из Yandex Disk и применить к БД
 */
export async function pullFromCloud(): Promise<PullResult> {
    const result: PullResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    if (isSyncLocked()) {
        console.log("[CloudSync] ⏸️ Sync lock active, skipping pull");
        return result;
    }

    const yDisk = await getYandexDisk();
    if (!yDisk) {
        result.errors.push("Yandex Disk не настроен");
        return result;
    }

    try {
        const remoteFiles = await yDisk.listFiles();
        const syncState = await getSyncState();
        const existingNotes = await getNotes({ limit: 1000, includeArchived: true });

        // Создаём индекс существующих заметок по ID
        const noteById = new Map<number, Note>();
        for (const note of existingNotes) {
            noteById.set(note.id, note);
        }

        // Индекс по title (для поиска заметок без assistant_id)
        const noteByTitle = new Map<string, Note>();
        for (const note of existingNotes) {
            noteByTitle.set(note.title.toLowerCase(), note);
        }

        for (const file of remoteFiles) {
            const knownHash = syncState.fileHashes[file.name];

            // Файл не изменился — пропускаем
            if (knownHash && knownHash === file.md5) {
                result.skipped++;
                continue;
            }

            try {
                // Скачиваем содержимое
                const content = await yDisk.downloadFile(file.name);
                const parsed = parseMarkdownToNote(content);

                if (parsed.assistantId) {
                    // Файл принадлежит нам — обновляем существующую заметку
                    const existing = noteById.get(parsed.assistantId);
                    if (existing) {
                        // Сравниваем: если MD новее — обновляем DB
                        const remoteModified = new Date(file.modified).getTime();
                        const dbUpdated = new Date(existing.updatedAt).getTime();

                        if (remoteModified > dbUpdated) {
                            await updateNote(parsed.assistantId, {
                                title: parsed.title,
                                blocks: parsed.blocks,
                                tags: parsed.tags,
                                isPinned: parsed.isPinned,
                                isArchived: parsed.isArchived,
                            }, /* skipVaultSync */ true);
                            result.updated++;
                            console.log(`[CloudSync] 🔄 Updated note #${parsed.assistantId}: "${parsed.title}"`);
                        } else {
                            result.skipped++;
                        }
                    } else {
                        // ID в frontmatter, но заметки нет в БД — пропускаем (удалена)
                        result.skipped++;
                    }
                } else {
                    // Нет assistant_id — это новый файл, созданный пользователем в Obsidian
                    // Проверяем по title, нет ли дубликата
                    const existingByTitle = noteByTitle.get(parsed.title.toLowerCase());
                    if (existingByTitle) {
                        result.skipped++;
                        console.log(`[CloudSync] ⏭️ Skipped "${parsed.title}" — duplicate title exists`);
                        continue;
                    }

                    const newNote = await createNote({
                        title: parsed.title,
                        type: parsed.type as any,
                        blocks: parsed.blocks,
                        tags: parsed.tags,
                        isPinned: parsed.isPinned,
                        skipVaultSync: true,
                    });
                    result.created++;
                    console.log(`[CloudSync] ✨ Created note #${newNote.id} from "${file.name}"`);
                }

                // Обновляем хеш
                syncState.fileHashes[file.name] = file.md5;
            } catch (fileError: any) {
                const msg = `Ошибка обработки ${file.name}: ${fileError.message}`;
                console.error(`[CloudSync] ❌ ${msg}`);
                result.errors.push(msg);
            }
        }

        // Сохраняем состояние
        syncState.lastSyncAt = new Date().toISOString();
        await saveSyncState(syncState);

        console.log(`[CloudSync] ✅ Pull complete: created=${result.created}, updated=${result.updated}, skipped=${result.skipped}`);
    } catch (error: any) {
        const msg = `Pull failed: ${error.message}`;
        console.error(`[CloudSync] ❌ ${msg}`);
        result.errors.push(msg);
    }

    return result;
}

// ============================================================================
// Background Watcher (polling)
// ============================================================================

let watcherInterval: ReturnType<typeof setInterval> | null = null;
let isWatcherRunning = false;

/**
 * Запустить фоновый watcher
 */
export function startWatcher(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
    if (watcherInterval) {
        console.log("[CloudSync] ⚠️ Watcher already running");
        return;
    }

    console.log(`[CloudSync] 🚀 Starting watcher (polling every ${intervalMs / 1000}s)`);
    isWatcherRunning = true;

    watcherInterval = setInterval(async () => {
        if (isSyncLocked()) {
            console.log("[CloudSync] 🔒 Sync locked, skipping this cycle");
            return;
        }

        try {
            const changes = await getRemoteChanges();
            const totalChanges = changes.changed.length + changes.newFiles.length;

            if (totalChanges > 0) {
                console.log(`[CloudSync] 📥 Found ${totalChanges} changes, pulling...`);
                await pullFromCloud();
            }
        } catch (error) {
            console.error("[CloudSync] ❌ Watcher cycle error:", error);
        }
    }, intervalMs);
}

/**
 * Остановить фоновый watcher
 */
export function stopWatcher(): void {
    if (watcherInterval) {
        clearInterval(watcherInterval);
        watcherInterval = null;
        isWatcherRunning = false;
        console.log("[CloudSync] ⏹️ Watcher stopped");
    }
}

/**
 * Получить статус watcher'а
 */
export async function getWatcherStatus(): Promise<{
    running: boolean;
    lastSyncAt: string | null;
    trackedFiles: number;
}> {
    const syncState = await getSyncState();
    return {
        running: isWatcherRunning,
        lastSyncAt: syncState.lastSyncAt || null,
        trackedFiles: Object.keys(syncState.fileHashes).length,
    };
}
