/**
 * Скрипт миграции: создание таблицы expertises
 * Запуск: npx tsx scripts/migrate-expertises.ts
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function migrate() {
    console.log("🚀 Создание таблицы expertises...");

    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS expertises (
            id SERIAL PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            prompt_template TEXT NOT NULL,
            tool_packs JSONB NOT NULL DEFAULT '["core"]',
            trigger_domains JSONB NOT NULL DEFAULT '[]',
            context_preferences JSONB DEFAULT '{}',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            priority INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    console.log("✅ Таблица expertises создана (или уже существовала)");

    // Проверяем что таблица существует
    const check = await db.execute(sql`
        SELECT COUNT(*) as cnt FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'expertises'
    `);
    console.log("✅ Проверка:", check.rows[0]);

    process.exit(0);
}

migrate().catch(err => {
    console.error("❌ Ошибка миграции:", err);
    process.exit(1);
});
