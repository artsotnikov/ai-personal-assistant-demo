-- Stage 8: Thinking Tokens + Adaptive Planning + Preferences
-- Запуск: node server/migrations/run_stage8_migration.mjs

-- 1. Reasoning Effort в aiModelConfigs
ALTER TABLE ai_model_configs ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

-- 2. Таблица предпочтений пользователя
CREATE TABLE IF NOT EXISTS user_preferences (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  category TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  mention_count INTEGER NOT NULL DEFAULT 1,
  source TEXT DEFAULT 'auto',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индекс по категории для быстрой фильтрации
CREATE INDEX IF NOT EXISTS idx_user_preferences_category ON user_preferences(category);

-- Индекс по confidence для отсечения неуверенных предпочтений
CREATE INDEX IF NOT EXISTS idx_user_preferences_confidence ON user_preferences(confidence);
