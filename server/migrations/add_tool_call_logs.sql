-- Tool Call Logs — Логирование вызовов инструментов AI агентами
-- Хранит историю tool calling для аналитики и отладки

CREATE TABLE IF NOT EXISTS tool_call_logs (
    id SERIAL PRIMARY KEY,
    -- Контекст вызова
    session_id TEXT,
    message_id INTEGER,
    agent_slug TEXT NOT NULL,
    -- Информация о tool
    tool_name TEXT NOT NULL,
    input JSONB NOT NULL DEFAULT '{}',
    -- Результат
    success BOOLEAN NOT NULL,
    result_data JSONB,
    error TEXT,
    display_text TEXT,
    -- Метрики
    duration_ms INTEGER NOT NULL DEFAULT 0,
    iteration INTEGER NOT NULL DEFAULT 1,
    -- Временные метки
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индексы для аналитики
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_tool_name ON tool_call_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_agent_slug ON tool_call_logs(agent_slug);
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_created_at ON tool_call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_session_id ON tool_call_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_logs_success ON tool_call_logs(success);
