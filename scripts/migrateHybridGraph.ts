/**
 * Миграция для гибридной архитектуры Knowledge Graph
 * 
 * Запуск: npx tsx scripts/migrateHybridGraph.ts
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function migrateHybridGraph() {
    console.log("🔄 Начинаем миграцию на гибридную архитектуру Knowledge Graph...\n");

    try {
        // 1. Проверяем, существует ли колонка base_type
        const checkBaseType = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entities' AND column_name = 'base_type'
        `);

        if (checkBaseType.rows.length === 0) {
            console.log("📝 Переименовываем type -> base_type в entities...");
            await db.execute(sql`ALTER TABLE entities RENAME COLUMN type TO base_type`);
            console.log("✅ type -> base_type");
        } else {
            console.log("ℹ️ Колонка base_type уже существует");
        }

        // 2. Добавляем sub_type
        const checkSubType = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entities' AND column_name = 'sub_type'
        `);

        if (checkSubType.rows.length === 0) {
            console.log("📝 Добавляем sub_type в entities...");
            await db.execute(sql`ALTER TABLE entities ADD COLUMN sub_type TEXT`);
            console.log("✅ sub_type добавлен");
        } else {
            console.log("ℹ️ Колонка sub_type уже существует");
        }

        // 3. Добавляем cluster_id
        const checkClusterId = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entities' AND column_name = 'cluster_id'
        `);

        if (checkClusterId.rows.length === 0) {
            console.log("📝 Добавляем cluster_id в entities...");
            await db.execute(sql`ALTER TABLE entities ADD COLUMN cluster_id INTEGER`);
            console.log("✅ cluster_id добавлен");
        } else {
            console.log("ℹ️ Колонка cluster_id уже существует");
        }

        // 4. Добавляем mention_count
        const checkMentionCount = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entities' AND column_name = 'mention_count'
        `);

        if (checkMentionCount.rows.length === 0) {
            console.log("📝 Добавляем mention_count в entities...");
            await db.execute(sql`ALTER TABLE entities ADD COLUMN mention_count INTEGER DEFAULT 1 NOT NULL`);
            console.log("✅ mention_count добавлен");
        } else {
            console.log("ℹ️ Колонка mention_count уже существует");
        }

        // 5. Добавляем last_mentioned
        const checkLastMentioned = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entities' AND column_name = 'last_mentioned'
        `);

        if (checkLastMentioned.rows.length === 0) {
            console.log("📝 Добавляем last_mentioned в entities...");
            await db.execute(sql`ALTER TABLE entities ADD COLUMN last_mentioned TIMESTAMP DEFAULT NOW() NOT NULL`);
            console.log("✅ last_mentioned добавлен");
        } else {
            console.log("ℹ️ Колонка last_mentioned уже существует");
        }

        // 6. Добавляем relation_category в entity_relations
        const checkRelationCategory = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entity_relations' AND column_name = 'relation_category'
        `);

        if (checkRelationCategory.rows.length === 0) {
            console.log("📝 Добавляем relation_category в entity_relations...");
            await db.execute(sql`ALTER TABLE entity_relations ADD COLUMN relation_category TEXT DEFAULT 'semantic' NOT NULL`);
            console.log("✅ relation_category добавлен");
        } else {
            console.log("ℹ️ Колонка relation_category уже существует");
        }

        // 7. Добавляем relation_description в entity_relations
        const checkRelationDescription = await db.execute(sql`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'entity_relations' AND column_name = 'relation_description'
        `);

        if (checkRelationDescription.rows.length === 0) {
            console.log("📝 Добавляем relation_description в entity_relations...");
            await db.execute(sql`ALTER TABLE entity_relations ADD COLUMN relation_description TEXT`);
            console.log("✅ relation_description добавлен");
        } else {
            console.log("ℹ️ Колонка relation_description уже существует");
        }

        console.log("\n✅ Миграция завершена успешно!");
        console.log("\nГибридная архитектура Knowledge Graph:");
        console.log("  📌 entities.base_type — ограниченный набор (person, organization, concept, artifact, event, location)");
        console.log("  📌 entities.sub_type — AI-генерируемый подтип (свободный)");
        console.log("  📌 entity_relations.relation_category — ограниченный набор (ownership, employment, social, temporal, semantic, action)");
        console.log("  📌 entity_relations.relationType — AI-генерируемый тип связи (свободный)");

    } catch (error) {
        console.error("❌ Ошибка миграции:", error);
        process.exit(1);
    }

    process.exit(0);
}

migrateHybridGraph();
