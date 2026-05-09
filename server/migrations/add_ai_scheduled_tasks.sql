-- AI Scheduled Tasks — ИИ-управляемые периодические задачи
CREATE TABLE IF NOT EXISTS ai_scheduled_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  status TEXT NOT NULL DEFAULT 'active',
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  run_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER,
  created_by_ai BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индекс для быстрого поиска задач, которые нужно выполнить
CREATE INDEX IF NOT EXISTS idx_ai_scheduled_tasks_status_next_run
  ON ai_scheduled_tasks (status, next_run_at)
  WHERE status = 'active';

-- Индекс для сортировки по дате создания
CREATE INDEX IF NOT EXISTS idx_ai_scheduled_tasks_created_at
  ON ai_scheduled_tasks (created_at DESC);
