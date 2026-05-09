-- =============================================================================
-- МИГРАЦИЯ: Добавление pgvector для быстрого поиска сущностей
-- =============================================================================
-- Выполните этот скрипт с правами суперпользователя (postgres)
-- =============================================================================

-- 1. Установка расширения pgvector (требует суперпользователя)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Добавление колонки embedding_vector типа vector(1536)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

-- 3. Миграция существующих данных из JSON-строки в vector
-- (embedding хранится как JSON-массив, конвертируем в vector)
UPDATE entities 
SET embedding_vector = embedding::vector 
WHERE embedding IS NOT NULL 
  AND embedding != '' 
  AND embedding_vector IS NULL;

-- 4. Создание HNSW индекса для быстрого косинусного поиска
-- HNSW — это приблизительный алгоритм, но очень быстрый
-- m = 16 (количество связей на слой), ef_construction = 64 (качество построения)
CREATE INDEX IF NOT EXISTS entities_embedding_vector_hnsw_idx 
ON entities 
USING hnsw (embedding_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 5. Проверка результатов
SELECT 
    'pgvector extension' as check_type,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') as result
UNION ALL
SELECT 
    'embedding_vector column',
    EXISTS(SELECT 1 FROM information_schema.columns 
           WHERE table_name = 'entities' AND column_name = 'embedding_vector')
UNION ALL
SELECT 
    'HNSW index',
    EXISTS(SELECT 1 FROM pg_indexes 
           WHERE tablename = 'entities' AND indexname LIKE '%hnsw%');
