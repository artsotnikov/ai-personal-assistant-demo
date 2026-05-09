/**
 * Миграция: переименование agent_business → agent_core
 * Запуск: node server/migrations/run_rename_agent_core.mjs
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

const sql = readFileSync(join(__dirname, 'rename_agent_core.sql'), 'utf-8');

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД');

    // Показываем текущее состояние
    const before = await client.query(`SELECT task_type, provider, model FROM ai_model_configs WHERE task_type IN ('agent_business', 'agent_routing', 'agent_finance', 'agent_psychology', 'agent_core') ORDER BY task_type`);
    console.log(`\n📋 До миграции (${before.rows.length} записей):`);
    for (const row of before.rows) {
        console.log(`   - ${row.task_type}: ${row.provider}/${row.model}`);
    }

    console.log('\n🔄 Выполняю миграцию...');
    await client.query(sql);
    console.log('✅ Миграция выполнена!');

    // Показываем результат
    const after = await client.query(`SELECT task_type, provider, model FROM ai_model_configs WHERE task_type IN ('agent_business', 'agent_routing', 'agent_finance', 'agent_psychology', 'agent_core') ORDER BY task_type`);
    console.log(`\n📋 После миграции (${after.rows.length} записей):`);
    for (const row of after.rows) {
        console.log(`   - ${row.task_type}: ${row.provider}/${row.model}`);
    }

    if (after.rows.length === 1 && after.rows[0].task_type === 'agent_core') {
        console.log('\n🎉 Всё ок! agent_business → agent_core, legacy удалены.');
    }
} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    process.exit(1);
} finally {
    await client.end();
}
