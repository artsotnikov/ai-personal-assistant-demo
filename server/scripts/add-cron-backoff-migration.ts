/**
 * Миграция: добавить поля backoff в таблицу ai_scheduled_tasks
 * Этап 2 OpenClaw: Consecutive Errors + Exponential Backoff
 *
 * Запуск: tsx server/scripts/add-cron-backoff-migration.ts
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

async function migrate() {
    console.log("🔄 Начинаю миграцию: add_cron_backoff...");

    try {
        await db.execute(sql`
            ALTER TABLE ai_scheduled_tasks
                ADD COLUMN IF NOT EXISTS consecutive_errors INTEGER NOT NULL DEFAULT 0
        `);
        console.log("✅ consecutive_errors — добавлено");

        await db.execute(sql`
            ALTER TABLE ai_scheduled_tasks
                ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMP
        `);
        console.log("✅ last_error_at — добавлено");

        await db.execute(sql`
            ALTER TABLE ai_scheduled_tasks
                ADD COLUMN IF NOT EXISTS backoff_until TIMESTAMP
        `);
        console.log("✅ backoff_until — добавлено");

        // Проверяем результат
        const result = await db.execute(sql`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'ai_scheduled_tasks'
              AND column_name IN ('consecutive_errors', 'last_error_at', 'backoff_until')
            ORDER BY column_name
        `);
        console.log("\n📋 Созданные колонки:");
        for (const row of result.rows) {
            console.log(`  - ${(row as any).column_name}: ${(row as any).data_type} (default: ${(row as any).column_default ?? 'NULL'})`);
        }

        console.log("\n✅ Миграция выполнена успешно!");
    } catch (error) {
        console.error("❌ Ошибка миграции:", error);
        process.exit(1);
    }

    process.exit(0);
}

migrate();
