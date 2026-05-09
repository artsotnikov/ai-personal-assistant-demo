/**
 * Скрипт миграции на pgvector для facts и topics
 * Запуск: npx tsx scripts/migrate-pgvector-facts-topics.ts
 */

import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function runMigration() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });

    console.log('🚀 Миграция pgvector для facts и topics...\n');

    try {
        // 1. Topics: добавление колонки
        console.log('1️⃣ [topics] Добавляю колонку embedding_vector...');
        await pool.query('ALTER TABLE topics ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)');
        console.log('   ✅ Колонка добавлена\n');

        // 2. Topics: миграция данных
        console.log('2️⃣ [topics] Мигрирую существующие embeddings...');
        const topicsResult = await pool.query(`
            UPDATE topics 
            SET embedding_vector = embedding::vector 
            WHERE embedding IS NOT NULL 
              AND embedding != '' 
              AND embedding_vector IS NULL
        `);
        console.log(`   ✅ Обновлено записей: ${topicsResult.rowCount}\n`);

        // 3. Topics: создание индекса
        console.log('3️⃣ [topics] Создаю HNSW индекс...');
        await pool.query(`
            CREATE INDEX IF NOT EXISTS topics_embedding_vector_hnsw_idx 
            ON topics 
            USING hnsw (embedding_vector vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        `);
        console.log('   ✅ Индекс создан\n');

        // 4. Facts: добавление колонки
        console.log('4️⃣ [facts] Добавляю колонку embedding_vector...');
        await pool.query('ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)');
        console.log('   ✅ Колонка добавлена\n');

        // 5. Facts: миграция данных
        console.log('5️⃣ [facts] Мигрирую существующие embeddings...');
        const factsResult = await pool.query(`
            UPDATE facts 
            SET embedding_vector = embedding::vector 
            WHERE embedding IS NOT NULL 
              AND embedding != '' 
              AND embedding_vector IS NULL
        `);
        console.log(`   ✅ Обновлено записей: ${factsResult.rowCount}\n`);

        // 6. Facts: создание индекса
        console.log('6️⃣ [facts] Создаю HNSW индекс...');
        await pool.query(`
            CREATE INDEX IF NOT EXISTS facts_embedding_vector_hnsw_idx 
            ON facts 
            USING hnsw (embedding_vector vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        `);
        console.log('   ✅ Индекс создан\n');

        // 7. Проверка
        console.log('7️⃣ Проверяю результаты...');
        const checkResult = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM topics WHERE embedding_vector IS NOT NULL) as topics_migrated,
                (SELECT COUNT(*) FROM facts WHERE embedding_vector IS NOT NULL) as facts_migrated,
                (SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE '%topics%hnsw%') as topics_idx,
                (SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE '%facts%hnsw%') as facts_idx
        `);

        const check = checkResult.rows[0];
        console.log(`   📊 topics с embedding_vector: ${check.topics_migrated}`);
        console.log(`   📊 facts с embedding_vector: ${check.facts_migrated}`);
        console.log(`   📊 HNSW индекс topics: ${check.topics_idx > 0 ? '✅' : '❌'}`);
        console.log(`   📊 HNSW индекс facts: ${check.facts_idx > 0 ? '✅' : '❌'}`);

        console.log('\n🎉 Миграция завершена успешно!');

    } catch (error: any) {
        console.error('\n❌ Ошибка миграции:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
