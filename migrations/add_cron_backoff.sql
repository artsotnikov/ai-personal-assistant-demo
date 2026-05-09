-- Migration: add_cron_backoff
-- Adds consecutive error tracking and exponential backoff support to ai_scheduled_tasks
-- Stage 2 of OpenClaw Adoption Roadmap

ALTER TABLE ai_scheduled_tasks
  ADD COLUMN IF NOT EXISTS consecutive_errors INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS backoff_until TIMESTAMP;

-- Also add 'error_paused' as a possible status (no constraint change needed,
-- status is TEXT so it already accepts any value)

COMMENT ON COLUMN ai_scheduled_tasks.consecutive_errors IS 'Количество ошибок подряд без успешного выполнения';
COMMENT ON COLUMN ai_scheduled_tasks.last_error_at IS 'Время последней ошибки';
COMMENT ON COLUMN ai_scheduled_tasks.backoff_until IS 'Задача пропускается пока текущее время < backoff_until';
