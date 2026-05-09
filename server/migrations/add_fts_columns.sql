-- Добавляем search_vector колонки (без триггеров — они уже созданы через applyFtsTriggers.ts)

ALTER TABLE facts ADD COLUMN IF NOT EXISTS search_vector tsvector;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;

ALTER TABLE topics ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_facts_search_vector ON facts USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON documents USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_topics_search_vector ON topics USING GIN (search_vector);

UPDATE facts SET search_vector = to_tsvector('simple', coalesce(content, '')) WHERE search_vector IS NULL;

UPDATE documents SET search_vector = to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')) WHERE search_vector IS NULL;

UPDATE topics SET search_vector = to_tsvector('simple', coalesce(name, '')) WHERE search_vector IS NULL
