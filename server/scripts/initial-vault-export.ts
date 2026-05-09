/**
 * Initial Vault Export — Разовая выгрузка всех активных заметок в Obsidian Vault
 */

import { db } from "../db";
import { notes } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { syncNoteToVault } from "../vault/VaultManager";

async function runExport() {
    console.log("🚀 [VaultExport] Начинаю экспорт заметок в /vault...");
    
    const allNotes = await db.select()
        .from(notes)
        .where(eq(notes.isActive, true));

    console.log(`🔍 [VaultExport] Найдено заметок: ${allNotes.length}`);

    let successCount = 0;
    for (const note of allNotes) {
        try {
            await syncNoteToVault(note);
            successCount++;
        } catch (error) {
            console.error(`❌ Ошибка экспорта заметки "${note.title}" (ID: ${note.id})`);
        }
    }

    console.log(`✅ [VaultExport] Готово! Экспортировано: ${successCount}/${allNotes.length}`);
    process.exit(0);
}

runExport().catch(err => {
    console.error("💥 Критическая ошибка при экспорте:", err);
    process.exit(1);
});
