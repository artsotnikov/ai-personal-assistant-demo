/**
 * Insight Engine — Проактивный движок инсайтов
 * 
 * Генерирует релевантные insights на основе:
 * - Целей и дедлайнов
 * - Графа знаний
 * - Паттернов поведения
 * - Противоречий в фактах
 * 
 * Управляет cooldown и persistence level.
 */

import { db } from "./db";
import {
    insightMemory,
    goals,
    facts,
    topics,
    messages,
    knowledgeRelations,
    entities,
    type InsightMemory,
    type InsertInsightMemory,
    type InsightType,
    type InsightStatus,
    type Goal,
    type Fact,
} from "@shared/schema";
import { eq, and, lt, gt, or, isNull, sql, desc, count } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type RelevantContext, type QueryPlanningResult } from "./contextBuilder";
import { createEmbedding, cosineSimilarity, parseEmbedding } from "./embeddingService";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import * as crypto from "crypto";

// ============================================================================
// Конфигурация
// ============================================================================

const CONFIG = {
    // Cooldown: не показывать один и тот же insight чаще чем раз в N часов
    defaultCooldownHours: 24,

    // После N упоминаний без реакции — увеличить cooldown
    maxMentionsBeforeCooldown: 3,

    // Persistence: для критических insights — напоминать даже после cooldown
    criticalTypes: ['goal_deadline', 'fact_contradiction'] as InsightType[],

    // Дедлайны: напомнить за N дней
    deadlineReminderDays: [7, 3, 1, 0],

    // Максимум insights за один ответ
    maxInsightsPerResponse: 3,

    // Минимальный usefulness score для показа
    minUsefulnessScore: 20,

    // Temporal Decay: период полураспада (дни)
    // Чем старше insight, тем ниже его эффективный score
    // score = baseScore * exp(-ageDays * ln2 / halfLifeDays)
    halfLifeDays: 14,
};

// ============================================================================
// Типы
// ============================================================================

export interface Insight {
    id?: number;  // Если уже есть в БД
    type: InsightType;
    content: string;
    priority: 'high' | 'medium' | 'low';
    relatedEntityId?: number;
    relatedEntityType?: string;
    persistenceLevel: number;
    source: 'goal' | 'graph' | 'fact' | 'pattern';
}

export interface InsightGenerationResult {
    insights: Insight[];
    totalGenerated: number;
    filteredByCoolddown: number;
    filteredByDismissed: number;
}

// ============================================================================
// Генерация инсайтов
// ============================================================================

/**
 * Главная функция — генерирует релевантные insights для текущего контекста
 */
