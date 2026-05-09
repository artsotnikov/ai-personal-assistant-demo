/**
 * Query Planner — Планировщик контекстных запросов
 * 
 * Перед генерацией ответа AI определяет, какие данные нужны
 * из базы знаний для качественного ответа.
 * 
 * Workflow:
 * 1. Получить метаданные об источниках (getDataSourcesSummary)
 * 2. AI планирует запросы (planContextQueries)
 * 3. Выполнить multi-level поиск (executeQueryPlan в contextEnricher)
 */

import { db } from "./db";
import { topics, facts, goals, entities, userProfile } from "@shared/schema";
import { eq, sql, and, desc } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ============================================================================
// Типы
// ============================================================================

/**
 * Приоритет запроса
 */
export type QueryPriority = 'must' | 'should' | 'nice_to_have';

/**
 * Элемент плана запроса
 */
export interface QueryPlanItem {
    query: string;
    priority: QueryPriority;
    reason?: string;
}

/**
 * Полный план запроса
 */
export interface QueryPlan {
    queries: QueryPlanItem[];
    loadProfile: boolean;
    loadGoals: boolean;
    loadRecentMessages: boolean;
    reasoning?: string;
}

/**
 * Метаданные об источниках данных
 */
export interface DataSourcesSummary {
    topicCategories: string[];
    factCount: number;
    hasProfile: boolean;
    hasGoals: boolean;
    entityTypes: string[];
    summary: string;
}

// ============================================================================
// Получение метаданных об источниках
// ============================================================================

/**
 * Собираем информацию о доступных данных для промпта Query Planner
 */
export async function getDataSourcesSummary(): Promise<DataSourcesSummary> {
    const [
        topicsResult,
        factCountResult,
        profileResult,
        goalsResult,
        entitiesResult
    ] = await Promise.all([
        // Уникальные категории топиков (берём префикс до /)
        db.select({ name: topics.name })
            .from(topics)
            .orderBy(desc(topics.factCount))
            .limit(30),

        // Количество фактов
        db.select({ count: sql<number>`count(*)` })
            .from(facts)
            .where(eq(facts.isCurrent, true)),

        // Есть ли профиль
        db.select({ count: sql<number>`count(*)` })
            .from(userProfile),

        // Есть ли цели
        db.select({ count: sql<number>`count(*)` })
            .from(goals)
            .where(eq(goals.status, 'active')),

        // Типы сущностей
        db.selectDistinct({ baseType: entities.baseType })
            .from(entities)
            .where(eq(entities.isActive, true))
    ]);

    // Извлекаем категории из имён топиков (например, "Бизнес/Финансы" -> "Бизнес")
    const categories = new Set<string>();
    for (const topic of topicsResult) {
        const parts = topic.name.split('/');
        if (parts.length > 0) {
            categories.add(parts[0]);
        }
    }

    const topicCategories = Array.from(categories);
    const factCount = factCountResult[0]?.count || 0;
    const hasProfile = (profileResult[0]?.count || 0) > 0;
    const hasGoals = (goalsResult[0]?.count || 0) > 0;
    const entityTypes = entitiesResult.map(e => e.baseType).filter(Boolean) as string[];

    // Формируем текстовое описание для промпта
    const summaryParts: string[] = [];

    if (factCount > 0) {
        summaryParts.push(`• Факты: ${factCount} записей в категориях: ${topicCategories.join(', ')}`);
    }

    if (hasProfile) {
        summaryParts.push(`• Профиль: личностные характеристики, ценности, сильные/слабые стороны`);
    }

    if (hasGoals) {
        summaryParts.push(`• Цели: активные цели с дедлайнами и прогрессом`);
    }

    if (entityTypes.length > 0) {
        summaryParts.push(`• Граф знаний: сущности типов ${entityTypes.join(', ')}`);
    }

    return {
        topicCategories,
        factCount,
        hasProfile,
        hasGoals,
        entityTypes,
        summary: summaryParts.length > 0
            ? summaryParts.join('\n')
            : 'База знаний пока пуста.',
    };
}

