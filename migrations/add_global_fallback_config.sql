-- Миграция: Глобальная fallback-модель через ai_model_configs
-- Вместо хардкода fallback модели в коде, используем запись в БД
-- task_type = 'fallback' — одна для всех задач
-- Используем DeepSeek (уже настроен и работает для fact_judge, profile_extraction)

INSERT INTO ai_model_configs (task_type, provider, model, temperature, max_tokens, is_active, description, context_window)
VALUES ('fallback', 'deepseek', 'deepseek-chat', '0.7', 4000, true, 'Глобальная fallback-модель: используется когда основная модель для задачи недоступна', 163840)
ON CONFLICT (task_type) DO UPDATE SET 
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    is_active = EXCLUDED.is_active;
