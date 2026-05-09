/**
 * Скрипт миграции на pgvector
 * Запуск: npx tsx scripts/run-pgvector-migration.ts
 */

import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function runMigration() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });

    console.log('🚀 Начинаю миграцию pgvector...\n');

    try {
        // 1. Проверка/установка расширения
        console.log('1️⃣ Устанавливаю расширение vector...');
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        console.log('   ✅ Расширение vector установлено\n');

        // 2. Добавление колонки
        console.log('2️⃣ Добавляю колонку embedding_vector...');
        await pool.query('ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_vector vector(1536)');
        console.log('   ✅ Колонка добавлена\n');

        // 3. Миграция данных
        console.log('3️⃣ Мигрирую существующие embeddings...');
        const updateResult = await pool.query(`
            UPDATE entities 
            SET embedding_vector = embedding::vector 
            WHERE embedding IS NOT NULL 
              AND embedding != '' 
              AND embedding_vector IS NULL
        `);
        console.log(`   ✅ Обновлено записей: ${updateResult.rowCount}\n`);

        // 4. Создание индекса
        console.log('4️⃣ Создаю HNSW индекс...');
        await pool.query(`
            CREATE INDEX IF NOT EXISTS entities_embedding_vector_hnsw_idx 
            ON entities 
            USING hnsw (embedding_vector vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        `);
        console.log('   ✅ Индекс создан\n');

        // 5. Проверка
        console.log('5️⃣ Проверяю результаты...');
        const checkResult = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM pg_extension WHERE extname = 'vector') as ext_exists,
                (SELECT COUNT(*) FROM information_schema.columns 
                 WHERE table_name = 'entities' AND column_name = 'embedding_vector') as col_exists,
                (SELECT COUNT(*) FROM pg_indexes 
                 WHERE tablename = 'entities' AND indexname LIKE '%hnsw%') as idx_exists,
                (SELECT COUNT(*) FROM entities WHERE embedding_vector IS NOT NULL) as migrated_count
        `);

        const check = checkResult.rows[0];
        console.log(`   📊 Расширение vector: ${check.ext_exists > 0 ? '✅' : '❌'}`);
        console.log(`   📊 Колонка embedding_vector: ${check.col_exists > 0 ? '✅' : '❌'}`);
        console.log(`   📊 HNSW индекс: ${check.idx_exists > 0 ? '✅' : '❌'}`);
        console.log(`   📊 Записей с embedding_vector: ${check.migrated_count}`);

        console.log('\n🎉 Миграция завершена успешно!');

    } catch (error: any) {
        console.error('\n❌ Ошибка миграции:', error.message);
        if (error.message.includes('permission denied')) {
            console.error('\n⚠️  Требуются права суперпользователя для CREATE EXTENSION.');
            console.error('    Выполните скрипт от имени пользователя postgres.');
        }
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
