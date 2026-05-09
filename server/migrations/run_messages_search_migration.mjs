/**
 * Миграция: добавление search_vector и embedding_vector к таблице messages
 * Запуск: node server/migrations/run_messages_search_migration.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем .env из корня проекта
config({ path: join(__dirname, '../../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL не найден в .env');
    process.exit(1);
}

const sql = readFileSync(join(__dirname, 'add_messages_search.sql'), 'utf-8');

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД');

    console.log('🔄 Выполняю миграцию (messages search)...');
    await client.query(sql);

    console.log('✅ Миграция выполнена успешно!');

    // Проверяем что колонки добавлены
    const result = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'messages' 
          AND column_name IN ('embedding_vector', 'search_vector')
        ORDER BY ordinal_position
    `);

    console.log(`\n📋 Новые колонки в messages:`);
    for (const row of result.rows) {
        console.log(`   - ${row.column_name}: ${row.data_type}`);
    }

    // Проверяем сколько сообщений проиндексировано FTS
    const ftsCount = await client.query(`
        SELECT count(*) as cnt FROM messages WHERE search_vector IS NOT NULL
    `);
    console.log(`\n📝 FTS-индексировано сообщений: ${ftsCount.rows[0].cnt}`);

} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
} finally {
    await client.end();
}
