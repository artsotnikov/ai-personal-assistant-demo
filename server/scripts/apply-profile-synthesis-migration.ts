/**
 * Миграция: Profile Synthesis — Living Persona Model
 * Использует проектный db-клиент (drizzle/neon).
 *
 * Запуск:
 *   npx tsx server/scripts/apply-profile-synthesis-migration.ts
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

async function run() {
    console.log("🧠 Applying Profile Synthesis migration...\n");

    const steps: Array<{ name: string; sql: string }> = [
        {
            name: "Add is_current column",
            sql: `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true NOT NULL`,
        },
        {
            name: "Add stability_level column",
            sql: `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS stability_level TEXT DEFAULT 'dynamic' NOT NULL`,
        },
        {
            name: "Create index idx_user_profile_is_current",
            sql: `CREATE INDEX IF NOT EXISTS idx_user_profile_is_current ON user_profile (is_current)`,
        },
        {
            name: "Create index idx_user_profile_category_current",
            sql: `CREATE INDEX IF NOT EXISTS idx_user_profile_category_current ON user_profile (category, is_current)`,
        },
        {
            name: "Backfill: mark all existing entries as active",
            sql: `UPDATE user_profile SET is_current = true WHERE is_current IS NULL`,
        },
        {
            name: "Backfill: set stability_level = 'core' for personality and values",
            sql: `UPDATE user_profile SET stability_level = 'core' WHERE category IN ('personality', 'values')`,
        },
    ];

    for (const step of steps) {
        try {
            const result = await db.execute(sql.raw(step.sql));
            const affected = (result as any).rowCount;
            const suffix = affected !== null && affected !== undefined
                ? ` (rows affected: ${affected})`
                : "";
            console.log(`  ✔ ${step.name}${suffix}`);
        } catch (err: any) {
            console.error(`  ✘ ${step.name}: ${err.message}`);
            throw err;
        }
    }

    // Проверка
    const check = await db.execute(sql`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'user_profile'
          AND column_name IN ('is_current', 'stability_level')
        ORDER BY column_name
    `);

    const rows = (check as any).rows ?? check ?? [];

    console.log("\n📋 Новые колонки в БД:");
    for (const row of rows) {
        console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
    }

    if (rows.length < 2) {
        throw new Error(`Ожидалось 2 колонки, найдено: ${rows.length}`);
    }

    console.log("\n✅ Миграция Profile Synthesis успешно применена!");
    process.exit(0);
}

run().catch(err => {
    console.error("\n❌ Ошибка:", err.message);
    process.exit(1);
});
