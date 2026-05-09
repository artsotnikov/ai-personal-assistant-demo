/**
 * Миграция: Создание таблиц для Document Storage Architecture
 * - documents, competitors, competitor_attributes, metric_snapshots
 * - exclude_from_context поле в messages
 */
require('dotenv').config();
const { Client } = require('pg');

async function migrate() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log('✅ Connected to database');

    const queries = [
        // 1. Добавить поле exclude_from_context в messages
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS exclude_from_context BOOLEAN NOT NULL DEFAULT false`,

        // 2. Таблица documents
        `CREATE TABLE IF NOT EXISTS documents (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL,
            document_type TEXT NOT NULL,
            summary TEXT,
            embedding_vector TEXT,
            metadata JSONB,
            source_message_id INTEGER,
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )`,

        // 3. Таблица competitors
        `CREATE TABLE IF NOT EXISTS competitors (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            website TEXT,
            summary TEXT,
            embedding_vector TEXT,
            is_active BOOLEAN NOT NULL DEFAULT true,
            last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )`,

        // 4. Таблица competitor_attributes
        `CREATE TABLE IF NOT EXISTS competitor_attributes (
            id SERIAL PRIMARY KEY,
            competitor_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            category TEXT,
            source_document_id INTEGER,
            valid_from TIMESTAMP NOT NULL DEFAULT NOW(),
            valid_until TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )`,

        // 5. Таблица metric_snapshots
        `CREATE TABLE IF NOT EXISTS metric_snapshots (
            id SERIAL PRIMARY KEY,
            period TEXT NOT NULL,
            period_type TEXT NOT NULL,
            metrics JSONB NOT NULL,
            raw_content TEXT,
            changes JSONB,
            summary TEXT,
            source_message_id INTEGER,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )`,

        // 6. Индексы
        `CREATE INDEX IF NOT EXISTS idx_competitor_attributes_competitor_id ON competitor_attributes(competitor_id)`,
        `CREATE INDEX IF NOT EXISTS idx_competitor_attributes_valid ON competitor_attributes(competitor_id, valid_until)`,
        `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_period ON metric_snapshots(period)`,
        `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_exclude_context ON messages(exclude_from_context)`,
    ];

    for (const sql of queries) {
        try {
            await client.query(sql);
            const tableName = sql.match(/(?:CREATE TABLE|ALTER TABLE|CREATE INDEX).*?(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1] || 'unknown';
            console.log(`  ✅ ${tableName}`);
        } catch (err) {
            console.error(`  ❌ Error: ${err.message}`);
        }
    }

    await client.end();
    console.log('\n✅ Migration completed!');
}

migrate().catch(console.error);
