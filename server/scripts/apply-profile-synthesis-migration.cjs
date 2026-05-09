#!/usr/bin/env node
/**
 * Миграция: Profile Synthesis — Living Persona Model
 * Добавляет колонки is_current и stability_level в user_profile
 *
 * Запуск:
 *   node server/scripts/apply-profile-synthesis-migration.cjs
 */

'use strict';

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL не задан.');
    process.exit(1);
}

const client = new Client({ connectionString: DATABASE_URL });

async function run() {
    await client.connect();
    console.log('✅ Подключение к БД установлено');

    const steps = [
        {
            name: 'Добавить колонку is_current',
            sql: `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true NOT NULL`,
        },
        {
            name: 'Добавить колонку stability_level',
            sql: `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS stability_level TEXT DEFAULT 'dynamic' NOT NULL`,
        },
        {
            name: 'Индекс по is_current',
            sql: `CREATE INDEX IF NOT EXISTS idx_user_profile_is_current ON user_profile (is_current)`,
        },
        {
            name: 'Индекс по category + is_current',
            sql: `CREATE INDEX IF NOT EXISTS idx_user_profile_category_current ON user_profile (category, is_current)`,
        },
        {
            name: 'Бэкфилл: пометить записи как активные',
            sql: `UPDATE user_profile SET is_current = true WHERE is_current IS NULL`,
        },
        {
            name: 'Бэкфилл: stability_level = core для personality и values',
            sql: `UPDATE user_profile SET stability_level = 'core' WHERE category IN ('personality', 'values')`,
        },
    ];

    for (const step of steps) {
        try {
            const res = await client.query(step.sql);
            const rowsAffected = res.rowCount !== null ? ` (затронуто rows: ${res.rowCount})` : '';
            console.log(`  ✔ ${step.name}${rowsAffected}`);
        } catch (err) {
            console.error(`  ✘ ${step.name}: ${err.message}`);
            throw err;
        }
    }

    // Проверка результата
    const res = await client.query(`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'user_profile'
          AND column_name IN ('is_current', 'stability_level')
        ORDER BY column_name
    `);

    console.log('\n📋 Результат — новые колонки:');
    for (const row of res.rows) {
        console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
    }

    if (res.rows.length !== 2) {
        console.error(`\n❌ Ожидалось 2 новые колонки, найдено: ${res.rows.length}`);
        process.exit(1);
    }

    console.log('\n🧠 Миграция Profile Synthesis успешно применена!');
}

run()
    .catch(err => {
        console.error('❌ Ошибка миграции:', err.message);
        process.exit(1);
    })
    .finally(() => client.end());
