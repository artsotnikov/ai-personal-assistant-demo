import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function diagnose() {
    // Проверяем наличие колонки search_vector в каждой таблице
    const cols = await db.execute(sql.raw(`
        SELECT table_name, column_name 
        FROM information_schema.columns 
        WHERE column_name = 'search_vector' 
        AND table_name IN ('facts', 'documents', 'topics')
        ORDER BY table_name
    `));
    console.log('Колонки search_vector:', cols.rows);

    // Если facts не имеет колонки — создаём
    const hasFactsCol = (cols.rows as any[]).some(r => r.table_name === 'facts');
    if (!hasFactsCol) {
        console.log('\n⚠️ facts.search_vector не найдена! Создаём...');
        await db.execute(sql.raw('ALTER TABLE facts ADD COLUMN search_vector tsvector'));
        console.log('✅ Колонка создана');

        await db.execute(sql.raw("UPDATE facts SET search_vector = to_tsvector('simple', coalesce(content, ''))"));
        console.log('✅ Данные заполнены');

        // Проверяем индекс
        await db.execute(sql.raw('CREATE INDEX IF NOT EXISTS idx_facts_search_vector ON facts USING GIN (search_vector)'));
        console.log('✅ Индекс создан');
    }

    const hasDocsCol = (cols.rows as any[]).some(r => r.table_name === 'documents');
    if (!hasDocsCol) {
        console.log('\n⚠️ documents.search_vector не найдена! Создаём...');
        await db.execute(sql.raw('ALTER TABLE documents ADD COLUMN search_vector tsvector'));
        await db.execute(sql.raw("UPDATE documents SET search_vector = to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))"));
        await db.execute(sql.raw('CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON documents USING GIN (search_vector)'));
        console.log('✅ documents.search_vector создана и заполнена');
    }

    const hasTopicsCol = (cols.rows as any[]).some(r => r.table_name === 'topics');
    if (!hasTopicsCol) {
        console.log('\n⚠️ topics.search_vector не найдена! Создаём...');
        await db.execute(sql.raw('ALTER TABLE topics ADD COLUMN search_vector tsvector'));
        await db.execute(sql.raw("UPDATE topics SET search_vector = to_tsvector('simple', coalesce(name, ''))"));
        await db.execute(sql.raw('CREATE INDEX IF NOT EXISTS idx_topics_search_vector ON topics USING GIN (search_vector)'));
        console.log('✅ topics.search_vector создана и заполнена');
    }

    // Финальная проверка
    console.log('\n--- Финальная проверка ---');
    const finalCols = await db.execute(sql.raw(`
        SELECT table_name, column_name 
        FROM information_schema.columns 
        WHERE column_name = 'search_vector' 
        AND table_name IN ('facts', 'documents', 'topics')
    `));
    console.log('search_vector колонки:', finalCols.rows);

    const factCount = await db.execute(sql.raw('SELECT COUNT(*) as total, COUNT(search_vector) as fts FROM facts'));
    console.log('Facts:', factCount.rows[0]);

    const docCount = await db.execute(sql.raw('SELECT COUNT(*) as total, COUNT(search_vector) as fts FROM documents'));
    console.log('Documents:', docCount.rows[0]);

    const topCount = await db.execute(sql.raw('SELECT COUNT(*) as total, COUNT(search_vector) as fts FROM topics'));
    console.log('Topics:', topCount.rows[0]);

    process.exit(0);
}

diagnose().catch(e => { console.error('❌', e); process.exit(1); });
