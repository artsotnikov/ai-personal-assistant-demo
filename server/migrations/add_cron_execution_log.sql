-- Cron Execution Log — Журнал выполнений cron-задач
CREATE TABLE IF NOT EXISTS cron_execution_log (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES ai_scheduled_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                -- 'success' | 'error' | 'timeout'
  response TEXT,                       -- Полный ответ AI
  agent_used TEXT,                     -- Slug экспертизы/агента
  agent_name TEXT,                     -- Человекочитаемое имя агента
  tokens_used INTEGER DEFAULT 0,
  tool_calls JSONB,                    -- [{toolName, success, durationMs}]
  duration_ms INTEGER,                 -- Время выполнения (мс)
  error TEXT,                          -- Текст ошибки
  executed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индекс для быстрого получения логов задачи
CREATE INDEX IF NOT EXISTS idx_cron_execution_log_task_id
  ON cron_execution_log (task_id, executed_at DESC);

-- Индекс для общей сортировки
CREATE INDEX IF NOT EXISTS idx_cron_execution_log_executed_at
  ON cron_execution_log (executed_at DESC);
