-- Notes System — Универсальная система заметок
-- Заметки, списки покупок, чеклисты, черновики, закладки, трекеры

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',             -- 'note','shopping_list','checklist','draft','bookmark','tracker'
  content TEXT,                                  -- свободный текст (для note, draft, bookmark)
  items JSONB DEFAULT '[]'::jsonb,               -- [{id, text, checked, addedAt}] — для списков/чеклистов
  tags JSONB DEFAULT '[]'::jsonb,                -- ['продукты', 'срочно'] — для фильтрации
  is_pinned BOOLEAN DEFAULT FALSE NOT NULL,      -- закреплённые наверху
  is_archived BOOLEAN DEFAULT FALSE NOT NULL,    -- архивированные (скрыты из основного списка)
  is_active BOOLEAN DEFAULT TRUE NOT NULL,       -- soft delete
  source_message_id INTEGER,                     -- связь с сообщением-источником
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Индексы для быстрого доступа
CREATE INDEX IF NOT EXISTS idx_notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_active ON notes(is_active);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(is_pinned, is_active);
CREATE INDEX IF NOT EXISTS idx_notes_type_active ON notes(type, is_active);
