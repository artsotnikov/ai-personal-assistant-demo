/**
 * Применение миграции Knowledge Graph v2
 */

import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function applyMigration() {
    console.log('📦 Применяю миграцию Knowledge Graph v2...\n');

    // 1. Добавляем поле role к entities
    try {
        await db.execute(sql`ALTER TABLE entities ADD COLUMN IF NOT EXISTS role TEXT`);
        console.log('✅ Добавлено поле role в entities');
    } catch (e: any) {
        console.log('⏭️ Поле role уже существует или ошибка:', e.message);
    }

    // 2. Создаём таблицу knowledge_relations
    try {
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS knowledge_relations (
                id SERIAL PRIMARY KEY,
                subject_id INTEGER NOT NULL,
                relation_type TEXT NOT NULL,
                object_id INTEGER NOT NULL,
                relation_category TEXT,
                attributes JSONB,
                context TEXT,
                source_fact_id INTEGER,
                source_message_id INTEGER,
                importance TEXT DEFAULT 'normal' NOT NULL,
                confidence TEXT DEFAULT 'medium' NOT NULL,
                valid_from TIMESTAMP DEFAULT NOW() NOT NULL,
                valid_until TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE NOT NULL,
                created_at TIMESTAMP DEFAULT NOW() NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW() NOT NULL
            )
        `);
        console.log('✅ Создана таблица knowledge_relations');
    } catch (e: any) {
        console.log('⏭️ Таблица knowledge_relations:', e.message);
    }

    // 3. Создаём сущность "Артём" как owner
    try {
        await db.execute(sql`
            INSERT INTO entities (name, base_type, role, description, embedding, confidence)
            SELECT 'Артём', 'person', 'owner', 'Владелец системы и центральная сущность графа знаний', '[]', 'high'
            WHERE NOT EXISTS (SELECT 1 FROM entities WHERE role = 'owner')
        `);
        console.log('✅ Создана сущность Артём (owner)');
    } catch (e: any) {
        console.log('⏭️ Owner entity:', e.message);
    }

    // 4. Индексы
    try {
        await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kr_subject ON knowledge_relations(subject_id)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kr_object ON knowledge_relations(object_id)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_kr_category ON knowledge_relations(relation_category)`);
        console.log('✅ Созданы индексы');
    } catch (e: any) {
        console.log('⏭️ Индексы:', e.message);
    }

    console.log('\n✅ Миграция завершена!');
    process.exit(0);
}

applyMigration();