export async function generateInsights(
    userMessage: string,
    context: RelevantContext,
    queryPlanningResult?: QueryPlanningResult | null
): Promise<InsightGenerationResult> {
    const allInsights: Insight[] = [];

    // 1. Инсайты по целям (дедлайны, прогресс)
    const goalInsights = await generateGoalInsights();
    allInsights.push(...goalInsights);

    // 2. Связь текущего сообщения с целями
    const goalRelevanceInsights = await generateGoalRelevanceInsights(userMessage);
    allInsights.push(...goalRelevanceInsights);

    // 3. Инсайты из Knowledge Graph v2 (с учётом Query Plan для повышения релевантности)
    const kgv2Insights = await generateKGv2Insights(
        userMessage,
        context.knowledgeRelationsContext,
        queryPlanningResult
    );
    allInsights.push(...kgv2Insights);

    // 4. Противоречия в фактах
    const contradictionInsights = await generateFactContradictionInsights(context.relevantFacts);
    allInsights.push(...contradictionInsights);

    // 5. Паттерны из истории сообщений
    const patternInsights = await generatePatternInsights();
    allInsights.push(...patternInsights);

    // 6. Заброшенные важные темы
    const abandonedInsights = await generateAbandonedTopicInsights();
    allInsights.push(...abandonedInsights);

    // 7. Фильтрация по cooldown и status
    const { filtered, stats } = await filterInsights(allInsights);

    // 8. Сортировка по приоритету и limit
    const sorted = filtered
        .sort((a, b) => {
            const priorityOrder = { high: 0, medium: 1, low: 2 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
        })
        .slice(0, CONFIG.maxInsightsPerResponse);

    return {
        insights: sorted,
        totalGenerated: allInsights.length,
        filteredByCoolddown: stats.cooldown,
        filteredByDismissed: stats.dismissed,
    };
}

/**
 * Генерация инсайтов по целям
 */
async function generateGoalInsights(): Promise<Insight[]> {
    const insights: Insight[] = [];

    // Получаем активные цели
    const activeGoals = await db.select()
        .from(goals)
        .where(eq(goals.status, "active"));

    const now = new Date();

    for (const goal of activeGoals) {
        // 1. Проверка дедлайнов
        if (goal.deadline) {
            const deadline = new Date(goal.deadline);
            const daysUntil = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            if (CONFIG.deadlineReminderDays.includes(daysUntil)) {
                const urgency = daysUntil === 0 ? 'high' : daysUntil <= 3 ? 'medium' : 'low';
                insights.push({
                    type: 'goal_deadline',
                    content: daysUntil === 0
                        ? `🚨 Сегодня дедлайн цели "${goal.title}"! Прогресс: ${goal.progress}%`
                        : `⏰ До дедлайна цели "${goal.title}" осталось ${daysUntil} дн. Прогресс: ${goal.progress}%`,
                    priority: urgency,
                    relatedEntityId: goal.id,
                    relatedEntityType: 'goal',
                    persistenceLevel: daysUntil <= 1 ? 4 : daysUntil <= 3 ? 3 : 2,
                    source: 'goal',
                });
            }

            // Просроченные цели
            if (daysUntil < 0) {
                insights.push({
                    type: 'goal_deadline',
                    content: `⚠️ Цель "${goal.title}" просрочена на ${Math.abs(daysUntil)} дн. Что делаем — продлеваем или закрываем?`,
                    priority: 'high',
                    relatedEntityId: goal.id,
                    relatedEntityType: 'goal',
                    persistenceLevel: 4,
                    source: 'goal',
                });
            }
        }

        // 2. Цели без прогресса
        if (goal.progress === 0 && goal.createdAt) {
            const daysSinceCreation = Math.floor((now.getTime() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24));

            if (daysSinceCreation >= 7) {
                insights.push({
                    type: 'goal_stalled',
                    content: `📊 Цель "${goal.title}" создана ${daysSinceCreation} дней назад, но прогресс 0%. Нужна помощь с планом?`,
                    priority: 'medium',
                    relatedEntityId: goal.id,
                    relatedEntityType: 'goal',
                    persistenceLevel: 2,
                    source: 'goal',
                });
            }
        }
    }

    return insights;
}

/**
 * Генерация инсайтов из Knowledge Graph v2
 * 
 * Показываем связи, релевантные текущему разговору:
 * - Семантический матч сообщения с триплетами из knowledge_relations
 * - Дополнительный матч по запросам из Query Plan
 * - Исключаем связи, уже присутствующие в основном контексте
 */
async function generateKGv2Insights(
    userMessage: string,
    knowledgeRelationsContext: string | null,
    queryPlanningResult?: QueryPlanningResult | null
): Promise<Insight[]> {
    const insights: Insight[] = [];

    try {
        // Alias для второго JOIN на entities (object)
        const objectEntities = alias(entities, 'object_entities');

        // 1. Загружаем активные триплеты из БД
        const relations = await db.select({
            id: knowledgeRelations.id,
            subjectName: entities.name,
            relationType: knowledgeRelations.relationType,
            objectName: objectEntities.name,
            category: knowledgeRelations.relationCategory,
            importance: knowledgeRelations.importance,
            context: knowledgeRelations.context,
        })
            .from(knowledgeRelations)
            .innerJoin(entities, eq(knowledgeRelations.subjectId, entities.id))
            .innerJoin(objectEntities, eq(knowledgeRelations.objectId, objectEntities.id))
            .where(eq(knowledgeRelations.isActive, true))
            .limit(30);

        if (relations.length === 0) {
            return insights;
        }

        // 2. Создаём embedding сообщения
        const messageEmbedding = await createEmbedding(userMessage);

        // 2.1. Собираем дополнительные запросы из Query Plan для расширенного матчинга
        const queryPlanQueries = queryPlanningResult?.plan?.queries
            ?.map((q: { query: string }) => q.query)
            .filter((query: string): query is string => !!query) || [];

        // Создаём embeddings для запросов Query Plan (если есть)
        const queryEmbeddings = await Promise.all(
            queryPlanQueries.slice(0, 3).map((q: string) => createEmbedding(q))
        );

        // 3. Семантический матч с каждой связью
        for (const rel of relations) {
            const relationText = `${rel.subjectName} ${rel.relationType.replace(/_/g, ' ')} ${rel.objectName}`;
            const relationEmbedding = await createEmbedding(relationText);

            // Базовая схожесть с сообщением пользователя
            let similarity = cosineSimilarity(messageEmbedding, relationEmbedding);

            // Дополнительная проверка схожести с запросами Query Plan
            // Берём максимальную схожесть из всех источников
            for (const queryEmb of queryEmbeddings) {
                const querySimilarity = cosineSimilarity(queryEmb, relationEmbedding);
                if (querySimilarity > similarity) {
                    similarity = querySimilarity;
                }
            }

            // Порог 0.5 — достаточно высокий для смысловой связи
            if (similarity > 0.5) {
                // Проверяем что не в основном контексте
                const alreadyInContext = knowledgeRelationsContext?.includes(relationText) ||
                    knowledgeRelationsContext?.includes(rel.objectName);
                if (alreadyInContext) continue;

                const priority = rel.importance === 'high' || rel.importance === 'critical'
                    ? 'medium'
                    : 'low';

                insights.push({
                    type: 'knowledge_reminder' as any,  // Новый тип
                    content: `📌 Напоминаю: ${rel.subjectName} ${rel.relationType.replace(/_/g, ' ')} ${rel.objectName}${rel.context ? ` (${rel.context})` : ''}`,
                    priority,
                    relatedEntityId: rel.id,
                    relatedEntityType: 'knowledge_relation',
                    persistenceLevel: 1,
                    source: 'graph',
                });
            }
        }
    } catch (error) {
        console.error("Ошибка генерации KG v2 инсайтов:", error);
    }

    return insights.slice(0, 2); // Максимум 2 инсайта из графа
}

// ============================================================================
// Новые источники insights
// ============================================================================

/**
 * Phase 1: Связь сообщения с целями (SEMANTIC MATCH)
 * Используем embeddings для семантического сравнения
 */
async function generateGoalRelevanceInsights(userMessage: string): Promise<Insight[]> {
    const insights: Insight[] = [];

    try {
        // Получаем активные цели
        const activeGoals = await db.select()
            .from(goals)
            .where(eq(goals.status, "active"));

        if (activeGoals.length === 0) return insights;

        // Создаём embedding сообщения
        const messageEmbedding = await createEmbedding(userMessage);

        for (const goal of activeGoals) {
            // Создаём embedding цели (или используем кеш)
            const goalText = `${goal.title}. ${goal.description || ''}`;
            const goalEmbedding = await createEmbedding(goalText);

            // Считаем semantic similarity
            const similarity = cosineSimilarity(messageEmbedding, goalEmbedding);

            // Порог 0.55 — достаточно высокий для смысловой связи
            if (similarity > 0.55) {
                const priority = similarity > 0.75 ? 'high' : similarity > 0.65 ? 'medium' : 'low';
                insights.push({
                    type: 'reminder',
                    content: `🎯 Это связано с целью "${goal.title}" (прогресс ${goal.progress}%, схожесть ${Math.round(similarity * 100)}%)`,
                    priority,
                    relatedEntityId: goal.id,
                    relatedEntityType: 'goal',
                    persistenceLevel: priority === 'high' ? 3 : 2,
                    source: 'goal',
                });
            }
        }
    } catch (error) {
        console.error("Ошибка semantic match для целей:", error);
    }

    return insights;
}

/**
 * Phase 2: Противоречия в фактах (AI-POWERED)
 * AI анализирует релевантные факты на противоречия
 */
async function generateFactContradictionInsights(relevantFacts: Fact[]): Promise<Insight[]> {
    const insights: Insight[] = [];

    // Нужно минимум 2 факта для сравнения
    if (relevantFacts.length < 2) return insights;

    try {
        // Берём топ-5 фактов для анализа
        const factsToAnalyze = relevantFacts.slice(0, 5);
        const factsText = factsToAnalyze.map((f, i) => `${i + 1}. ${f.content}`).join('\n');

        const aiConfig = await getAIClientForTask('insight_analysis');

        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.1, maxTokens: 150 },
            [
                {
                    role: "system",
                    content: `Ты анализируешь факты на противоречия. 
Если есть противоречие — ответь JSON: {"found": true, "fact1": 1, "fact2": 3, "description": "краткое описание"}
Если нет — ответь: {"found": false}
Только JSON, без объяснений.`
                },
                {
                    role: "user",
                    content: `Факты:\n${factsText}`
                }
            ]
        );

        const content = result.content || '';

        // Парсим JSON
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.found && result.description) {
                insights.push({
                    type: 'fact_contradiction',
                    content: `⚠️ Противоречие: ${result.description}. Уточни, что актуально?`,
                    priority: 'high',
                    relatedEntityId: factsToAnalyze[result.fact1 - 1]?.id,
                    relatedEntityType: 'fact',
                    persistenceLevel: 3,
                    source: 'fact',
                });
            }
        }
    } catch (error) {
        console.error("Ошибка AI-анализа противоречий:", error);

        // Fallback: простая проверка на version > 1
        const updatedFacts = relevantFacts.filter(f =>
            f.version && f.version > 1 && f.confidence && parseFloat(f.confidence) < 0.7
        );

        for (const fact of updatedFacts.slice(0, 1)) {
            insights.push({
                type: 'fact_update',
                content: `📝 Факт обновлялся ${fact.version} раз(а): "${fact.content.substring(0, 80)}..." — это актуально?`,
                priority: 'low',
                relatedEntityId: fact.id,
                relatedEntityType: 'fact',
                persistenceLevel: 1,
                source: 'fact',
            });
        }
    }

    return insights;
}

