-- Migration: add_session_compaction
-- Этап 3 OpenClaw Roadmap: Session Compaction
-- Хранит резюме сжатых частей диалога (оригинальные сообщения не удаляются)

CREATE TABLE IF NOT EXISTS session_compactions (
    id               SERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL,
    summary          TEXT NOT NULL,
    compacted_message_ids  JSONB,        -- JSON-массив ID сообщений, помеченных excludeFromContext = true
    original_tokens  INTEGER,            -- Оценка токенов до сжатия
    compacted_tokens INTEGER,            -- Оценка токенов после (размер summary)
    created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_compactions_session_id
    ON session_compactions(session_id);

CREATE INDEX IF NOT EXISTS idx_session_compactions_created_at
    ON session_compactions(created_at DESC);
