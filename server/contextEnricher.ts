/**
 * Context Enricher — Исполнитель плана обогащения контекста
 * 
 * Выполняет multi-level семантический поиск по плану от Query Planner
 * с разными порогами similarity по приоритету.
 */

import { db } from "./db";
import { facts, goals, userProfile, type Fact, type Goal, type UserProfile } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { searchFactsByQuery, searchGoalsByQuery } from "./embeddingService";
import { getProfileContextForPrompt } from "./profileManager";
import type { QueryPlan, QueryPlanItem, QueryPriority } from "./queryPlanner";

// ============================================================================
// Конфигурация порогов поиска
// ============================================================================

const SIMILARITY_THRESHOLDS: Record<QueryPriority, number> = {
    must: 0.40,        // Снижен для большего охвата
    should: 0.35,      // Снижен для связанных тем
    nice_to_have: 0.28 // Низкий порог — ловим всё связанное
};

const LIMIT_PER_QUERY: Record<QueryPriority, number> = {
    must: 10,          // Увеличено с 8
    should: 7,         // Увеличено с 5
    nice_to_have: 5    // Увеличено с 3
};

// ============================================================================
// Типы
// ============================================================================

/**
 * Результат обогащения контекста
 */
export interface EnrichedContextData {
    facts: Fact[];
    goals: Goal[];
    profile: string;
    queryStats: {
        totalQueries: number;
        factsFoundByQuery: Record<string, number>;
        totalFactsBeforeDedup: number;
        totalFactsAfterDedup: number;
    };
}

// ============================================================================
// Выполнение плана
// ============================================================================

/**
 * Выполняет план запросов и возвращает обогащённый контекст
 */
export async function executeQueryPlan(plan: QueryPlan): Promise<EnrichedContextData> {
    const factsMap = new Map<number, { fact: Fact; score: number; source: string }>();
    const queryStats: Record<string, number> = {};
    let totalFactsBeforeDedup = 0;

    // 1. Параллельно выполняем все запросы по фактам
    const factSearchPromises = plan.queries.map(async (item) => {
        const threshold = SIMILARITY_THRESHOLDS[item.priority];
        const limit = LIMIT_PER_QUERY[item.priority];

        try {
            const results = await searchFactsByQuery(item.query, limit, threshold);
            queryStats[item.query] = results.length;
            totalFactsBeforeDedup += results.length;

            return { item, results };
        } catch (error) {
            console.warn(`Ошибка поиска по запросу "${item.query}":`, error);
            queryStats[item.query] = 0;
            return { item, results: [] };
        }
    });

    const factSearchResults = await Promise.all(factSearchPromises);

    // 2. Собираем ID найденных фактов
    const allFactIds = new Set<number>();
    for (const { item, results } of factSearchResults) {
        for (const result of results) {
            allFactIds.add(result.id);

            // Сохраняем лучший score для каждого факта
            const existing = factsMap.get(result.id);
            if (!existing || result.similarity > existing.score) {
                factsMap.set(result.id, {
                    fact: null as any, // Заполним позже
                    score: result.similarity,
                    source: item.query
                });
            }
        }
    }

    // 3. Загружаем полные данные фактов одним запросом
    let enrichedFacts: Fact[] = [];
    if (allFactIds.size > 0) {
        const factIdsArray = Array.from(allFactIds);
        enrichedFacts = await db.select()
            .from(facts)
            .where(and(
                sql`${facts.id} IN (${sql.join(factIdsArray.map(id => sql`${id}`), sql`, `)})`,
                eq(facts.isCurrent, true)
            ));

        // Обновляем map с полными данными
        for (const fact of enrichedFacts) {
            const entry = factsMap.get(fact.id);
            if (entry) {
                entry.fact = fact;
            }
        }
    }

    // 4. Сортируем факты по score и берём топ-25
    const sortedFacts = Array.from(factsMap.values())
        .filter(entry => entry.fact)
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
        .map(entry => entry.fact);

    // 5. Загружаем цели если нужно
    let enrichedGoals: Goal[] = [];
    if (plan.loadGoals) {
        enrichedGoals = await db.select()
            .from(goals)
            .where(eq(goals.status, 'active'))
            .orderBy(desc(goals.updatedAt))
            .limit(10);
    }

    // 6. Загружаем профиль если нужно
    let profileContext = '';
    if (plan.loadProfile) {
        try {
            profileContext = await getProfileContextForPrompt();
        } catch (error) {
            console.warn('Ошибка загрузки профиля:', error);
        }
    }

    console.log(`🔍 Context Enricher: ${sortedFacts.length} фактов (из ${totalFactsBeforeDedup} до дедупликации), ${enrichedGoals.length} целей`);

    return {
        facts: sortedFacts,
        goals: enrichedGoals,
        profile: profileContext,
        queryStats: {
            totalQueries: plan.queries.length,
            factsFoundByQuery: queryStats,
            totalFactsBeforeDedup,
            totalFactsAfterDedup: sortedFacts.length
        }
    };
}

/**
 * Быстрый метод для простых запросов (fallback)
 */
export async function quickContextSearch(
    userMessage: string,
    limit: number = 15
): Promise<EnrichedContextData> {
    const results = await searchFactsByQuery(userMessage, limit, 0.4);

    let enrichedFacts: Fact[] = [];
    if (results.length > 0) {
        const factIds = results.map(r => r.id);
        enrichedFacts = await db.select()
            .from(facts)
            .where(and(
                sql`${facts.id} IN (${sql.join(factIds.map(id => sql`${id}`), sql`, `)})`,
                eq(facts.isCurrent, true)
            ));
    }

    const enrichedGoals = await db.select()
        .from(goals)
        .where(eq(goals.status, 'active'))
        .orderBy(desc(goals.updatedAt))
        .limit(5);

    const profileContext = await getProfileContextForPrompt();

    return {
        facts: enrichedFacts,
        goals: enrichedGoals,
        profile: profileContext,
        queryStats: {
            totalQueries: 1,
            factsFoundByQuery: { [userMessage]: results.length },
            totalFactsBeforeDedup: results.length,
            totalFactsAfterDedup: enrichedFacts.length
        }
    };
}
