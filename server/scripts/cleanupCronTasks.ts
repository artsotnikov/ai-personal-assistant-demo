/**
 * Скрипт очистки дубликатов cron-задач
 * Удаляет все задачи кроме #2, #3, #31, #33
 * 
 * Запуск: npx tsx server/scripts/cleanupCronTasks.ts
 */

import { db } from "../db";
import { aiScheduledTasks, cronExecutionLog } from "@shared/schema";
import { eq, notInArray } from "drizzle-orm";

const KEEP_IDS = [2, 3, 31, 33];

async function main() {
    console.log("🧹 Очистка дубликатов cron-задач...");
    console.log(`📌 Сохраняем задачи: ${KEEP_IDS.join(", ")}`);

    // 1. Получаем список задач к удалению
    const toDelete = await db.select({ id: aiScheduledTasks.id, title: aiScheduledTasks.title })
        .from(aiScheduledTasks)
        .where(notInArray(aiScheduledTasks.id, KEEP_IDS));

    console.log(`\n🗑️  Задач к удалению: ${toDelete.length}`);
    for (const t of toDelete) {
        console.log(`   #${t.id}: "${t.title}"`);
    }

    if (toDelete.length === 0) {
        console.log("✅ Нечего удалять!");
        process.exit(0);
    }

    // 2. Удаляем журналы выполнений
    const deleteIds = toDelete.map(t => t.id);
    
    const logsDeleted = await db.delete(cronExecutionLog)
        .where(notInArray(cronExecutionLog.taskId, KEEP_IDS));
    console.log(`\n📋 Журналов удалено`);

    // 3. Удаляем задачи
    const tasksDeleted = await db.delete(aiScheduledTasks)
        .where(notInArray(aiScheduledTasks.id, KEEP_IDS));
    console.log(`🗑️  Задач удалено`);

    // 4. Проверяем результат
    const remaining = await db.select({ id: aiScheduledTasks.id, title: aiScheduledTasks.title, status: aiScheduledTasks.status })
        .from(aiScheduledTasks);
    
    console.log(`\n✅ Осталось ${remaining.length} задач:`);
    for (const t of remaining) {
        console.log(`   #${t.id}: "${t.title}" [${t.status}]`);
    }

    process.exit(0);
}

main().catch(err => {
    console.error("❌ Ошибка:", err);
    process.exit(1);
});
