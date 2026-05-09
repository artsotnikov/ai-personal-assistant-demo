-- Migration: Add query_planning config to ai_model_configs
-- Date: 2026-02-03

INSERT INTO ai_model_configs (task_type, provider, model, temperature, max_tokens, is_active, description)
VALUES ('query_planning', 'custom', 'gemini-2.0-flash', '0.2', 500, true, 'AI-планирование контекстных запросов перед генерацией ответа')
ON CONFLICT (task_type) DO UPDATE SET
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    temperature = EXCLUDED.temperature,
    max_tokens = EXCLUDED.max_tokens,
    is_active = EXCLUDED.is_active,
    description = EXCLUDED.description,
    updated_at = NOW();
