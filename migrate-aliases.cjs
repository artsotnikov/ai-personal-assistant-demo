// Миграция: добавление колонки aliases в таблицу competitors
const { Pool } = require('pg');
require('dotenv').config();

async function migrate() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    try {
        console.log('Добавление колонки aliases...');

        await pool.query(`
            ALTER TABLE competitors 
            ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
        `);

        console.log('✅ Миграция завершена: aliases добавлен');
    } catch (error) {
        console.error('Ошибка миграции:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();
