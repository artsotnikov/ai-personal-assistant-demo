-- ============================================================
-- Миграция: Блочная система заметок + перенос документов
-- Запуск: node server/migrations/run_refactor_notes_blocks.mjs
-- ============================================================

-- 1. Добавить новые колонки в notes
ALTER TABLE notes 
  ADD COLUMN IF NOT EXISTS blocks JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_immutable BOOLEAN DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- 2. Конвертировать content (text) → blocks
UPDATE notes
SET blocks = jsonb_build_array(
  jsonb_build_object(
    'id', gen_random_uuid()::text,
    'type', 'text',
    'content', content,
    'addedAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
)
WHERE content IS NOT NULL AND content != '' AND (items IS NULL OR items = '[]'::jsonb);

-- 3. Конвертировать items (checklist) → blocks
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
WHERE items IS NOT NULL AND items != '[]'::jsonb AND (content IS NULL OR content = '');

-- 4. Конвертировать заметки с ОБОИМИ полями (content + items)
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
  AND items IS NOT NULL AND items != '[]'::jsonb;

-- 5. Нормализовать type: всё кроме 'document' → 'note'
UPDATE notes
SET type = 'note'
WHERE type IN ('checklist', 'shopping_list', 'draft', 'bookmark', 'tracker');

-- 6. Перенести документы из таблицы documents → notes
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
  -- Теги: document_type как тег + общий тег 'документ'
  CASE 
    WHEN d.document_type = 'general' THEN '["документ"]'::jsonb
    WHEN d.document_type = 'competitor_analysis' THEN '["документ", "конкуренты"]'::jsonb
    WHEN d.document_type = 'financial_report' THEN '["документ", "финансы"]'::jsonb
    WHEN d.document_type = 'strategy' THEN '["документ", "стратегия"]'::jsonb
    ELSE '["документ"]'::jsonb
  END,
  true,  -- is_immutable
  true,  -- is_active
  false, -- is_pinned
  false, -- is_archived
  NULL,  -- source_url
  d.created_at,
  d.updated_at
FROM documents d
WHERE d.is_active = true;

-- 7. Проверка результата
SELECT 
  type,
  COUNT(*) as count,
  COUNT(CASE WHEN blocks != '[]' THEN 1 END) as with_blocks
FROM notes 
WHERE is_active = true
GROUP BY type
ORDER BY type;
