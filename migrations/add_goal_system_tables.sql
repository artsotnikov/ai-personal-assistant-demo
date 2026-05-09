-- ============================================================================
-- Фаза 1: Миграция «Живые цели» — иерархическая система целей
-- ============================================================================
-- Все операции идемпотентны (IF NOT EXISTS / IF NOT EXISTS)

-- 1. Новые поля в таблице goals
ALTER TABLE goals ADD COLUMN IF NOT EXISTS smart_description TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS parent_goal_id INTEGER;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS review_frequency TEXT DEFAULT 'weekly';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS target_review_date TIMESTAMP;

-- 2. Goal Key Results — измеримые метрики цели
CREATE TABLE IF NOT EXISTS goal_key_results (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  metric TEXT,
  target_value INTEGER,
  current_value INTEGER DEFAULT 0,
  unit TEXT,
  auto_query TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 3. Goal Milestones — вехи цели
CREATE TABLE IF NOT EXISTS goal_milestones (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0 NOT NULL,
  deadline TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 4. Goal Tasks — задачи внутри milestones
CREATE TABLE IF NOT EXISTS goal_tasks (
  id SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0 NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  due_date TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 5. Goal Activity Log — журнал активности
CREATE TABLE IF NOT EXISTS goal_activity_log (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB,
  source_message_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 6. Индексы для быстрых запросов
CREATE INDEX IF NOT EXISTS idx_goals_category ON goals(category);
CREATE INDEX IF NOT EXISTS idx_goals_priority ON goals(priority);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_parent_goal ON goals(parent_goal_id);

CREATE INDEX IF NOT EXISTS idx_goal_key_results_goal ON goal_key_results(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal ON goal_milestones(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_milestones_status ON goal_milestones(status);

CREATE INDEX IF NOT EXISTS idx_goal_tasks_milestone ON goal_tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal ON goal_tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_tasks_status ON goal_tasks(status);

CREATE INDEX IF NOT EXISTS idx_goal_activity_log_goal ON goal_activity_log(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_activity_log_type ON goal_activity_log(activity_type);
CREATE INDEX IF NOT EXISTS idx_goal_activity_log_created ON goal_activity_log(created_at DESC);
