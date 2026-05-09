-- Skills Embedding — Семантический matching навыков
-- Добавляет колонку embedding для vector search

ALTER TABLE skills ADD COLUMN IF NOT EXISTS embedding TEXT;
