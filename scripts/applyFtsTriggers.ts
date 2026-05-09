/**
 * Скрипт для создания FTS-триггеров
 * Запуск: npx tsx scripts/applyFtsTriggers.ts
 */

import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function applyTriggers() {
    console.log('📦 Создание FTS триггеров...\n');

    // Facts trigger function
    await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION facts_search_vector_trigger() RETURNS trigger AS $body$
        BEGIN
            NEW.search_vector := to_tsvector('simple', coalesce(NEW.content, ''));
            RETURN NEW;
        END;
        $body$ LANGUAGE plpgsql
    `));
    console.log('✅ facts_search_vector_trigger function');

    await db.execute(sql.raw('DROP TRIGGER IF EXISTS trg_facts_search_vector ON facts'));
    await db.execute(sql.raw(`
        CREATE TRIGGER trg_facts_search_vector
          BEFORE INSERT OR UPDATE OF content ON facts
          FOR EACH ROW EXECUTE FUNCTION facts_search_vector_trigger()
    `));
    console.log('✅ trg_facts_search_vector trigger');

    // Documents trigger function
    await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION documents_search_vector_trigger() RETURNS trigger AS $body$
        BEGIN
            NEW.search_vector := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, ''));
            RETURN NEW;
        END;
        $body$ LANGUAGE plpgsql
    `));
    console.log('✅ documents_search_vector_trigger function');

    await db.execute(sql.raw('DROP TRIGGER IF EXISTS trg_documents_search_vector ON documents'));
    await db.execute(sql.raw(`
        CREATE TRIGGER trg_documents_search_vector
          BEFORE INSERT OR UPDATE OF title, content ON documents
          FOR EACH ROW EXECUTE FUNCTION documents_search_vector_trigger()
    `));
    console.log('✅ trg_documents_search_vector trigger');

    // Topics trigger function
    await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION topics_search_vector_trigger() RETURNS trigger AS $body$
        BEGIN
            NEW.search_vector := to_tsvector('simple', coalesce(NEW.name, ''));
            RETURN NEW;
        END;
        $body$ LANGUAGE plpgsql
    `));
    console.log('✅ topics_search_vector_trigger function');

    await db.execute(sql.raw('DROP TRIGGER IF EXISTS trg_topics_search_vector ON topics'));
    await db.execute(sql.raw(`
        CREATE TRIGGER trg_topics_search_vector
          BEFORE INSERT OR UPDATE OF name ON topics
          FOR EACH ROW EXECUTE FUNCTION topics_search_vector_trigger()
    `));
    console.log('✅ trg_topics_search_vector trigger');

    console.log('\n✅ Все FTS триггеры успешно созданы!');
    process.exit(0);
}

applyTriggers().catch(e => {
    console.error('❌ Ошибка:', e);
    process.exit(1);
});
