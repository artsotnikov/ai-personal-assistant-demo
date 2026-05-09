/**
 * Entity Extractor — Извлечение сущностей и связей из текста
 * 
 * ГИБРИДНАЯ АРХИТЕКТУРА:
 * - baseType (ограниченный) + subType (AI-свободный) для сущностей
 * - relationCategory (ограниченный) + relationType (AI-свободный) для связей
 * - Дедупликация через embeddings
 * - Кластеризация похожих сущностей
 */

import { db } from "./db";
import {
    entities,
    knowledgeRelations,  // Knowledge Graph v2
    sessionContext,
    type Entity,
    type InsertEntity,
    type BaseEntityType,
    type RelationCategory,
} from "@shared/schema";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { createEmbedding, serializeEmbedding, cosineSimilarity, parseEmbedding } from "./embeddingService";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// Порог похожести для дедупликации сущностей
const ENTITY_SIMILARITY_THRESHOLD = 0.85;

/**
 * Извлечённый атрибут сущности
 */
export interface ExtractedAttribute {
    key: string;                                    // "тариф", "статус", "технология"
    value: string;                                  // "18000 руб/год", "активен", "Next.js"
    valueType?: 'text' | 'number' | 'date' | 'boolean' | 'json';
    importance?: 'critical' | 'normal' | 'detail';  // Важность для контекста
}

/**
 * Извлечённая сущность из текста (гибридная структура)
 */
export interface ExtractedEntity {
    name: string;
    baseType: BaseEntityType;           // Ограниченный набор для UI
    subType?: string;                   // AI-свободный подтип
    description?: string;
    attributes?: ExtractedAttribute[];  // Атрибуты сущности
    metadata?: Record<string, any>;
    confidence: 'high' | 'medium' | 'low';
}

/**
 * Извлечённая связь между сущностями (гибридная структура)
 */
export interface ExtractedRelation {
    sourceName: string;
    targetName: string;
    relationType: string;               // AI-свободный тип связи
    relationCategory: RelationCategory; // Ограниченная категория
    relationDescription?: string;       // Семантическое описание
    strength?: number;
    metadata?: Record<string, any>;
}

/**
 * Результат извлечения из текста
 */
export interface ExtractionResult {
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
}

// ============================================================================
// Knowledge Graph v2: Relation-Centric (триплеты с контекстом)
// ============================================================================

/** Категории связей для группировки */
export type KnowledgeRelationCategory =
    | 'goals'      // планирует, хочет, стремится_к
    | 'tools'      // использует, разрабатывает
    | 'people'     // работает_с, обслуживает
    | 'problems'   // имеет_проблему_с, борется_с
    | 'fears'      // боится, избегает
    | 'habits'     // склонен_к, практикует
    | 'ownership'  // владеет, управляет
    | 'influence'  // влияет_на, блокирует
    | 'competition';  // конкурирует_с

/** Роль сущности в графе знаний */
export type EntityRole =
    | 'owner'     // Центральная сущность (Артём)
    | 'person'    // Люди
    | 'tool'      // Инструменты
    | 'project'   // Проекты
    | 'goal'      // Цели
    | 'problem'   // Проблемы
    | 'fear'      // Страхи
    | 'habit'     // Привычки
    | 'event';    // События

/**
 * Извлечённое смысловое отношение (триплет) — Knowledge Graph v2
 * Subject → relationType → Object с атрибутами
 */
export interface ExtractedKnowledgeRelation {
    // Субъект (кто/что действует)
    subject: {
        name: string;
        type: BaseEntityType;
        role?: EntityRole;
    };

    // Тип связи
    relationType: string;                    // "планирует_купить", "использует"
    relationCategory: KnowledgeRelationCategory;

    // Объект (на что направлено)
    object: {
        name: string;
        type: BaseEntityType;
        role?: EntityRole;
        description?: string;                // Краткое описание объекта
    };

    // Атрибуты СВЯЗИ (контекст хранится здесь!)
    attributes?: Record<string, string>;     // {бюджет: "500к", дедлайн: "1 мая"}

    // Зачем создана связь
    context?: string;                        // "Обсуждали цели на 2026 год"

    // Семантика
    importance?: 'critical' | 'normal' | 'detail';
}

/**
 * Извлечение сущностей и связей через AI (ГИБРИДНЫЙ промпт)
 */
