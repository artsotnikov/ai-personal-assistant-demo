/**
 * Миграция: Блочная система заметок + перенос документов
 * Запуск: node server/migrations/run_refactor_notes_blocks.mjs
 */
import pg from 'pg';
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

console.log('🔄 Подключение к БД...');
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
    await client.connect();
    console.log('✅ Подключено к БД\n');

    // --- ШАГ 1: Добавить колонки ---
    console.log('⏳ Шаг 1: Добавляем колонки blocks, is_immutable, source_url...');
    await client.query(`
        ALTER TABLE notes 
          ADD COLUMN IF NOT EXISTS blocks JSONB DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS is_immutable BOOLEAN DEFAULT false NOT NULL,
          ADD COLUMN IF NOT EXISTS source_url TEXT
    `);
    console.log('  ✅ Колонки добавлены');

    // --- ШАГ 2: content → blocks (только content без items) ---
    console.log('⏳ Шаг 2: Конвертируем content → blocks...');
    const r2 = await client.query(`
        UPDATE notes
        SET blocks = jsonb_build_array(
          jsonb_build_object(
            'id', gen_random_uuid()::text,
            'type', 'text',
            'content', content,
            'addedAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        )
        WHERE content IS NOT NULL AND content != '' 
          AND (items IS NULL OR items = '[]'::jsonb)
    `);
    console.log(`  ✅ Конвертировано ${r2.rowCount} заметок с content`);

    // --- ШАГ 3: items → blocks (только items без content) ---
    console.log('⏳ Шаг 3: Конвертируем items → blocks...');
    const r3 = await client.query(`
        UPDATE notes
        SET blocks = (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', COALESCE(item->>'id', gen_random_uuid()::text),
              'type', 'check',
              'content', item->>'text',
              'checked', (item->>'checked')::boolean,
              'addedAt', COALESCE(item->>'addedAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            )
          )
          FROM jsonb_array_elements(items) AS item
        )
        WHERE items IS NOT NULL AND items != '[]'::jsonb 
          AND (content IS NULL OR content = '')
    `);
    console.log(`  ✅ Конвертировано ${r3.rowCount} заметок с items`);

    // --- ШАГ 4: content + items → blocks (оба поля) ---
    console.log('⏳ Шаг 4: Конвертируем заметки с content + items...');
    const r4 = await client.query(`
        UPDATE notes
        SET blocks = 
          jsonb_build_array(
            jsonb_build_object(
              'id', gen_random_uuid()::text,
              'type', 'text',
              'content', content,
              'addedAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          ) ||
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', COALESCE(item->>'id', gen_random_uuid()::text),
                'type', 'check',
                'content', item->>'text',
                'checked', (item->>'checked')::boolean,
                'addedAt', COALESCE(item->>'addedAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              )
            )
            FROM jsonb_array_elements(items) AS item
          )
        WHERE content IS NOT NULL AND content != '' 
          AND items IS NOT NULL AND items != '[]'::jsonb
    `);
    console.log(`  ✅ Конвертировано ${r4.rowCount} заметок с content+items`);

    // --- ШАГ 5: Нормализовать типы ---
    console.log('⏳ Шаг 5: Нормализуем типы → note/document...');
    const r5 = await client.query(`
        UPDATE notes
        SET type = 'note'
        WHERE type IN ('checklist', 'shopping_list', 'draft', 'bookmark', 'tracker')
    `);
    console.log(`  ✅ Переименовано ${r5.rowCount} заметок → type='note'`);

    // --- ШАГ 6: Перенести документы ---
    console.log('⏳ Шаг 6: Переносим документы в notes...');
    const r6 = await client.query(`
        INSERT INTO notes (title, type, blocks, tags, is_immutable, is_active, is_pinned, is_archived, source_url, created_at, updated_at)
        SELECT
          d.title,
          'document',
          jsonb_build_array(
            jsonb_build_object(
              'id', gen_random_uuid()::text,
              'type', 'text',
              'content', d.content,
              'addedAt', to_char(d.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          ),
          CASE 
            WHEN d.document_type = 'general' THEN '["документ"]'::jsonb
            WHEN d.document_type = 'competitor_analysis' THEN '["документ", "конкуренты"]'::jsonb
            WHEN d.document_type = 'financial_report' THEN '["документ", "финансы"]'::jsonb
            WHEN d.document_type = 'strategy' THEN '["документ", "стратегия"]'::jsonb
            ELSE '["документ"]'::jsonb
          END,
          true,
          true,
          false,
          false,
          NULL,
          d.created_at,
          d.updated_at
        FROM documents d
        WHERE d.is_active = true
    `);
    console.log(`  ✅ Перенесено ${r6.rowCount} документов`);

    // --- Итоговая статистика ---
    const stats = await client.query(`
        SELECT 
          type,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE blocks != '[]') as with_blocks,
          COUNT(*) FILTER (WHERE is_immutable = true) as immutable
        FROM notes 
        WHERE is_active = true
        GROUP BY type
        ORDER BY type
    `);

    console.log('\n📊 Итоги миграции:');
    for (const row of stats.rows) {
        console.log(`   ${row.type}: ${row.count} записей, ${row.with_blocks} с блоками, ${row.immutable} иммутабельных`);
    }

    console.log('\n🎉 Миграция завершена успешно!');

} catch (error) {
    console.error('❌ Ошибка миграции:', error.message);
    console.error(error);
    process.exit(1);
} finally {
    await client.end();
}
