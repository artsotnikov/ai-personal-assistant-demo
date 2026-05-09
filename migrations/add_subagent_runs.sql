-- Sub-Agent Runs - фоновые AI-задачи (суб-агенты)
CREATE TABLE IF NOT EXISTS subagent_runs (
  id SERIAL PRIMARY KEY,
  parent_message_id INTEGER NOT NULL,
  task_type TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  system_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  tokens_used INTEGER,
  metadata JSONB,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_message ON subagent_runs(parent_message_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_created_at ON subagent_runs(created_at DESC);