export async function extractEntitiesAndRelations(text: string): Promise<ExtractionResult> {
    const aiConfig = await getAIClientForTask('entity_extraction');

    const prompt = `Проанализируй текст и извлеки СУЩНОСТИ с их АТРИБУТАМИ и СВЯЗИ между ними.

## СУЩНОСТИ

Для каждой сущности определи:
1. **name** — имя/название
2. **baseType** — ОДИН из набора: "person", "organization", "concept", "artifact", "event", "location", "other"
3. **subType** — свободный подтип (инвестор, ментор, SaaS, стартап, конкурент, MVP и т.д.)
4. **description** — краткое описание
5. **attributes** — массив атрибутов (ключевые характеристики):
   - **key**: название атрибута (тариф, статус, технология, возраст, город и т.д.)
   - **value**: значение атрибута
   - **importance**: "critical" | "normal" | "detail"
6. **confidence** — уверенность (high/medium/low)

## АТРИБУТЫ — что извлекать:
- Числовые характеристики: цены, тарифы, зарплаты, сроки
- Статусы: активен, заблокирован, в разработке
- Технологии/инструменты для продуктов
- Роли/должности для людей
- Местоположение, контакты

## СВЯЗИ

Для каждой связи:
1. **sourceName**, **targetName** — имена сущностей
2. **relationType** — тип связи (владеет, работает в, использует)
3. **relationCategory** — "ownership", "employment", "social", "temporal", "semantic", "action"
4. **strength** — сила 0-100

## ТЕКСТ
"""
${text}
"""

Ответ ТОЛЬКО в JSON:
{
  "entities": [
    {
      "name": "Юздеск", 
      "baseType": "artifact", 
      "subType": "тикет-система", 
      "description": "Система управления тикетами",
      "attributes": [
        {"key": "тариф", "value": "18000 руб/год", "importance": "critical"},
        {"key": "api", "value": "недоступен на текущем тарифе", "importance": "normal"}
      ],
      "confidence": "high"
    }
  ],
  "relations": []
}`;

    try {
        const result = await callWithFallback(aiConfig, [
            { role: "system", content: aiConfig.systemPrompt! },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";

        try {
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            const result: ExtractionResult = {
                entities: [],
                relations: [],
            };

            // Валидные baseType
            const validBaseTypes: BaseEntityType[] = ['person', 'organization', 'concept', 'artifact', 'event', 'location', 'other'];
            const validCategories: RelationCategory[] = ['ownership', 'employment', 'social', 'temporal', 'semantic', 'action'];
            const validImportance = ['critical', 'normal', 'detail'];

            // Валидация и фильтрация сущностей
            if (Array.isArray(parsed.entities)) {
                result.entities = parsed.entities.filter((e: any) =>
                    e && typeof e.name === 'string' && validBaseTypes.includes(e.baseType)
                ).map((e: any) => ({
                    name: e.name,
                    baseType: e.baseType as BaseEntityType,
                    subType: e.subType || undefined,
                    description: e.description,
                    // Парсим атрибуты
                    attributes: Array.isArray(e.attributes)
                        ? e.attributes.filter((a: any) => a && typeof a.key === 'string' && typeof a.value === 'string')
                            .map((a: any) => ({
                                key: a.key,
                                value: a.value,
                                valueType: a.valueType || 'text',
                                importance: validImportance.includes(a.importance) ? a.importance : 'normal',
                            }))
                        : [],
                    metadata: e.metadata,
                    confidence: ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'medium',
                }));
            }

            // Валидация и фильтрация связей
            if (Array.isArray(parsed.relations)) {
                result.relations = parsed.relations.filter((r: any) =>
                    r && typeof r.sourceName === 'string' && typeof r.targetName === 'string' && typeof r.relationType === 'string'
                ).map((r: any) => ({
                    sourceName: r.sourceName,
                    targetName: r.targetName,
                    relationType: r.relationType,
                    relationCategory: validCategories.includes(r.relationCategory) ? r.relationCategory : 'semantic',
                    relationDescription: r.relationDescription,
                    strength: typeof r.strength === 'number' ? r.strength : 50,
                    metadata: r.metadata,
                }));
            }

            return result;
        } catch (parseError) {
            console.error("Ошибка парсинга сущностей:", parseError, "Ответ:", content);
            return { entities: [], relations: [] };
        }
    } catch (error: any) {
        console.error("Ошибка извлечения сущностей:", error);
        return { entities: [], relations: [] };
    }
}

// ============================================================================
// Knowledge Graph v2: Извлечение триплетов
// ============================================================================

/**
 * Извлечение смысловых связей (триплетов) — Knowledge Graph v2
 * 
 * Фокус на СВЯЗЯХ с контекстом, а не изолированных сущностях.
 * Subject → relationType → Object с атрибутами
 */
export async function extractKnowledgeRelations(text: string, dialogContext?: string): Promise<ExtractedKnowledgeRelation[]> {
    const aiConfig = await getAIClientForTask('entity_extraction');

    const prompt = `Извлеки ОТНОШЕНИЯ между сущностями в формате триплетов.

## Центральная сущность: "Артём" (владелец, пользователь)

Если в тексте пользователь говорит о себе ("я", "мой", "моя", "у меня") — это Артём.

## Формат ответа (ТОЛЬКО JSON):
{
  "relations": [
    {
      "subject": {"name": "Артём", "type": "person", "role": "owner"},
      "relationType": "планирует_купить",
      "relationCategory": "goals",
      "object": {"name": "Шкода Октавия", "type": "artifact", "role": "goal", "description": "Автомобиль"},
      "attributes": {"бюджет": "500000", "дедлайн": "1 мая 2026"},
      "context": "Обсуждение целей на год",
      "importance": "critical"
    }
  ]
}

## Типы сущностей (type):
- person, organization, artifact, concept, event, location

## Роли сущностей (role):
- owner (Артём), person, tool, project, goal, problem, fear, habit, event

## Категории связей (relationCategory):
- goals: планирует, хочет, стремится_к, планирует_купить
- tools: использует, разрабатывает, планирует_заменить
- people: работает_с, обслуживает, знаком_с
- problems: имеет_проблему_с, борется_с, страдает_от
- fears: боится, избегает, тревожится_о
- habits: склонен_к, практикует
- ownership: владеет, управляет
- influence: влияет_на, блокирует, зависит_от
- competition: конкурирует_с, превосходит

## Атрибуты связи (attributes):
Храни тут КОНТЕКСТ связи: бюджет, дедлайн, статус, причина, последствия

## ВАЖНО:
1. Если можно — создавай связь от "Артём"
2. Можно создавать связи между ДРУГИМИ сущностями (не только от Артёма)
3. Атрибуты — на СВЯЗИ, не на сущности!
4. Если в тексте нет смысловых связей — верни {"relations": []}

${dialogContext ? `## Контекст диалога:\n${dialogContext}\n` : ''}
## ТЕКСТ:
"""
${text}
"""`;

    try {
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.3, maxTokens: 2000 },
            [
                { role: "system", content: aiConfig.systemPrompt || "Ты эксперт по извлечению структурированных знаний из текста." },
                { role: "user", content: prompt },
            ],
        );

        const content = result.content?.trim() || "{}";
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const parsed = JSON.parse(cleanContent);
        const relations = parsed.relations || [];

        console.log(`📊 [KG v2] Извлечено ${relations.length} триплетов`);
        return relations;

    } catch (error: any) {
        console.error("Ошибка извлечения триплетов:", error);
        return [];
    }
}

/**
 * Полный цикл: извлечение + сохранение триплетов — Knowledge Graph v2
 */
export async function extractAndSaveKnowledgeRelations(
    text: string,
    sourceMessageId?: number,
    dialogContext?: string
): Promise<{
    relationsCreated: number;
    relationsUpdated: number;
    triplets: Array<{
        subject: string;
        relation: string;
        object: string;
        category: string;
        importance: string;
    }>;
}> {
    const extracted = await extractKnowledgeRelations(text, dialogContext);

    let relationsCreated = 0;
    let relationsUpdated = 0;
    const triplets: Array<{
        subject: string;
        relation: string;
        object: string;
        category: string;
        importance: string;
    }> = [];

    await Promise.all(extracted.map(async (relation) => {
        try {
            const result = await saveKnowledgeRelation(relation, undefined, sourceMessageId);

            // Простая эвристика: если relationId < 100, скорее всего обновление
            if (result.relationId) {
                relationsCreated++;
                // Сохраняем детали для отображения в UI
                triplets.push({
                    subject: relation.subject.name,
                    relation: relation.relationType,
                    object: relation.object.name,
                    category: relation.relationCategory || 'other',
                    importance: relation.importance || 'normal',
                });
            }
        } catch (error: any) {
            console.error(`Ошибка сохранения триплета: ${error.message}`);
        }
    }));

    return { relationsCreated, relationsUpdated, triplets };
}


/**
 * Поиск существующей сущности по имени и baseType
 * Использует pgvector для быстрого поиска, fallback на O(N) если pgvector недоступен
 */
async function findExistingEntity(name: string, baseType: string): Promise<Entity | null> {
    // Сначала ищем по точному совпадению имени и baseType
    const exactMatch = await db.select()
        .from(entities)
        .where(and(
            eq(entities.name, name),
            eq(entities.baseType, baseType),
            eq(entities.isActive, true)
        ))
        .limit(1);

    if (exactMatch.length > 0) {
        return exactMatch[0];
    }

    // Создаём embedding для поиска похожих
    const embedding = await createEmbedding(name);
    const embeddingJson = serializeEmbedding(embedding);

    // Попробуем pgvector поиск (если колонка и индекс существуют)
    try {
        const pgvectorResults = await db.execute(sql`
            SELECT *, 
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM entities
            WHERE base_type = ${baseType}
              AND is_active = true
              AND embedding_vector IS NOT NULL
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT 1
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            const row = pgvectorResults.rows[0] as any;
            const similarity = row.similarity as number;

            if (similarity >= ENTITY_SIMILARITY_THRESHOLD) {
                console.log(`🔗 [pgvector] Найдена похожая сущность: "${row.name}" ≈ "${name}" (${(similarity * 100).toFixed(1)}%)`);
                // Возвращаем полную сущность из БД
                const fullEntity = await db.select()
                    .from(entities)
                    .where(eq(entities.id, row.id))
                    .limit(1);
                return fullEntity[0] || null;
            }
        }
        return null;
    } catch (pgvectorError: any) {
        // pgvector недоступен (колонка не существует или расширение не установлено)
        // Fallback на O(N) поиск
        console.log(`⚠️ pgvector недоступен, использую fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск через embeddings (legacy)
    const allEntities = await db.select()
        .from(entities)
        .where(and(
            eq(entities.baseType, baseType),
            eq(entities.isActive, true)
        ));

    for (const entity of allEntities) {
        const entityEmbedding = parseEmbedding(entity.embedding);
        if (!entityEmbedding) continue;

        const similarity = cosineSimilarity(embedding, entityEmbedding);
        if (similarity >= ENTITY_SIMILARITY_THRESHOLD) {
            console.log(`🔗 [fallback] Найдена похожая сущность: "${entity.name}" ≈ "${name}" (${(similarity * 100).toFixed(1)}%)`);
            return entity;
        }
    }

    return null;
}

/**
 * Сохранение сущности с дедупликацией (гибридная структура)
 */
export async function saveEntity(
    extracted: ExtractedEntity,
    sourceFactId?: number
): Promise<Entity> {
    // Проверяем, существует ли такая сущность
    const existing = await findExistingEntity(extracted.name, extracted.baseType);

    if (existing) {
        // Обновляем существующую: mentionCount++, lastMentioned, subType если обогащает
        await db.update(entities)
            .set({
                mentionCount: sql`${entities.mentionCount} + 1`,
                lastMentioned: new Date(),
                description: extracted.description || existing.description,
                subType: extracted.subType || existing.subType,
                metadata: { ...existing.metadata, ...extracted.metadata },
                updatedAt: new Date(),
            })
            .where(eq(entities.id, existing.id));

        console.log(`📝 Обновлена сущность: ${extracted.baseType}/${extracted.subType || ''} "${extracted.name}" (mentions: +1)`);
        return existing;
    }

    // Создаём embedding для новой сущности
    const embeddingText = [extracted.name, extracted.subType, extracted.description].filter(Boolean).join(' - ');
    const embedding = await createEmbedding(embeddingText);
    const embeddingJson = serializeEmbedding(embedding);

    const newEntity: InsertEntity = {
        name: extracted.name,
        baseType: extracted.baseType,
        subType: extracted.subType,
        description: extracted.description,
        embedding: embeddingJson,
        metadata: extracted.metadata,
        sourceFactId,
        confidence: extracted.confidence,
        mentionCount: 1,
        lastMentioned: new Date(),
        isActive: true,
    };

    const result = await db.insert(entities).values(newEntity).returning();
    const savedEntity = result[0];

    // Сохраняем embedding в pgvector колонку (если доступна)
    try {
        await db.execute(sql`
            UPDATE entities 
            SET embedding_vector = ${embeddingJson}::vector 
            WHERE id = ${savedEntity.id}
        `);
    } catch (pgvectorError: any) {
        // pgvector недоступен — пропускаем (fallback на JSON embedding)
        console.log(`⚠️ pgvector UPDATE пропущен: ${pgvectorError.message?.slice(0, 50)}`);
    }

    console.log(`✨ Создана сущность: ${extracted.baseType}/${extracted.subType || 'generic'} "${extracted.name}"`);

    return savedEntity;
}


// ============================================================================
// Knowledge Graph v2: Сохранение триплетов
// ============================================================================

/** ID сущности "Артём" (owner) */
const OWNER_ENTITY_ID = 262; // Создан при миграции

// ============================================================================
// Валидация противоречий в Knowledge Graph v2
// ============================================================================

/**
 * Пары противоречащих типов связей
 * Если приходит новая связь с типом из значения, а уже есть связь с типом из ключа,
 * старая связь помечается как устаревшая
 */
const CONTRADICTING_RELATIONS: Record<string, string[]> = {
    'владеет': ['продал', 'потерял', 'отказался_от', 'передал'],
    'использует': ['отказался_от', 'заменил', 'не_использует', 'удалил'],
    'работает_с': ['уволил', 'расстался_с', 'не_работает_с'],
    'планирует': ['отменил', 'отказался_от', 'завершил', 'выполнил'],
    'хочет': ['отказался_от', 'передумал', 'не_хочет', 'получил'],
    'интересуется': ['потерял_интерес', 'разочаровался_в'],
    'боится': ['преодолел_страх', 'больше_не_боится'],
};

/**
 * Проверяет, есть ли противоречащая связь для данной пары subject-object
 * @returns Существующая противоречащая связь или null
 */
async function checkRelationContradiction(
    subjectId: number,
    objectId: number,
    newRelationType: string
): Promise<{ id: number; relationType: string } | null> {
    // Находим все типы связей, которые противоречат новому типу
    const contradictingTypes: string[] = [];

    for (const [existingType, newTypes] of Object.entries(CONTRADICTING_RELATIONS)) {
        // Если новый тип противоречит существующему — ищем существующий
        if (newTypes.includes(newRelationType)) {
            contradictingTypes.push(existingType);
        }
        // Если существующий тип противоречит новому — тоже ищем
        if (existingType === newRelationType) {
            // В этом случае мы добавляем новую связь того же типа,
            // что уже является "противоречащим началом" — пропускаем
            continue;
        }
    }

    if (contradictingTypes.length === 0) {
        return null;
    }

    // Ищем актуальные связи с противоречащими типами (validUntil IS NULL = актуальна)
    const contradicting = await db.select({
        id: knowledgeRelations.id,
        relationType: knowledgeRelations.relationType,
    })
        .from(knowledgeRelations)
        .where(and(
            eq(knowledgeRelations.subjectId, subjectId),
            eq(knowledgeRelations.objectId, objectId),
            isNull(knowledgeRelations.validUntil),  // Актуальные записи
            sql`${knowledgeRelations.relationType} = ANY(${contradictingTypes})`
        ))
        .limit(1);

    return contradicting[0] || null;
}

/**
 * Сохранение смыслового отношения (триплета) — Knowledge Graph v2
 * 
 * Создаёт или находит сущности Subject и Object, затем сохраняет связь
 * с атрибутами и контекстом в таблицу knowledge_relations
 */
export async function saveKnowledgeRelation(
    extracted: ExtractedKnowledgeRelation,
    sourceFactId?: number,
    sourceMessageId?: number
): Promise<{ subjectId: number; objectId: number; relationId: number }> {

    // 1. Находим или создаём Subject
    let subjectId: number;
    if (extracted.subject.name.toLowerCase() === 'артём' || extracted.subject.role === 'owner') {
        subjectId = OWNER_ENTITY_ID;
    } else {
        const subjectEntity = await saveEntity({
            name: extracted.subject.name,
            baseType: extracted.subject.type,
            confidence: 'medium',
        });

        // Обновляем role если указана
        if (extracted.subject.role) {
            await db.update(entities)
                .set({ role: extracted.subject.role })
                .where(eq(entities.id, subjectEntity.id));
        }
        subjectId = subjectEntity.id;
    }

    // 2. Находим или создаём Object
    const objectEntity = await saveEntity({
        name: extracted.object.name,
        baseType: extracted.object.type,
        description: extracted.object.description,
        confidence: 'medium',
    });

    // Обновляем role если указана
    if (extracted.object.role) {
        await db.update(entities)
            .set({ role: extracted.object.role })
            .where(eq(entities.id, objectEntity.id));
    }
    const objectId = objectEntity.id;

    // 3. Проверяем на противоречия с существующими связями
    const contradiction = await checkRelationContradiction(
        subjectId, objectId, extracted.relationType
    );
    if (contradiction) {
        // Используем temporal versioning: закрываем старую версию через validUntil
        const now = new Date();
        await db.update(knowledgeRelations)
            .set({
                validUntil: now,  // Закрываем период действия старой связи
                attributes: sql`COALESCE(attributes, '{}'::jsonb) || jsonb_build_object(
                    'superseded_at', ${now.toISOString()}, 
                    'superseded_by', ${extracted.relationType}
                )`,
                updatedAt: now,
            })
            .where(eq(knowledgeRelations.id, contradiction.id));
        console.log(`⚠️ Связь версионирована: "${contradiction.relationType}" → "${extracted.relationType}" (для ${extracted.subject.name} → ${extracted.object.name})`);
    }

    // 4. Проверяем существующую связь той же категории (дедупликация)
    const existingRelation = await db.select()
        .from(knowledgeRelations)
        .where(and(
            eq(knowledgeRelations.subjectId, subjectId),
            eq(knowledgeRelations.objectId, objectId),
            eq(knowledgeRelations.relationCategory, extracted.relationCategory),
            eq(knowledgeRelations.isActive, true)
        ))
        .limit(1);

    if (existingRelation.length > 0) {
        // Обновляем существующую связь
        const existing = existingRelation[0];
        const mergedAttributes = {
            ...(existing.attributes || {}),
            ...(extracted.attributes || {}),
        };

        await db.update(knowledgeRelations)
            .set({
                relationType: extracted.relationType,
                attributes: mergedAttributes,
                context: extracted.context || existing.context,
                importance: extracted.importance || existing.importance,
                updatedAt: new Date(),
            })
            .where(eq(knowledgeRelations.id, existing.id));

        console.log(`📝 Обновлена связь: "${extracted.subject.name}" --[${extracted.relationType}]--> "${extracted.object.name}"`);
        return { subjectId, objectId, relationId: existing.id };
    }

    // 4. Создаём новую связь
    const [newRelation] = await db.insert(knowledgeRelations)
        .values({
            subjectId,
            relationType: extracted.relationType,
            objectId,
            relationCategory: extracted.relationCategory,
            attributes: extracted.attributes || {},
            context: extracted.context,
            sourceFactId,
            sourceMessageId,
            importance: extracted.importance || 'normal',
            confidence: 'medium',
            isActive: true,
        })
        .returning();

    console.log(`🔗 Создан триплет: "${extracted.subject.name}" --[${extracted.relationType}]--> "${extracted.object.name}"`);
    if (extracted.attributes && Object.keys(extracted.attributes).length > 0) {
        console.log(`   📋 Атрибуты: ${JSON.stringify(extracted.attributes)}`);
    }
    if (extracted.context) {
        console.log(`   💭 Контекст: ${extracted.context}`);
    }

    return { subjectId, objectId, relationId: newRelation.id };
}

/**
 * Полный цикл извлечения и сохранения сущностей и связей
 */
export async function extractAndSaveEntities(
    text: string,
    sourceFactId?: number
): Promise<{
    entitiesCreated: number;
    relationsCreated: number;
    entities: Array<{ name: string; baseType: string; subType: string | null; description: string | null }>;
    relations: Array<{ source: string; target: string; relationType: string; strength: number }>;
}> {
    // 1. Извлекаем сущности и связи
    const extracted = await extractEntitiesAndRelations(text);

    if (extracted.entities.length === 0) {
        return { entitiesCreated: 0, relationsCreated: 0, entities: [], relations: [] };
    }

    console.log(`🔍 Извлечено ${extracted.entities.length} сущностей, ${extracted.relations.length} связей`);

    // 2. Сохраняем сущности, атрибуты и создаём map имя -> Entity
    const entityMap = new Map<string, Entity>();
    let entitiesCreated = 0;
    const savedEntities: Array<{ name: string; baseType: string; subType: string | null; description: string | null }> = [];

    await Promise.all(extracted.entities.map(async (extractedEntity) => {
        try {
            const savedEntity = await saveEntity(extractedEntity, sourceFactId);
            entityMap.set(extractedEntity.name, savedEntity);
            entitiesCreated++;

            savedEntities.push({
                name: savedEntity.name,
                baseType: savedEntity.baseType,
                subType: savedEntity.subType,
                description: savedEntity.description
            });
        } catch (error) {
            console.error(`Ошибка сохранения сущности "${extractedEntity.name}":`, error);
        }
    }));

    // 3. Сохраняем связи
    let relationsCreated = 0;
    const savedRelations: Array<{ source: string; target: string; relationType: string; strength: number }> = [];

    await Promise.all(extracted.relations.map(async (extractedRelation) => {
        // relations disabled for legacy system
        console.warn(`Внимание: Извлечение V1 Relations больше не поддерживается. Отношение проигнорировано: ${extractedRelation.sourceName} -> ${extractedRelation.targetName}`);
    }));

    return { entitiesCreated, relationsCreated, entities: savedEntities, relations: savedRelations };
}

/**
 * Получение всех сущностей по базовому типу
 */
export async function getEntitiesByType(baseType: BaseEntityType): Promise<Entity[]> {
    return db.select()
        .from(entities)
        .where(and(
            eq(entities.baseType, baseType),
            eq(entities.isActive, true)
        ))
        .orderBy(sql`${entities.mentionCount} DESC, ${entities.name} ASC`);
}

/**
 * Получение связей для сущности
 */
export async function getEntityRelations(entityId: number): Promise<{
    outgoing: { relation: typeof knowledgeRelations.$inferSelect; target: Entity }[];
    incoming: { relation: typeof knowledgeRelations.$inferSelect; source: Entity }[];
}> {
    // Исходящие связи (эта сущность → другие)
    const outgoingRelations = await db.select()
        .from(knowledgeRelations)
        .where(and(
            eq(knowledgeRelations.subjectId, entityId),
            eq(knowledgeRelations.isActive, true)
        ));

    const outgoing = [];
    for (const rel of outgoingRelations) {
        const [target] = await db.select().from(entities).where(eq(entities.id, rel.objectId));
        if (target) {
            outgoing.push({ relation: rel, target });
        }
    }

    // Входящие связи (другие → эта сущность)
    const incomingRelations = await db.select()
        .from(knowledgeRelations)
        .where(and(
            eq(knowledgeRelations.objectId, entityId),
            eq(knowledgeRelations.isActive, true)
        ));

    const incoming = [];
    for (const rel of incomingRelations) {
        const [source] = await db.select().from(entities).where(eq(entities.id, rel.subjectId));
        if (source) {
            incoming.push({ relation: rel, source });
        }
    }

    return { outgoing, incoming };
}

/**
 * Поиск сущностей по запросу (семантический поиск)
 * Использует pgvector для быстрого поиска, fallback на O(N) если pgvector недоступен
 */
export async function searchEntities(query: string, limit: number = 10): Promise<Array<Entity & { similarity: number }>> {
    const queryEmbedding = await createEmbedding(query);
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const pgvectorResults = await db.execute(sql`
            SELECT *,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM entities
            WHERE is_active = true
              AND embedding_vector IS NOT NULL
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= 0.3
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🔍 [pgvector] Найдено ${pgvectorResults.rows.length} сущностей`);
            // Преобразуем результаты в тип Entity & { similarity }
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                name: row.name,
                baseType: row.base_type,
                subType: row.sub_type,
                role: row.role,  // Knowledge Graph v2
                description: row.description,
                embedding: row.embedding,
                embeddingVector: row.embedding_vector,
                metadata: row.metadata,
                clusterId: row.cluster_id,
                sourceFactId: row.source_fact_id,
                confidence: row.confidence,
                mentionCount: row.mention_count,
                lastMentioned: row.last_mentioned,
                isActive: row.is_active,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                similarity: row.similarity as number,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        // pgvector недоступен, fallback
        console.log(`⚠️ pgvector search недоступен, использую fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск
    const allEntities = await db.select()
        .from(entities)
        .where(eq(entities.isActive, true));

    const results: Array<Entity & { similarity: number }> = [];

    for (const entity of allEntities) {
        const entityEmbedding = parseEmbedding(entity.embedding);
        if (!entityEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, entityEmbedding);
        if (similarity >= 0.3) {
            results.push({ ...entity, similarity });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Получение полного графа связей (для визуализации)
 * Использует knowledge_relations (KG v2) вместо entity_relations
 */
export async function getFullGraph(): Promise<{
    nodes: Entity[];
    edges: Array<{
        id: number;
        sourceEntityId: number;
        targetEntityId: number;
        relationType: string;
        relationCategory: string;
        relationDescription: string | null;
        strength: number;
    }>;
}> {
    const nodes = await db.select()
        .from(entities)
        .where(eq(entities.isActive, true));

    // Fetch knowledge_relations and map to compatible format
    const knowledgeRels = await db.select()
        .from(knowledgeRelations)
        .where(eq(knowledgeRelations.isActive, true));

    // Map to edges format expected by UI
    const edges = knowledgeRels.map(kr => ({
        id: kr.id,
        sourceEntityId: kr.subjectId,
        targetEntityId: kr.objectId,
        relationType: kr.relationType,
        relationCategory: kr.relationCategory || 'other',
        relationDescription: kr.context,
        strength: kr.importance === 'critical' ? 100 : kr.importance === 'high' ? 80 : kr.importance === 'normal' ? 50 : 30,
    }));

    return { nodes, edges };
}


/**
 * Получение уникальных subTypes для UI фильтров
 */
export async function getUniqueSubTypes(): Promise<{ baseType: string; subTypes: string[] }[]> {
    const allEntities = await db.select({
        baseType: entities.baseType,
        subType: entities.subType,
    })
        .from(entities)
        .where(eq(entities.isActive, true));

    const grouped = new Map<string, Set<string>>();

    for (const e of allEntities) {
        if (!grouped.has(e.baseType)) {
            grouped.set(e.baseType, new Set());
        }
        if (e.subType) {
            grouped.get(e.baseType)!.add(e.subType);
        }
    }

    return Array.from(grouped.entries()).map(([baseType, subTypes]) => ({
        baseType,
        subTypes: Array.from(subTypes).sort(),
    }));
}

/**
 * Получение уникальных типов связей для UI
 */
export async function getUniqueRelationTypes(): Promise<{ category: string; types: string[] }[]> {
    const allRelations = await db.select({
        relationCategory: knowledgeRelations.relationCategory,
        relationType: knowledgeRelations.relationType,
    })
        .from(knowledgeRelations)
        .where(eq(knowledgeRelations.isActive, true));

    const grouped = new Map<string, Set<string>>();

    for (const r of allRelations) {
        const cat = r.relationCategory || 'other';
        if (!grouped.has(cat)) {
            grouped.set(cat, new Set());
        }
        grouped.get(cat)!.add(r.relationType);
    }

    return Array.from(grouped.entries()).map(([category, types]) => ({
        category,
        types: Array.from(types).sort(),
    }));
}

// ============================================================================
// Knowledge Graph UI: Overview, Ego-graph, Relations Table
// ============================================================================

/**
 * Статистика для дашборда Knowledge Graph (Overview tab)
 */
export async function getGraphOverview(): Promise<{
    entityCountsByType: Array<{ baseType: string; count: number }>;
    relationCountsByCategory: Array<{ category: string; count: number }>;
    recentRelations: Array<{
        id: number;
        subjectId: number;
        subjectName: string;
        relationType: string;
        objectName: string;
        category: string | null;
        importance: string;
        createdAt: Date;
    }>;
    totals: {
        entities: number;
        relations: number;
        avgConfidence: string;
    };
}> {
    // 1. Entities by base_type
    const entityCounts = await db.execute(sql`
        SELECT base_type as "baseType", COUNT(*)::int as count
        FROM entities
        WHERE is_active = true
        GROUP BY base_type
        ORDER BY count DESC
    `);

    // 2. Relations by category
    const relationCounts = await db.execute(sql`
        SELECT relation_category as category, COUNT(*)::int as count
        FROM knowledge_relations
        WHERE is_active = true
        GROUP BY relation_category
        ORDER BY count DESC
    `);

    // 3. Recent 10 relations with entity names
    const recentRels = await db.execute(sql`
        SELECT 
            kr.id,
            kr.subject_id as "subjectId",
            s.name as "subjectName",
            kr.relation_type as "relationType",
            o.name as "objectName",
            kr.relation_category as category,
            kr.importance,
            kr.created_at as "createdAt"
        FROM knowledge_relations kr
        JOIN entities s ON s.id = kr.subject_id
        JOIN entities o ON o.id = kr.object_id
        WHERE kr.is_active = true
        ORDER BY kr.created_at DESC
        LIMIT 10
    `);

    // 4. Totals
    const totalEntities = await db.execute(sql`
        SELECT COUNT(*)::int as count FROM entities WHERE is_active = true
    `);
    const totalRelations = await db.execute(sql`
        SELECT COUNT(*)::int as count FROM knowledge_relations WHERE is_active = true
    `);

    // High confidence count for avg
    const confCounts = await db.execute(sql`
        SELECT confidence, COUNT(*)::int as count
        FROM entities
        WHERE is_active = true
        GROUP BY confidence
    `);
    const confMap: Record<string, number> = {};
    let totalConf = 0;
    for (const row of (confCounts.rows || [])) {
        const r = row as any;
        confMap[r.confidence] = r.count;
        totalConf += r.count;
    }
    const highPct = totalConf > 0 ? Math.round(((confMap['high'] || 0) / totalConf) * 100) : 0;
    const avgConfidence = highPct > 50 ? 'high' : highPct > 20 ? 'medium' : 'low';

    return {
        entityCountsByType: (entityCounts.rows || []).map((r: any) => ({
            baseType: r.baseType,
            count: r.count,
        })),
        relationCountsByCategory: (relationCounts.rows || []).map((r: any) => ({
            category: r.category || 'other',
            count: r.count,
        })),
        recentRelations: (recentRels.rows || []).map((r: any) => ({
            id: r.id,
            subjectId: r.subjectId,
            subjectName: r.subjectName,
            relationType: r.relationType,
            objectName: r.objectName,
            category: r.category,
            importance: r.importance,
            createdAt: r.createdAt,
        })),
        totals: {
            entities: (totalEntities.rows?.[0] as any)?.count || 0,
            relations: (totalRelations.rows?.[0] as any)?.count || 0,
            avgConfidence,
        },
    };
}

/**
 * Эго-граф: центральная сущность + связи 1-го уровня
 * Для интерактивной навигации по графу (Relations tab)
 */
export async function getEgoGraph(
    entityId: number,
    categories?: string[]
): Promise<{
    centerEntity: Entity | null;
    nodes: Entity[];
    edges: Array<{
        id: number;
        subjectId: number;
        objectId: number;
        relationType: string;
        relationCategory: string | null;
        context: string | null;
        importance: string;
        attributes: Record<string, string> | null;
    }>;
}> {
    // 1. Center entity
    const [centerEntity] = await db.select()
        .from(entities)
        .where(and(eq(entities.id, entityId), eq(entities.isActive, true)));

    if (!centerEntity) {
        return { centerEntity: null, nodes: [], edges: [] };
    }

    // 2. Find related relations (subject or object = entityId)
    let relationsQuery = sql`
        SELECT * FROM knowledge_relations
        WHERE is_active = true
          AND (subject_id = ${entityId} OR object_id = ${entityId})
    `;

    if (categories && categories.length > 0) {
        relationsQuery = sql`
            SELECT * FROM knowledge_relations
            WHERE is_active = true
              AND (subject_id = ${entityId} OR object_id = ${entityId})
              AND relation_category IN (${sql.join(categories.map(c => sql`${c}`), sql`, `)})
        `;
    }

    relationsQuery = sql`${relationsQuery} ORDER BY created_at DESC LIMIT 50`;

    const relResult = await db.execute(relationsQuery);
    const relations = (relResult.rows || []) as any[];

    // 3. Collect related entity IDs
    const relatedIds = new Set<number>();
    relatedIds.add(entityId);
    for (const rel of relations) {
        relatedIds.add(rel.subject_id);
        relatedIds.add(rel.object_id);
    }

    // 4. Load related entities
    let relatedEntities: Entity[] = [centerEntity];
    const otherIds = Array.from(relatedIds).filter(id => id !== entityId);
    if (otherIds.length > 0) {
        const entitiesResult = await db.select()
            .from(entities)
            .where(and(
                eq(entities.isActive, true),
                sql`${entities.id} IN (${sql.join(otherIds.map(id => sql`${id}`), sql`, `)})`
            ));
        relatedEntities = [centerEntity, ...entitiesResult];
    }

    return {
        centerEntity,
        nodes: relatedEntities,
        edges: relations.map((r: any) => ({
            id: r.id,
            subjectId: r.subject_id,
            objectId: r.object_id,
            relationType: r.relation_type,
            relationCategory: r.relation_category,
            context: r.context,
            importance: r.importance,
            attributes: r.attributes,
        })),
    };
}

/**
 * Пагинированный список связей с фильтрацией (Facts tab)
 */
export async function getRelationsList(filters: {
    page?: number;
    limit?: number;
    category?: string;
    entityType?: string;
    importance?: string;
    search?: string;
}): Promise<{
    relations: Array<{
        id: number;
        subjectId: number;
        subjectName: string;
        subjectType: string;
        relationType: string;
        objectId: number;
        objectName: string;
        objectType: string;
        category: string | null;
        importance: string;
        context: string | null;
        attributes: Record<string, string> | null;
        createdAt: Date;
    }>;
    total: number;
    page: number;
    limit: number;
}> {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 20));
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const conditions: string[] = ['kr.is_active = true'];

    if (filters.category) {
        conditions.push(`kr.relation_category = '${filters.category.replace(/'/g, "''")}'`);
    }
    if (filters.importance) {
        conditions.push(`kr.importance = '${filters.importance.replace(/'/g, "''")}'`);
    }
    if (filters.entityType) {
        conditions.push(`(s.base_type = '${filters.entityType.replace(/'/g, "''")}' OR o.base_type = '${filters.entityType.replace(/'/g, "''")}')`);
    }
    if (filters.search) {
        const searchEscaped = filters.search.replace(/'/g, "''").toLowerCase();
        conditions.push(`(
            LOWER(s.name) LIKE '%${searchEscaped}%' 
            OR LOWER(o.name) LIKE '%${searchEscaped}%' 
            OR LOWER(kr.relation_type) LIKE '%${searchEscaped}%'
            OR LOWER(kr.context) LIKE '%${searchEscaped}%'
        )`);
    }

    const whereClause = conditions.join(' AND ');

    // Count total
    const countResult = await db.execute(sql.raw(`
        SELECT COUNT(*)::int as count
        FROM knowledge_relations kr
        JOIN entities s ON s.id = kr.subject_id
        JOIN entities o ON o.id = kr.object_id
        WHERE ${whereClause}
    `));
    const total = (countResult.rows?.[0] as any)?.count || 0;

    // Fetch page
    const dataResult = await db.execute(sql.raw(`
        SELECT 
            kr.id,
            kr.subject_id as "subjectId",
            s.name as "subjectName",
            s.base_type as "subjectType",
            kr.relation_type as "relationType",
            kr.object_id as "objectId",
            o.name as "objectName",
            o.base_type as "objectType",
            kr.relation_category as category,
            kr.importance,
            kr.context,
            kr.attributes,
            kr.created_at as "createdAt"
        FROM knowledge_relations kr
        JOIN entities s ON s.id = kr.subject_id
        JOIN entities o ON o.id = kr.object_id
        WHERE ${whereClause}
        ORDER BY kr.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
    `));

    return {
        relations: (dataResult.rows || []).map((r: any) => ({
            id: r.id,
            subjectId: r.subjectId,
            subjectName: r.subjectName,
            subjectType: r.subjectType,
            relationType: r.relationType,
            objectId: r.objectId,
            objectName: r.objectName,
            objectType: r.objectType,
            category: r.category,
            importance: r.importance,
            context: r.context,
            attributes: r.attributes,
            createdAt: r.createdAt,
        })),
        total,
        page,
        limit,
    };
}

// ============================================================================
// УМНЫЙ ПОИСК ПО ГРАФУ ДЛЯ КОНТЕКСТА
// ============================================================================

/**
 * Расчёт множителя свежести (мягкий decay)
 * 
 * НЕ удаляет старые сущности, а понижает их приоритет:
 * - 0-7 дней: 1.0 (свежие)
 * - 8-30 дней: 0.8 (недавние)
 * - 31-90 дней: 0.5 (старые)
 * - 91+ дней: 0.3 (архивные, но НЕ забытые)
 */
function getFreshnessMultiplier(lastMentioned: Date | string): number {
    const lastDate = typeof lastMentioned === 'string' ? new Date(lastMentioned) : lastMentioned;
    const daysSince = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysSince <= 7) return 1.0;      // Свежие
    if (daysSince <= 30) return 0.8;     // Недавние
    if (daysSince <= 90) return 0.5;     // Старые
    return 0.3;                          // Архивные (не забытые!)
}

/**
 * Расчёт общей релевантности сущности
 * 
 * Учитывает:
 * - Семантическую похожесть (similarity)
 * - Количество упоминаний (mentionCount)
 * - Свежесть (freshnessMultiplier)
 * - Уверенность (confidence)
 */
export function calculateRelevanceScore(
    entity: Entity,
    similarity: number
): number {
    const freshnessMultiplier = getFreshnessMultiplier(entity.lastMentioned);

    // Бонус за количество упоминаний (логарифмический, чтобы не доминировать)
    const mentionBonus = Math.log10(entity.mentionCount + 1) * 0.1;

    // Бонус за уверенность
    const confidenceBonus = entity.confidence === 'high' ? 0.1 :
        entity.confidence === 'medium' ? 0.05 : 0;

    // Итоговый скор: similarity * freshness + бонусы
    return (similarity * freshnessMultiplier) + mentionBonus + confidenceBonus;
}

/**
 * Результат поиска по графу для контекста
 */
export interface GraphContextResult {
    /** Найденные релевантные сущности */
    entities: Array<{
        entity: Entity;
        similarity: number;
        relevanceScore: number;  // NEW: Комбинированный скор
        matchReason: 'semantic' | 'mentioned';
    }>;
    /** Связи между найденными сущностями */
    relations: Array<{
        source: Entity;
        target: Entity;
        relationType: string;
        relationCategory: string;
        description: string | null;
        attributes: any;
        importance: string;
        strength: number;
    }>;
    /** Связанные сущности (1 уровень) — не упомянуты напрямую, но связаны */
    connectedEntities: Array<{
        entity: Entity;
        connectedVia: string; // Имя сущности, через которую связана
        relationType: string;
    }>;
}

/**
 * Умный поиск по графу для контекста
 * 
 * Стратегия:
 * 1. Семантический поиск сущностей по тексту сообщения
 * 2. Ранжирование с учётом decay (свежести) и mentionCount
 * 3. Получение связей между найденными сущностями
 * 4. Получение связанных сущностей 1-го уровня (соседи)
 */
export async function getRelevantGraphContext(
    userMessage: string,
    options: {
        /** Минимальная семантическая похожесть для основных сущностей */
        minSimilarity?: number;
        /** Максимум основных сущностей */
        maxEntities?: number;
        /** Максимум связанных сущностей (соседи) */
        maxConnected?: number;
        /** Минимальная сила связи для включения */
        minRelationStrength?: number;
        /** Опциональный фильтр по категориям связей */
        categories?: string[];
    } = {}
): Promise<GraphContextResult> {
    const {
        minSimilarity = 0.35,
        maxEntities = 10,
        maxConnected = 15,
        minRelationStrength = 30,
        categories = [],
    } = options;

    const result: GraphContextResult = {
        entities: [],
        relations: [],
        connectedEntities: []
    };

    try {
        // 1. Семантический поиск сущностей
        const semanticMatches = await searchEntities(userMessage, maxEntities * 3);

        // 2. Рассчитываем relevanceScore для каждой сущности
        const scoredEntities = semanticMatches
            .filter(e => e.similarity >= minSimilarity)
            .map(e => ({
                ...e,
                relevanceScore: calculateRelevanceScore(e, e.similarity),
            }))
            // Сортируем по relevanceScore (учитывает decay!)
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, maxEntities);

        if (scoredEntities.length === 0) {
            return result;
        }

        // Добавляем в результат
        for (const entity of scoredEntities) {
            result.entities.push({
                entity,
                similarity: entity.similarity,
                relevanceScore: entity.relevanceScore,
                matchReason: 'semantic',
            });
        }

        const entityIds = new Set(scoredEntities.map(e => e.id));
        const entityIdsList = Array.from(entityIds);

        // 2. Получаем связи МЕЖДУ найденными сущностями
        if (entityIdsList.length > 0) {
            // Формируем базовые условия
            const relationsBetweenConditions = [
                eq(knowledgeRelations.isActive, true),
                sql`${knowledgeRelations.subjectId} IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`,
                sql`${knowledgeRelations.objectId} IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`
            ];

            if (categories.length > 0) {
                relationsBetweenConditions.push(inArray(knowledgeRelations.relationCategory, categories as any));
            }

            const relationsBetween = await db.select()
                .from(knowledgeRelations)
                .where(and(...relationsBetweenConditions));

            for (const rel of relationsBetween) {
                const source = scoredEntities.find(e => e.id === rel.subjectId);
                const target = scoredEntities.find(e => e.id === rel.objectId);
                if (source && target) {
                    result.relations.push({
                        source,
                        target,
                        relationType: rel.relationType,
                        relationCategory: rel.relationCategory || 'general',
                        description: rel.context,
                        attributes: rel.attributes,
                        importance: rel.importance || 'normal',
                        strength: rel.importance === 'critical' ? 90 : rel.importance === 'normal' ? 60 : 30,
                    });
                }
            }
        }

        // 3. Получаем соседей 1-го уровня (связанные сущности)
        const connectedIds = new Set<number>();
        const connectionInfo = new Map<number, { via: string; relationType: string }>();

        if (entityIdsList.length > 0) {
            // Исходящие связи от найденных сущностей
            const outgoingConditions = [
                eq(knowledgeRelations.isActive, true),
                sql`${knowledgeRelations.subjectId} IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`,
                sql`${knowledgeRelations.objectId} NOT IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`
            ];

            if (categories.length > 0) {
                outgoingConditions.push(inArray(knowledgeRelations.relationCategory, categories as any));
            }

            const outgoingRelations = await db.select()
                .from(knowledgeRelations)
                .where(and(...outgoingConditions));

            for (const rel of outgoingRelations) {
                const strength = rel.importance === 'critical' ? 90 : rel.importance === 'normal' ? 60 : 30;
                if (strength < minRelationStrength) continue;

                if (!connectedIds.has(rel.objectId)) {
                    connectedIds.add(rel.objectId);
                    const source = scoredEntities.find(e => e.id === rel.subjectId);
                    connectionInfo.set(rel.objectId, {
                        via: source?.name || 'unknown',
                        relationType: rel.relationType,
                    });
                }
            }

            // Входящие связи к найденным сущностям
            const incomingConditions = [
                eq(knowledgeRelations.isActive, true),
                sql`${knowledgeRelations.subjectId} NOT IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`,
                sql`${knowledgeRelations.objectId} IN (${sql.join(entityIdsList.map(id => sql`${id}`), sql`, `)})`
            ];

            if (categories.length > 0) {
                incomingConditions.push(inArray(knowledgeRelations.relationCategory, categories as any));
            }

            const incomingRelations = await db.select()
                .from(knowledgeRelations)
                .where(and(...incomingConditions));

            for (const rel of incomingRelations) {
                const strength = rel.importance === 'critical' ? 90 : rel.importance === 'normal' ? 60 : 30;
                if (strength < minRelationStrength) continue;

                if (!connectedIds.has(rel.subjectId)) {
                    connectedIds.add(rel.subjectId);
                    const target = scoredEntities.find(e => e.id === rel.objectId);
                    connectionInfo.set(rel.subjectId, {
                        via: target?.name || 'unknown',
                        relationType: rel.relationType,
                    });
                }
            }
        }

        // Загружаем связанные сущности
        if (connectedIds.size > 0) {
            const connectedEntities = await db.select()
                .from(entities)
                .where(and(
                    eq(entities.isActive, true),
                    sql`${entities.id} IN (${sql.join(Array.from(connectedIds).map(id => sql`${id}`), sql`, `)})`
                ));

            // Сортируем по mentionCount (более важные сначала)
            connectedEntities.sort((a, b) => b.mentionCount - a.mentionCount);

            for (const entity of connectedEntities.slice(0, maxConnected)) {
                const info = connectionInfo.get(entity.id);
                if (info) {
                    result.connectedEntities.push({
                        entity,
                        connectedVia: info.via,
                        relationType: info.relationType,
                    });
                }
            }

            // 4. Получаем соседей 2-го уровня (через 1-й уровень)
            // Добавляем только если есть место и 1-й уровень не пустой
            const firstLevelIds = new Set(connectedEntities.map(e => e.id));
            const firstLevelIdsList = Array.from(firstLevelIds);
            const remainingSlots = maxConnected - result.connectedEntities.length;

            if (remainingSlots > 0 && firstLevelIdsList.length > 0) {
                const secondLevelIds = new Set<number>();
                const secondLevelInfo = new Map<number, { via: string; relationType: string; depth: number }>();

                const extendedExcludeIds = [...entityIdsList, ...firstLevelIdsList];
                const secOutgoingCond = [
                    eq(knowledgeRelations.isActive, true),
                    sql`${knowledgeRelations.subjectId} IN (${sql.join(firstLevelIdsList.map(id => sql`${id}`), sql`, `)})`,
                    sql`${knowledgeRelations.objectId} NOT IN (${sql.join(extendedExcludeIds.map(id => sql`${id}`), sql`, `)})`
                ];
                if (categories.length > 0) {
                    secOutgoingCond.push(inArray(knowledgeRelations.relationCategory, categories as any));
                }

                // Связи ОТ сущностей 1-го уровня (исключая уже найденные 0-го и 1-го уровней)
                const secondLevelOutgoing = await db.select()
                    .from(knowledgeRelations)
                    .where(and(...secOutgoingCond));

                for (const rel of secondLevelOutgoing) {
                    const strength = rel.importance === 'critical' ? 90 : rel.importance === 'normal' ? 60 : 30;
                    if (strength < minRelationStrength) continue;

                    if (!secondLevelIds.has(rel.objectId)) {
                        secondLevelIds.add(rel.objectId);
                        const via = connectedEntities.find(e => e.id === rel.subjectId);
                        secondLevelInfo.set(rel.objectId, {
                            via: via?.name || 'unknown',
                            relationType: rel.relationType,
                            depth: 2,
                        });
                    }
                }

                // Связи К сущностям 1-го уровня (исключая уже найденные)
                const secIncomingCond = [
                    eq(knowledgeRelations.isActive, true),
                    sql`${knowledgeRelations.subjectId} NOT IN (${sql.join(extendedExcludeIds.map(id => sql`${id}`), sql`, `)})`,
                    sql`${knowledgeRelations.objectId} IN (${sql.join(firstLevelIdsList.map(id => sql`${id}`), sql`, `)})`
                ];
                if (categories.length > 0) {
                    secIncomingCond.push(inArray(knowledgeRelations.relationCategory, categories as any));
                }

                const secondLevelIncoming = await db.select()
                    .from(knowledgeRelations)
                    .where(and(...secIncomingCond));

                for (const rel of secondLevelIncoming) {
                    const strength = rel.importance === 'critical' ? 90 : rel.importance === 'normal' ? 60 : 30;
                    if (strength < minRelationStrength) continue;

                    if (!secondLevelIds.has(rel.subjectId)) {
                        secondLevelIds.add(rel.subjectId);
                        const via = connectedEntities.find(e => e.id === rel.objectId);
                        secondLevelInfo.set(rel.subjectId, {
                            via: via?.name || 'unknown',
                            relationType: rel.relationType,
                            depth: 2,
                        });
                    }
                }

                // Загружаем сущности 2-го уровня
                if (secondLevelIds.size > 0) {
                    const secondLevelEntities = await db.select()
                        .from(entities)
                        .where(and(
                            eq(entities.isActive, true),
                            sql`${entities.id} IN (${sql.join(Array.from(secondLevelIds).map(id => sql`${id}`), sql`, `)})`
                        ));

                    // Сортируем по mentionCount и берём только нужное количество
                    secondLevelEntities.sort((a, b) => b.mentionCount - a.mentionCount);

                    for (const entity of secondLevelEntities.slice(0, remainingSlots)) {
                        const info = secondLevelInfo.get(entity.id);
                        if (info) {
                            result.connectedEntities.push({
                                entity,
                                connectedVia: `${info.via} (2-й уровень)`,
                                relationType: info.relationType,
                            });
                        }
                    }

                    if (secondLevelEntities.length > 0) {
                        console.log(`🔗 2nd level: добавлено ${Math.min(secondLevelEntities.length, remainingSlots)} сущностей`);
                    }
                }
            }
        }

    } catch (error) {
        console.error('Ошибка поиска по графу:', error);
    }

    return result;
}

/**
 * Форматирование графового контекста для промпта AI
 * 
 * Создаёт компактное текстовое представление графа
 * с приоритизацией по силе связей и группировкой по типам
 */
export function formatGraphContextForPrompt(graphContext: GraphContextResult): string {
    if (graphContext.entities.length === 0) {
        return '';
    }

    const sections: string[] = [];

    // Секция: Известные сущности (группируем по baseType)
    const entityGroups = new Map<string, typeof graphContext.entities>();
    for (const e of graphContext.entities) {
        const type = e.entity.baseType;
        if (!entityGroups.has(type)) {
            entityGroups.set(type, []);
        }
        entityGroups.get(type)!.push(e);
    }

    const typeLabels: Record<string, string> = {
        person: '👤 Люди',
        organization: '🏢 Организации',
        concept: '💡 Концепции',
        artifact: '📦 Артефакты',
        event: '📅 События',
        location: '📍 Места',
        other: '📌 Прочее',
    };

    const entitiesLines: string[] = [];
    for (const [type, entities] of Array.from(entityGroups)) {
        const label = typeLabels[type] || type;
        const items = (entities as typeof graphContext.entities)
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .map((e) => {
                const subType = e.entity.subType ? ` (${e.entity.subType})` : '';
                const desc = e.entity.description ? `: ${e.entity.description}` : '';

                return `  • ${e.entity.name}${subType}${desc}`;
            });
        entitiesLines.push(`${label}:\n${items.join('\n')}`);
    }

    sections.push(`📍 ИЗВЕСТНЫЕ СУЩНОСТИ:\n${entitiesLines.join('\n')}`);

    // Секция: Связи между сущностями (сортируем по силе)
    if (graphContext.relations.length > 0) {
        const sortedRelations = [...graphContext.relations]
            .sort((a, b) => b.strength - a.strength);

        const relationsSection = sortedRelations.map(r => {
            const strengthIcon = r.strength >= 80 ? '🔴' : r.strength >= 50 ? '🟡' : '🟢';
            const desc = r.description ? ` — ${r.description}` : '';
            const attrs = r.attributes && typeof r.attributes === 'object' && Object.keys(r.attributes).length > 0
                ? ` [${Object.entries(r.attributes).map(([k, v]) => `${k}: ${v}`).join(', ')}]`
                : '';
            return `${strengthIcon} ${r.source.name} → [${r.relationType}] → ${r.target.name}${desc}${attrs}`;
        }).join('\n');

        sections.push(`🔗 СВЯЗИ (по силе):\n${relationsSection}`);
    }

    // Секция: Связанные сущности (соседи 1-го и 2-го уровня)
    if (graphContext.connectedEntities.length > 0) {
        const connectedSection = graphContext.connectedEntities.map(c => {
            const subType = c.entity.subType ? ` (${c.entity.subType})` : '';
            const level = c.connectedVia.includes('2-й уровень') ? '↪' : '←';
            return `${level} ${c.entity.name}${subType} через "${c.connectedVia}" [${c.relationType}]`;
        }).join('\n');

        sections.push(`🌐 СВЯЗАННЫЕ СУЩНОСТИ:\n${connectedSection}`);
    }

    return sections.join('\n\n');
}

// ============================================================================
// Knowledge Graph v2: Загрузка и форматирование контекста
// ============================================================================

/** Триплет с информацией о сущностях */
interface KnowledgeRelationWithEntities {
    relation: typeof knowledgeRelations.$inferSelect;
    subject: Entity;
    object: Entity;
}

/**
 * Загрузка контекста из knowledge_relations для владельца (Артёма)
 * 
 * Возвращает все актуальные связи владельца, сгруппированные по категориям
 */
export async function getKnowledgeRelationsContext(
    options: {
        /** ID владельца (по умолчанию Артём) */
        ownerId?: number;
        /** Включать только эти категории */
        categories?: KnowledgeRelationCategory[];
        /** Максимум связей */
        limit?: number;
    } = {}
): Promise<Map<KnowledgeRelationCategory, KnowledgeRelationWithEntities[]>> {
    const { ownerId = OWNER_ENTITY_ID, limit = 50 } = options;

    const result = new Map<KnowledgeRelationCategory, KnowledgeRelationWithEntities[]>();

    try {
        // Загружаем все активные связи владельца
        const relations = await db.select()
            .from(knowledgeRelations)
            .where(and(
                eq(knowledgeRelations.subjectId, ownerId),
                eq(knowledgeRelations.isActive, true)
            ))
            .orderBy(sql`
                CASE importance 
                    WHEN 'critical' THEN 0 
                    WHEN 'normal' THEN 1 
                    ELSE 2 
                END
            `)
            .limit(limit);

        if (relations.length === 0) {
            return result;
        }

        // Загружаем сущности для всех связей
        const objectIds = Array.from(new Set(relations.map(r => r.objectId)));
        const entitiesData = await db.select()
            .from(entities)
            .where(sql`id IN (${sql.join(objectIds.map(id => sql`${id}`), sql`, `)})`);

        const entitiesMap = new Map<number, Entity>();
        for (const e of entitiesData) {
            entitiesMap.set(e.id, e);
        }

        // Загружаем subject (владелец)
        const [ownerEntity] = await db.select()
            .from(entities)
            .where(eq(entities.id, ownerId))
            .limit(1);

        if (!ownerEntity) {
            return result;
        }

        // Группируем по категориям
        for (const rel of relations) {
            const category = rel.relationCategory as KnowledgeRelationCategory;
            if (!category) continue;

            const object = entitiesMap.get(rel.objectId);
            if (!object) continue;

            if (!result.has(category)) {
                result.set(category, []);
            }

            result.get(category)!.push({
                relation: rel,
                subject: ownerEntity,
                object,
            });
        }

        console.log(`📊 [KG v2] Загружено ${relations.length} связей по ${result.size} категориям`);
        return result;

    } catch (error: any) {
        console.error('Ошибка загрузки KG v2 контекста:', error);
        return result;
    }
}

/** Иконки для категорий */
const CATEGORY_ICONS: Record<KnowledgeRelationCategory, string> = {
    goals: '🎯',
    tools: '🛠',
    people: '👥',
    problems: '⚠️',
    fears: '😰',
    habits: '🔄',
    ownership: '🏠',
    influence: '🌊',
    competition: '⚔️',
};

/** Названия категорий на русском */
const CATEGORY_NAMES: Record<KnowledgeRelationCategory, string> = {
    goals: 'ЦЕЛИ',
    tools: 'ИНСТРУМЕНТЫ',
    people: 'ЛЮДИ',
    problems: 'ПРОБЛЕМЫ',
    fears: 'СТРАХИ',
    habits: 'ПРИВЫЧКИ',
    ownership: 'ВЛАДЕНИЕ',
    influence: 'ВЛИЯНИЕ',
    competition: 'КОНКУРЕНЦИЯ',
};

/**
 * Форматирование контекста Knowledge Graph v2 для промпта AI
 * 
 * Группирует связи по категориям и компактно представляет контекст
 */
export function formatKnowledgeRelationsForPrompt(
    context: Map<KnowledgeRelationCategory, KnowledgeRelationWithEntities[]>
): string {
    if (context.size === 0) {
        return '';
    }

    const sections: string[] = ['📊 КОНТЕКСТ АРТЁМА:'];

    // Порядок категорий (самые важные first)
    const categoryOrder: KnowledgeRelationCategory[] = [
        'goals', 'problems', 'tools', 'people', 'fears', 'habits', 'ownership', 'influence', 'competition'
    ];

    for (const category of categoryOrder) {
        const relations = context.get(category);
        if (!relations || relations.length === 0) continue;

        const icon = CATEGORY_ICONS[category];
        const name = CATEGORY_NAMES[category];

        const lines = relations.map(r => {
            const objDesc = r.object.description ? ` — ${r.object.description}` : '';
            const attrs = r.relation.attributes;

            let attrStr = '';
            if (attrs && Object.keys(attrs).length > 0) {
                const attrParts = Object.entries(attrs)
                    .slice(0, 3) // Максимум 3 атрибута
                    .map(([k, v]) => `${k}: ${v}`);
                attrStr = ` (${attrParts.join(', ')})`;
            }

            return `  • ${r.relation.relationType} → ${r.object.name}${objDesc}${attrStr}`;
        });

        sections.push(`${icon} ${name}:\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
}

