-- ============================================================================
-- Миграция: Full-Text Search (FTS) для гибридного поиска
-- 
-- Добавляет tsvector-колонки и GIN-индексы к таблицам facts, documents, topics
-- для полнотекстового поиска с поддержкой русского и английского языков.
-- ============================================================================

-- 1. Таблица FACTS — добавляем tsvector-колонку
ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. Таблица DOCUMENTS — добавляем tsvector-колонку
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 3. Таблица TOPICS — добавляем tsvector-колонку
ALTER TABLE topics ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 4. GIN-индексы для быстрого FTS-поиска
CREATE INDEX IF NOT EXISTS idx_facts_search_vector ON facts USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON documents USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_topics_search_vector ON topics USING GIN (search_vector);

-- 5. Заполняем tsvector для СУЩЕСТВУЮЩИХ записей
-- Используем 'simple' конфигурацию (без стемминга) — она лучше для русского + английского + имена собственные
UPDATE facts SET search_vector = to_tsvector('simple', coalesce(content, '')) WHERE search_vector IS NULL;
UPDATE documents SET search_vector = to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')) WHERE search_vector IS NULL;
UPDATE topics SET search_vector = to_tsvector('simple', coalesce(name, '')) WHERE search_vector IS NULL;

-- 6. Триггеры для автоматического обновления tsvector при INSERT/UPDATE

-- Триггер для facts
CREATE OR REPLACE FUNCTION facts_search_vector_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_facts_search_vector ON facts;
CREATE TRIGGER trg_facts_search_vector
    BEFORE INSERT OR UPDATE OF content ON facts
    FOR EACH ROW
    EXECUTE FUNCTION facts_search_vector_trigger();

-- Триггер для documents
CREATE OR REPLACE FUNCTION documents_search_vector_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_documents_search_vector ON documents;
CREATE TRIGGER trg_documents_search_vector
    BEFORE INSERT OR UPDATE OF title, content ON documents
    FOR EACH ROW
    EXECUTE FUNCTION documents_search_vector_trigger();

-- Триггер для topics
CREATE OR REPLACE FUNCTION topics_search_vector_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', coalesce(NEW.name, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_topics_search_vector ON topics;
CREATE TRIGGER trg_topics_search_vector
    BEFORE INSERT OR UPDATE OF name ON topics
    FOR EACH ROW
    EXECUTE FUNCTION topics_search_vector_trigger();
