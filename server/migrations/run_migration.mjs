/**
 * Миграция: создание таблицы ai_scheduled_tasks
 * Запуск: node server/migrations/run_migration.mjs
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

const sql = readFileSync(join(__dirname, 'add_ai_scheduled_tasks.sql'), 'utf-8');

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД');

    console.log('🔄 Выполняю миграцию...');
    await client.query(sql);

    console.log('✅ Миграция выполнена успешно!');

    // Проверяем что таблица создана
    const result = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'ai_scheduled_tasks'
        ORDER BY ordinal_position
    `);

    console.log(`\n📋 Таблица ai_scheduled_tasks (${result.rows.length} колонок):`);
    for (const row of result.rows) {
        console.log(`   - ${row.column_name}: ${row.data_type}`);
    }
} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
} finally {
    await client.end();
}
