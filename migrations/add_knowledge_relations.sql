-- Knowledge Graph v2: Relation-Centric Schema
-- Миграция для создания knowledge_relations и добавления role к entities

-- 1. Добавляем поле role к entities
ALTER TABLE entities ADD COLUMN IF NOT EXISTS role TEXT;

-- 2. Создаём таблицу knowledge_relations
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id SERIAL PRIMARY KEY,
    
    -- Триплет: Subject → Relation → Object
    subject_id INTEGER NOT NULL REFERENCES entities(id),
    relation_type TEXT NOT NULL,
    object_id INTEGER NOT NULL REFERENCES entities(id),
    
    -- Категория связи
    relation_category TEXT,
    
    -- Атрибуты связи (контекст хранится здесь!)
    attributes JSONB,
    
    -- Контекст
    context TEXT,
    
    -- Провенанс
    source_fact_id INTEGER REFERENCES facts(id),
    source_message_id INTEGER REFERENCES messages(id),
    
    -- Семантика
    importance TEXT DEFAULT 'normal' NOT NULL,
    confidence TEXT DEFAULT 'medium' NOT NULL,
    
    -- Версионирование
    valid_from TIMESTAMP DEFAULT NOW() NOT NULL,
    valid_until TIMESTAMP,
    
    -- Метаданные
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 3. Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_subject ON knowledge_relations(subject_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_object ON knowledge_relations(object_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_category ON knowledge_relations(relation_category);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_active ON knowledge_relations(is_active) WHERE is_active = TRUE;

-- 4. Создаём сущность "Артём" как owner (если не существует)
INSERT INTO entities (name, base_type, role, description, embedding, confidence)
SELECT 'Артём', 'person', 'owner', 'Владелец системы и центральная сущность графа знаний', '[]', 'high'
WHERE NOT EXISTS (SELECT 1 FROM entities WHERE role = 'owner');

-- 5. Обновляем updatedAt для версионирования
CREATE OR REPLACE FUNCTION update_knowledge_relations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_knowledge_relations_updated_at ON knowledge_relations;
CREATE TRIGGER trigger_knowledge_relations_updated_at
    BEFORE UPDATE ON knowledge_relations
    FOR EACH ROW
    EXECUTE FUNCTION update_knowledge_relations_updated_at();