// ============================================================================
// AI-планирование запросов
// ============================================================================

/**
 * AI планирует, какие данные искать в базе
 */
export async function planContextQueries(
    userMessage: string,
    dataSources?: DataSourcesSummary
): Promise<QueryPlan> {
    const sources = dataSources || await getDataSourcesSummary();

    const prompt = `Доступные источники данных:
${sources.summary}

Вопрос пользователя: "${userMessage}"

Определи какие данные искать. Ответ JSON:
{
  "queries": [
    {"query": "ключевое слово или фраза", "priority": "must|should|nice_to_have"}
  ],
  "loadProfile": true/false,
  "loadGoals": true/false,
  "loadRecentMessages": true/false,
  "reasoning": "краткое обоснование"
}`;

    try {
        const aiConfig = await getAIClientForTask('query_planning' as any);

        console.log(`🔍 Query Planner: используем модель ${aiConfig.model}`);

        const result = await callWithFallback(aiConfig, [
            { role: 'system', content: aiConfig.systemPrompt! },
            { role: 'user', content: prompt }
        ]);

        const content = result.content?.trim() || '';

        // Парсим ответ
        const plan = parseQueryPlanResponse(content);

        console.log(`📋 Query Planner: ${plan.queries.length} запросов, profile=${plan.loadProfile}, goals=${plan.loadGoals}`);
        if (plan.queries.length > 0) {
            console.log(`   └─ Запросы: ${plan.queries.map(q => `"${q.query}" (${q.priority})`).join(', ')}`);
        }

        return plan;

    } catch (error) {
        console.error('Ошибка Query Planner:', error);
        // Fallback — базовый план
        return createFallbackPlan(userMessage);
    }
}

/**
 * Парсинг ответа AI
 */
function parseQueryPlanResponse(content: string): QueryPlan {
    try {
        // Убираем markdown блоки если есть
        const cleanContent = content
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        const parsed = JSON.parse(cleanContent);

        // Валидируем и нормализуем
        const queries: QueryPlanItem[] = [];

        if (Array.isArray(parsed.queries)) {
            for (const q of parsed.queries) {
                if (q.query && typeof q.query === 'string') {
                    queries.push({
                        query: q.query.trim(),
                        priority: normalizePriority(q.priority),
                        reason: q.reason || undefined
                    });
                }
            }
        }

        return {
            queries: queries.slice(0, 8), // Максимум 8 запросов
            loadProfile: Boolean(parsed.loadProfile),
            loadGoals: Boolean(parsed.loadGoals),
            loadRecentMessages: parsed.loadRecentMessages !== false, // По умолчанию true
            reasoning: parsed.reasoning || undefined
        };

    } catch (error) {
        console.warn('Ошибка парсинга Query Plan, используем fallback');
        return createFallbackPlan('');
    }
}

/**
 * Нормализация приоритета
 */
function normalizePriority(priority: any): QueryPriority {
    const p = String(priority).toLowerCase();
    if (p === 'must' || p === 'critical' || p === 'required') return 'must';
    if (p === 'should' || p === 'important' || p === 'helpful') return 'should';
    return 'nice_to_have';
}

/**
 * Fallback план при ошибках AI
 */
function createFallbackPlan(userMessage: string): QueryPlan {
    // Извлекаем ключевые слова из сообщения (простая эвристика)
    const words = userMessage
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 3);

    const queries: QueryPlanItem[] = words.map(word => ({
        query: word,
        priority: 'should' as QueryPriority
    }));

    // Добавляем само сообщение как основной запрос
    if (userMessage.length > 0) {
        queries.unshift({
            query: userMessage.length > 100 ? userMessage.slice(0, 100) : userMessage,
            priority: 'must'
        });
    }

    return {
        queries,
        loadProfile: true,
        loadGoals: true,
        loadRecentMessages: true,
    };
}

// ============================================================================
// Экспорт для тестирования
// ============================================================================

export { parseQueryPlanResponse, createFallbackPlan };
