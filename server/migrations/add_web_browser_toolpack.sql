-- Миграция: добавление web_browser в tool_packs всех экспертиз
-- Безопасно: добавляет только если web_browser ещё нет
-- Не затрагивает другие поля экспертиз

UPDATE expertises 
SET tool_packs = tool_packs || '["web_browser"]'::jsonb,
    updated_at = NOW()
WHERE NOT (tool_packs ? 'web_browser');