/**
 * Phase 3: Паттерны из истории сообщений
 * Если тема упоминается 3+ раз за последние 7 дней → отметить важность
 */
async function generatePatternInsights(): Promise<Insight[]> {
    const insights: Insight[] = [];

    // Считаем упоминания тем за последние 7 дней
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const topicCounts = await db.select({
        topicId: facts.topicId,
        count: count(),
    })
        .from(facts)
        .where(gt(facts.createdAt, sevenDaysAgo))
        .groupBy(facts.topicId)
        .having(sql`count(*) >= 3`);

    if (topicCounts.length > 0) {
        // Получаем названия топов
        for (const tc of topicCounts.slice(0, 1)) { // Максимум 1 такой insight
            if (tc.topicId) {
                const [topic] = await db.select().from(topics).where(eq(topics.id, tc.topicId)).limit(1);
                if (topic) {
                    insights.push({
                        type: 'pattern_detected',
                        content: `📈 Тема "${topic.name}" упоминается часто (${tc.count} раз за неделю) — это приоритет?`,
                        priority: 'low',
                        relatedEntityId: tc.topicId,
                        relatedEntityType: 'topic',
                        persistenceLevel: 1,
                        source: 'pattern',
                    });
                }
            }
        }
    }

    return insights;
}

/**
 * Phase 4: Заброшенные важные темы
 * Если тема с factCount > 5 не обновлялась 14+ дней → напомнить
 */
