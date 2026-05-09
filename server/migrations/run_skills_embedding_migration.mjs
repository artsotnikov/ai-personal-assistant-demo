/**
 * Миграция: добавление embedding колонки в skills
 * Запуск: node server/migrations/run_skills_embedding_migration.mjs
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

const sql = readFileSync(join(__dirname, 'add_skills_embedding.sql'), 'utf-8');

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД');

    console.log('🔄 Добавляю embedding колонку в skills...');
    await client.query(sql);

    console.log('✅ Миграция выполнена!');

    // Проверяем
    const result = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'skills' AND column_name = 'embedding'
    `);

    if (result.rows.length > 0) {
        console.log(`\n📋 Колонка embedding добавлена (тип: ${result.rows[0].data_type})`);
    }

    // Показываем навыки без embedding
    const skills = await client.query(`SELECT id, name FROM skills WHERE embedding IS NULL`);
    console.log(`\n⚠️ ${skills.rows.length} навыков без embedding — будут обработаны при следующем запуске`);
} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
} finally {
    await client.end();
}
