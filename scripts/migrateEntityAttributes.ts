/**
 * Миграция: создание таблицы entity_attributes
 * Запуск: npx tsx scripts/migrateEntityAttributes.ts
 */
import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function migrate() {
    console.log('🚀 Создание таблицы entity_attributes...');

    try {
        // Создаём таблицу
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS entity_attributes (
                id SERIAL PRIMARY KEY,
                entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                key VARCHAR(100) NOT NULL,
                value TEXT NOT NULL,
                value_type VARCHAR(20) DEFAULT 'text',
                importance VARCHAR(20) DEFAULT 'normal' NOT NULL,
                source_fact_id INTEGER REFERENCES facts(id) ON DELETE SET NULL,
                valid_from TIMESTAMP DEFAULT NOW() NOT NULL,
                valid_until TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW() NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW() NOT NULL
            )
        `);
        console.log('✅ Таблица entity_attributes создана');

        // Создаём индексы
        await db.execute(sql`
            CREATE INDEX IF NOT EXISTS idx_entity_attributes_entity_id 
            ON entity_attributes(entity_id)
        `);
        await db.execute(sql`
            CREATE INDEX IF NOT EXISTS idx_entity_attributes_key 
            ON entity_attributes(key)
        `);
        await db.execute(sql`
            CREATE INDEX IF NOT EXISTS idx_entity_attributes_valid 
            ON entity_attributes(entity_id, key) WHERE valid_until IS NULL
        `);
        await db.execute(sql`
            CREATE INDEX IF NOT EXISTS idx_entity_attributes_importance 
            ON entity_attributes(importance) WHERE valid_until IS NULL
        `);
        console.log('✅ Индексы созданы');

        // Проверяем
        const result = await db.execute(sql`
            SELECT COUNT(*) as count FROM information_schema.tables 
            WHERE table_name = 'entity_attributes'
        `);
        console.log('✅ Миграция завершена успешно!');

    } catch (error) {
        console.error('❌ Ошибка миграции:', error);
        process.exit(1);
    }

    process.exit(0);
}

migrate();
