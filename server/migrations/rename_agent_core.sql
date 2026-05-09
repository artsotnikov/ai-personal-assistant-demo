-- Миграция: переименование legacy agent taskType → agent_core
-- Дата: 2026-02-23
-- Причина: Universal Agent архитектура заменила отдельные агенты единым Core Agent

-- Переименование agent_business → agent_core (основная конфигурация Universal Agent)
UPDATE ai_model_configs SET task_type = 'agent_core' WHERE task_type = 'agent_business';

-- Удаление неиспользуемых конфигов legacy-агентов
DELETE FROM ai_model_configs WHERE task_type IN ('agent_routing', 'agent_finance', 'agent_psychology');