async function generateAbandonedTopicInsights(): Promise<Insight[]> {
    const insights: Insight[] = [];

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // Важные темы (много фактов) которые давно не обновлялись
    const abandonedTopics = await db.select()
        .from(topics)
        .where(and(
            gt(topics.factCount, 5),
            lt(topics.updatedAt, fourteenDaysAgo)
        ))
        .orderBy(desc(topics.factCount))
        .limit(1);

    for (const topic of abandonedTopics) {
        const daysSince = Math.floor((Date.now() - new Date(topic.updatedAt).getTime()) / (1000 * 60 * 60 * 24));
        insights.push({
            type: 'reminder',
            content: `🗂️ Давно не обсуждали "${topic.name}" (${daysSince} дней). Как там дела?`,
            priority: 'low',
            relatedEntityId: topic.id,
            relatedEntityType: 'topic',
            persistenceLevel: 1,
            source: 'pattern',
        });
    }

    return insights;
}

// ============================================================================
// Фильтрация и Cooldown
// ============================================================================

/**
 * Фильтрация insights по cooldown и status
 */
async function filterInsights(insights: Insight[]): Promise<{
    filtered: Insight[];
    stats: { cooldown: number; dismissed: number };
}> {
    const filtered: Insight[] = [];
    let cooldownCount = 0;
    let dismissedCount = 0;

    for (const insight of insights) {
        const hash = createContentHash(insight);

        // Проверяем в памяти
        const [existing] = await db.select()
            .from(insightMemory)
            .where(eq(insightMemory.contentHash, hash))
            .limit(1);

        if (existing) {
            // Проверка статуса
            if (existing.status === 'dismissed' || existing.status === 'resolved') {
                // Проверяем next_remind_at
                if (existing.nextRemindAt && new Date(existing.nextRemindAt) > new Date()) {
                    dismissedCount++;
                    continue;
                }
            }

            // Проверка cooldown
            if (existing.lastMentionedAt) {
                const hoursSince = (Date.now() - new Date(existing.lastMentionedAt).getTime()) / (1000 * 60 * 60);

                // Критические insights имеют меньший cooldown
                const cooldownHours = CONFIG.criticalTypes.includes(insight.type)
                    ? CONFIG.defaultCooldownHours / 2
                    : CONFIG.defaultCooldownHours;

                // Если слишком часто упоминали — увеличить cooldown
                const effectiveCooldown = existing.mentionCount >= CONFIG.maxMentionsBeforeCooldown
                    ? cooldownHours * 2
                    : cooldownHours;

                if (hoursSince < effectiveCooldown) {
                    cooldownCount++;
                    continue;
                }
            }

            // Проверка usefulness с temporal decay
            if (existing.usefulnessScore !== null) {
                let effectiveScore = existing.usefulnessScore;

                // Temporal Decay: старые insights теряют «вес» со временем
                // score = baseScore * exp(-ageDays * ln2 / halfLifeDays)
                if (existing.lastMentionedAt && CONFIG.halfLifeDays > 0) {
                    const ageDays = (Date.now() - new Date(existing.lastMentionedAt).getTime()) / (1000 * 60 * 60 * 24);
                    const decayFactor = Math.exp(-ageDays * Math.LN2 / CONFIG.halfLifeDays);
                    effectiveScore = Math.round(effectiveScore * decayFactor);
                }

                // Критические insights защищены от decay (минимум 50% score)
                if (CONFIG.criticalTypes.includes(insight.type) && existing.usefulnessScore > 0) {
                    effectiveScore = Math.max(effectiveScore, Math.round(existing.usefulnessScore * 0.5));
                }

                if (effectiveScore < CONFIG.minUsefulnessScore) {
                    cooldownCount++;
                    continue;
                }
            }

            // Прошёл все проверки — добавляем с ID из БД
            insight.id = existing.id;
        }

        filtered.push(insight);
    }

    return { filtered, stats: { cooldown: cooldownCount, dismissed: dismissedCount } };
}

