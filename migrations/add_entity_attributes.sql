-- Entity Attributes table for structured fact storage
-- Supports versioning (valid_until NULL = current version)
-- Supports provenance (source_fact_id links to original fact)

CREATE TABLE IF NOT EXISTS entity_attributes (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  
  -- Ключ и значение атрибута
  key VARCHAR(100) NOT NULL,                      -- "тариф", "статус", "технология"
  value TEXT NOT NULL,                            -- "18000 руб/год", "активен", "Next.js"
  value_type VARCHAR(20) DEFAULT 'text',          -- "text", "number", "date", "boolean", "json"
  
  -- Важность атрибута для контекста
  importance VARCHAR(20) DEFAULT 'normal' NOT NULL, -- "critical", "normal", "detail"
  
  -- Провенанс — откуда атрибут
  source_fact_id INTEGER REFERENCES facts(id) ON DELETE SET NULL,
  
  -- Версионирование
  valid_from TIMESTAMP DEFAULT NOW() NOT NULL,
  valid_until TIMESTAMP,                          -- NULL = актуально
  
  -- Метаданные
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_entity_attributes_entity_id ON entity_attributes(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_key ON entity_attributes(key);
CREATE INDEX IF NOT EXISTS idx_entity_attributes_valid ON entity_attributes(entity_id, key) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_entity_attributes_importance ON entity_attributes(importance) WHERE valid_until IS NULL;
