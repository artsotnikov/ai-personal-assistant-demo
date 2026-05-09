/**
 * Миграция: создание таблиц skills + user_skill_settings
 * Запуск: node server/migrations/run_skills_migration.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL не найден в .env');
    process.exit(1);
}

const sql = readFileSync(join(__dirname, 'add_skills.sql'), 'utf-8');

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД');

    console.log('🔄 Выполняю миграцию skills...');
    await client.query(sql);

    console.log('✅ Миграция выполнена успешно!');

    // Проверяем что таблицы созданы
    const result = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('skills', 'user_skill_settings')
        ORDER BY table_name
    `);

    console.log(`\n📋 Созданные таблицы: ${result.rows.map(r => r.table_name).join(', ')}`);

    // Показываем структуру skills
    const cols = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'skills'
        ORDER BY ordinal_position
    `);
    console.log(`\n📋 Таблица skills (${cols.rows.length} колонок):`);
    for (const row of cols.rows) {
        console.log(`   - ${row.column_name}: ${row.data_type}`);
    }
} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
} finally {
    await client.end();
}