/**
 * Создание хеша контента для дедупликации
 */
function createContentHash(insight: Insight): string {
    const data = `${insight.type}:${insight.relatedEntityId}:${insight.relatedEntityType}`;
    return crypto.createHash('md5').update(data).digest('hex');
}

// ============================================================================
// Запись и обновление
// ============================================================================

/**
 * Записать показанный insight
 */
export async function recordInsightShown(insight: Insight): Promise<void> {
    const hash = createContentHash(insight);

    if (insight.id) {
        // Обновляем существующий
        await db.update(insightMemory)
            .set({
                lastMentionedAt: new Date(),
                mentionCount: sql`${insightMemory.mentionCount} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(insightMemory.id, insight.id));
    } else {
        // Создаём новый
        await db.insert(insightMemory).values({
            insightType: insight.type,
            relatedEntityId: insight.relatedEntityId,
            relatedEntityType: insight.relatedEntityType,
            contentHash: hash,
            content: insight.content,
            status: 'active',
            persistenceLevel: insight.persistenceLevel,
            lastMentionedAt: new Date(),
            mentionCount: 1,
        });
    }
}

/**
 * Отложить insight
 */
export async function dismissInsight(
    insightId: number,
    reason: string,
    remindAfterDays?: number
): Promise<void> {
    const nextRemind = remindAfterDays
        ? new Date(Date.now() + remindAfterDays * 24 * 60 * 60 * 1000)
        : null;

    await db.update(insightMemory)
        .set({
            status: 'dismissed',
            dismissalReason: reason,
            nextRemindAt: nextRemind,
            updatedAt: new Date(),
        })
        .where(eq(insightMemory.id, insightId));
}

/**
 * Пометить insight как решённый
 */
export async function resolveInsight(insightId: number): Promise<void> {
    await db.update(insightMemory)
        .set({
            status: 'resolved',
            updatedAt: new Date(),
        })
        .where(eq(insightMemory.id, insightId));
}

/**
 * Записать реакцию пользователя
 */
export async function recordInsightReaction(
    insightId: number,
    reaction: 'positive' | 'neutral' | 'ignored' | 'rejected'
): Promise<void> {
    // Обновляем usefulness score на основе реакции
    const scoreChange = {
        positive: 10,
        neutral: 0,
        ignored: -5,
        rejected: -15,
    }[reaction];

    await db.update(insightMemory)
        .set({
            userReaction: reaction,
            usefulnessScore: sql`GREATEST(0, LEAST(100, ${insightMemory.usefulnessScore} + ${scoreChange}))`,
            updatedAt: new Date(),
        })
        .where(eq(insightMemory.id, insightId));
}

// ============================================================================
// Форматирование для промпта
// ============================================================================

/**
 * Форматирование insights для добавления в промпт агента
 */
export function formatInsightsForPrompt(insights: Insight[]): string {
    if (insights.length === 0) {
        return '';
    }

    const lines = insights.map(i => {
        const priority = i.priority === 'high' ? '❗' : i.priority === 'medium' ? '📌' : '💡';
        return `${priority} ${i.content}`;
    });

    return `
📣 ПРОАКТИВНЫЕ НАПОМИНАНИЯ (используй, если релевантны ответу):
${lines.join('\n')}

Правила:
- Если напоминание релевантно вопросу — интегрируй естественно ("Кстати...")
- Если высокий приоритет (❗) — обязательно упомяни
- Не повторяй дословно, перефразируй под контекст
`;
}
