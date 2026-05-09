-- ============================================================================
-- Миграция: Семантический поиск по сообщениям (search_messages)
-- 
-- Добавляет pgvector и tsvector колонки к таблице messages
-- для гибридного поиска (vector + FTS).
-- ============================================================================

-- 1. Колонка embedding_vector (pgvector) для семантического поиска
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

-- 2. Колонка search_vector (tsvector) для полнотекстового поиска
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 3. GIN-индекс для быстрого FTS-поиска
CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);

-- 4. Индекс для pgvector (ivfflat для быстрого ANN-поиска)
-- Используем ivfflat с cosine distance; lists=100 оптимально для < 100K записей
-- CREATE INDEX IF NOT EXISTS idx_messages_embedding_vector ON messages USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 100);

-- 5. Заполняем tsvector для СУЩЕСТВУЮЩИХ сообщений
-- Только user и ai сообщения длиной >= 30 символов
UPDATE messages 
SET search_vector = to_tsvector('simple', coalesce(content, '')) 
WHERE search_vector IS NULL 
  AND sender IN ('user', 'ai')
  AND length(content) >= 30;

-- 6. Триггер автоматического обновления tsvector при INSERT/UPDATE
CREATE OR REPLACE FUNCTION messages_search_vector_trigger() RETURNS trigger AS $$
BEGIN
    -- Индексируем только user и ai сообщения достаточной длины
    IF NEW.sender IN ('user', 'ai') AND length(coalesce(NEW.content, '')) >= 30 THEN
        NEW.search_vector := to_tsvector('simple', coalesce(NEW.content, ''));
    ELSE
        NEW.search_vector := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_search_vector ON messages;
CREATE TRIGGER trg_messages_search_vector
    BEFORE INSERT OR UPDATE OF content ON messages
    FOR EACH ROW
    EXECUTE FUNCTION messages_search_vector_trigger();
