/**
 * Миграция: Улучшения системы профиля
 *   - CHECK constraint на category
 *   - Исправление неправильно категоризированных записей
 *   - NOT NULL constraint на category
 * 
 * Запуск:
 *   npx tsx server/scripts/apply-profile-improvements.ts
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

async function main() {
    console.log("🔧 Applying profile improvements...\n");

    const steps: Array<{ name: string; sql: string }> = [
        // ── Фаза 1: Исправление данных ──
        {
            name: "Fix: страх_отсутствия_уникального_предложения → emotional_triggers",
            sql: `UPDATE user_profile SET category = 'emotional_triggers' WHERE key = 'страх_отсутствия_уникального_предложения' AND category = 'weaknesses'`,
        },
        {
            name: "Fix: страх_повторения_собственного_опыта_с_сотрудниками → emotional_triggers",
            sql: `UPDATE user_profile SET category = 'emotional_triggers' WHERE key = 'страх_повторения_собственного_опыта_с_сотрудниками' AND category = 'weaknesses'`,
        },
        {
            name: "Fix: ответственность_за_клиентский_опыт_и_лояльность → values",
            sql: `UPDATE user_profile SET category = 'values' WHERE key = 'ответственность_за_клиентский_опыт_и_лояльность' AND category = 'personality'`,
        },

        // ── Фаза 2: Constraints ──
        {
            name: "Make category NOT NULL (set default for NULLs first)",
            sql: `UPDATE user_profile SET category = 'personality' WHERE category IS NULL`,
        },
        {
            name: "Add NOT NULL constraint on category",
            sql: `ALTER TABLE user_profile ALTER COLUMN category SET NOT NULL`,
        },
        {
            name: "Add CHECK constraint on category",
            sql: `ALTER TABLE user_profile ADD CONSTRAINT user_profile_category_check CHECK (category IN (
                'personality', 'values', 'ambitions', 
                'cognitive_patterns', 'strengths', 'weaknesses',
                'expertise', 'emotional_triggers', 'communication'
            ))`,
        },
    ];

    for (const step of steps) {
        try {
            await db.execute(sql.raw(step.sql));
            console.log(`  ✅ ${step.name}`);
        } catch (err: any) {
            // Пропускаем если constraint уже существует
            if (err.message?.includes("already exists") || err.message?.includes("already NOT NULL")) {
                console.log(`  ⏭️ ${step.name} (already applied)`);
            } else {
                console.error(`  ❌ ${step.name}: ${err.message}`);
            }
        }
    }

    // Проверяем результат
    const result = await db.execute(sql`
        SELECT category, count(*) as cnt, 
               count(*) FILTER (WHERE is_current) as active
        FROM user_profile 
        GROUP BY category 
        ORDER BY cnt DESC
    `);
    
    console.log("\n📊 Финальное распределение:");
    for (const row of result.rows as any[]) {
        console.log(`  ${row.category}: ${row.cnt} total (${row.active} active)`);
    }

    console.log("\n✅ Миграция завершена!");
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
