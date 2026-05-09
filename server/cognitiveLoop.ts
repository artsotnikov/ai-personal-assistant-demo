/**
 * Cognitive Loop — Фоновое мышление ассистента
 * 
 * «Живой ассистент»: AI сам решает, что сейчас важнее —
 * проверить цели, найти возможности, проанализировать память
 * или провести самоанализ.
 * 
 * Вызывается из proactiveScheduler каждые 15 минут.
 * В отличие от жёстких cron-задач, AI адаптивно выбирает
 * фокус внимания на основе текущего контекста.
 */

import { db } from "./db";
import {
    goals, goalActivityLog, facts, messages, topics,
    type Goal,
} from "@shared/schema";
import { eq, and, lt, gt, desc, sql, count } from "drizzle-orm";
import { executeReActLoop, resolveToolsForRequest } from "./tools";
import { getAIClientForTask } from "./aiConfigService";
import { getFocusGoals, getActiveGoals, getFullGoalDetails } from "./goalManager";
import { searchFactsByQuery } from "./embeddingService";
import { runGoalPulse } from "./goalPulse";
import { getMoscowHour, getMoscowDateKey, getMoscowMidnight } from "./lib/moscowTime";
import { runStrategicSession, canRunStrategicSession } from "./advisorEngine";

// ============================================================================
// Конфигурация
// ============================================================================

const CONFIG = {
    /** Минимальный интервал между thinking cycles (минуты) */
    minIntervalMinutes: 30,

    /** Максимальное количество циклов в день */
    maxCyclesPerDay: 8,

    /** Дней без активности для «застывшей» цели */
    stalledGoalDays: 3,

    /** Максимум токенов на один thinking cycle */
    maxTokensPerCycle: 2000,

    /** Промежуток «утро» для morning warmup (MSK час) */
    morningStartHour: 7,
    morningEndHour: 10,

    /** Промежуток «вечер» для self-analysis */
    eveningStartHour: 20,
    eveningEndHour: 23,
};

// ============================================================================
// Типы
// ============================================================================

export type ThinkingMode =
    | 'morning_warmup'      // Утренний разогрев — план дня
    | 'goal_patrol'         // Обход целей — новая информация?
    | 'opportunity_scan'    // Поиск скрытых связей
    | 'self_analysis'       // Самоанализ — улучшение качества
    | 'strategic_thinking'  // Стратегическое мышление — формирование видения
    | 'idle';               // Нет смысла думать прямо сейчас

export interface ThinkingResult {
    mode: ThinkingMode;
    thoughts: string;            // Результат мышления
    discoveries: Discovery[];    // Найденные инсайты
    actionsProposed: ProposedAction[];  // Предложенные действия
    tokensUsed: number;
    durationMs: number;
}

export interface Discovery {
    type: 'goal_connection' | 'stalled_goal' | 'opportunity' | 'pattern' | 'improvement';
    content: string;
    relatedGoalId?: number;
    confidence: number;  // 0-1
}

export interface ProposedAction {
    type: 'suggest_to_user' | 'update_memory' | 'schedule_reminder' | 'log_activity';
    description: string;
    payload?: Record<string, unknown>;
}

// ============================================================================
// Состояние цикла (in-memory)
// ============================================================================

let lastCycleTime: Date | null = null;
let cyclesToday = 0;
let lastCycleDate: string | null = null;  // Для сброса счётчика по дням

/** Результаты последнего цикла — доступны для агента при следующем диалоге */
let lastThinkingResult: ThinkingResult | null = null;

/** Все выполненные режимы за сегодня — для предотвращения повторных запусков */
let completedModesToday = new Set<ThinkingMode>();

export function getLastThinkingResult(): ThinkingResult | null {
    return lastThinkingResult;
}

// ============================================================================
// Определение фокуса внимания
// ============================================================================

/**
 * AI определяет, о чём сейчас стоит подумать
 */
async function determineThinkingMode(): Promise<ThinkingMode> {
    const moscowHour = getMoscowHour();
    const todayKey = getMoscowDateKey();

    // Сброс дневного счётчика и completedModes
    if (lastCycleDate !== todayKey) {
        cyclesToday = 0;
        lastCycleDate = todayKey;
        completedModesToday.clear();
    }

    // Лимит — не больше N циклов в день
    if (cyclesToday >= CONFIG.maxCyclesPerDay) {
        console.log(`🧠 [CogLoop] Дневной лимит (${CONFIG.maxCyclesPerDay}) исчерпан`);
        return 'idle';
    }

    // Минимальный интервал
    if (lastCycleTime) {
        const minutesSinceLastCycle = (Date.now() - lastCycleTime.getTime()) / (1000 * 60);
        if (minutesSinceLastCycle < CONFIG.minIntervalMinutes) {
            return 'idle';
        }
    }

    // Утро → morning warmup (1 раз)
    if (moscowHour >= CONFIG.morningStartHour && moscowHour < CONFIG.morningEndHour) {
        if (!completedModesToday.has('morning_warmup')) {
            return 'morning_warmup';
        }
    }

    // Вечер 18-19 → strategic_thinking (1 раз в день, приоритет)
    if (moscowHour >= 18 && moscowHour < 20) {
        if (!completedModesToday.has('strategic_thinking') && canRunStrategicSession()) {
            return 'strategic_thinking';
        }
    }

    // Вечер → self-analysis (1 раз)
    if (moscowHour >= CONFIG.eveningStartHour && moscowHour < CONFIG.eveningEndHour) {
        if (!completedModesToday.has('self_analysis')) {
            return 'self_analysis';
        }
    }

    // Днём — чередуем goal_patrol и opportunity_scan
    if (cyclesToday % 2 === 0) {
        return 'goal_patrol';
    } else {
        return 'opportunity_scan';
    }
}

// ============================================================================
// Thinking Strategies
// ============================================================================

/**
 * Morning Warmup — Утренний план дня
 */
async function executeMorningWarmup(): Promise<ThinkingResult> {
    const startTime = Date.now();
    console.log('🌅 [CogLoop] Morning Warmup — формирование плана дня');

    // Собираем контекст
    const focusGoals = await getFocusGoals();
    const activeGoals = await getActiveGoals();
    
    const goalsContext = await Promise.all(
        focusGoals.slice(0, 3).map(async (g) => {
            const details = await getFullGoalDetails(g.id);
            return {
                id: g.id,
                title: g.title,
                progress: g.progress,
                deadline: g.deadline,
                pendingTasks: details?.tasks.filter(t => t.status !== 'done').length || 0,
            };
        })
    );

    // Проверяем недавнюю активность пользователя
    const recentMessages = await db.select()
        .from(messages)
        .where(and(
            eq(messages.sender, 'user'),
            gt(messages.timestamp, new Date(Date.now() - 24 * 60 * 60 * 1000))
        ))
        .orderBy(desc(messages.timestamp))
        .limit(5);

    const lastUserActivity = recentMessages[0]?.timestamp;
    const hoursSinceLastActivity = lastUserActivity
        ? (Date.now() - new Date(lastUserActivity).getTime()) / (1000 * 60 * 60)
        : 999;

    const prompt = `Ты — внутренний мыслительный процесс ассистента. Это УТРЕННИЙ РАЗОГРЕВ.
Проанализируй данные и определи 3 главных приоритета пользователя на сегодня.

ДАННЫЕ:
- Focus-цели: ${JSON.stringify(goalsContext)}
- Все активные цели: ${activeGoals.length}
- Последняя активность пользователя: ${hoursSinceLastActivity < 24 ? `${Math.round(hoursSinceLastActivity)} часов назад` : 'более суток назад'}
- Текущая дата: ${new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' })}

ЗАДАЧА:
1. Выдели 3 приоритета на сегодня (на основе дедлайнов, стоящих задач, momentum)
2. Если есть застывшие цели (без активности >3 дней) — отметь
3. Если пользователь давно не заходил — учти это

Ответь JSON: {
  "priorities": ["строка", ...],
  "stalledGoals": [{"id": N, "reason": "строка"}],
  "opportunities": ["строка"],
  "overallMood": "productive|recovering|stalled"
}`;

    const aiConfig = await getAIClientForTask('proactive_check');

    const result = await executeReActLoop({
        messages: [
            { role: 'system', content: 'Ты — фоновый мыслительный процесс AI-ассистента. Думай тихо, анализируй глубоко. Не обращайся к пользователю — это внутренний монолог.' },
            { role: 'user', content: prompt },
        ],
        tools: resolveToolsForRequest({ agentSlug: 'cognitive', exclude: ['delegate_task', 'schedule_task', 'create_reminder', 'update_goal', 'create_goal'] }),
        aiConfig,
        context: { sessionId: 'cognitive-loop', messageId: 0, isSubagent: true },
        agentSlug: 'cognitive-loop',
        maxIterations: 4,
    });

    const discoveries: Discovery[] = [];
    const actionsProposed: ProposedAction[] = [];

    // Парсим результат
    try {
        const parsed = JSON.parse(
            result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        );

        // Превращаем stalled goals в discoveries
        if (Array.isArray(parsed.stalledGoals)) {
            for (const sg of parsed.stalledGoals) {
                discoveries.push({
                    type: 'stalled_goal',
                    content: sg.reason || `Цель #${sg.id} застыла`,
                    relatedGoalId: sg.id,
                    confidence: 0.8,
                });
            }
        }

        // Opportunities → discoveries
        if (Array.isArray(parsed.opportunities)) {
            for (const opp of parsed.opportunities) {
                discoveries.push({
                    type: 'opportunity',
                    content: opp,
                    confidence: 0.6,
                });
            }
        }

        // Priorities → actions (предложить пользователю при следующем диалоге)
        if (Array.isArray(parsed.priorities) && parsed.priorities.length > 0) {
            actionsProposed.push({
                type: 'suggest_to_user',
                description: `Приоритеты на сегодня: ${parsed.priorities.join('; ')}`,
                payload: { priorities: parsed.priorities, mood: parsed.overallMood },
            });
        }
    } catch {
        // Если AI не вернул JSON — записываем raw content
        if (result.content.length > 20) {
            discoveries.push({
                type: 'pattern',
                content: result.content.substring(0, 500),
                confidence: 0.5,
            });
        }
    }

    const thinkingResult: ThinkingResult = {
        mode: 'morning_warmup',
        thoughts: result.content,
        discoveries,
        actionsProposed,
        tokensUsed: result.tokensUsed,
        durationMs: Date.now() - startTime,
    };

    console.log(`🌅 [CogLoop] Morning Warmup завершён: ${discoveries.length} discoveries, ${actionsProposed.length} actions (${result.tokensUsed} tokens, ${thinkingResult.durationMs}ms)`);
    return thinkingResult;
}

/**
 * Goal Patrol — Обход целей, поиск новой информации
 * Теперь использует Goal Pulse для глубокого анализа.
 */
async function executeGoalPatrol(): Promise<ThinkingResult> {
    const startTime = Date.now();
    console.log('🎯 [CogLoop] Goal Patrol — обход целей (с Goal Pulse)');

    const discoveries: Discovery[] = [];
    const actionsProposed: ProposedAction[] = [];
    let tokensUsed = 0;

    // Запускаем Goal Pulse — глубокий анализ focus-целей
    try {
        const pulseResult = await runGoalPulse();

        // Конвертируем Goal Pulse discoveries в CogLoop discoveries
        for (const d of pulseResult.discoveries) {
            const typeMap: Record<string, Discovery['type']> = {
                'stalled': 'stalled_goal',
                'deadline_risk': 'opportunity',
                'new_facts': 'goal_connection',
                'progress_opportunity': 'opportunity',
            };

            discoveries.push({
                type: typeMap[d.type] || 'pattern',
                content: d.content,
                relatedGoalId: d.goalId,
                confidence: d.confidence,
            });
        }

        // AI-предложения → actions
        for (const suggestion of pulseResult.suggestions) {
            actionsProposed.push({
                type: 'suggest_to_user',
                description: `💡 Для цели «${suggestion.goalTitle}»: ${suggestion.suggestion}`,
                payload: { goalId: suggestion.goalId, suggestion: suggestion.suggestion },
            });
            tokensUsed += 200; // Примерная оценка токенов за suggestNextStep
        }

        // Общее действие для застывших целей
        if (pulseResult.stalledGoals.length > 0) {
            actionsProposed.push({
                type: 'suggest_to_user',
                description: `${pulseResult.stalledGoals.length} цель(и) требуют внимания — нет активности ${CONFIG.stalledGoalDays}+ дней`,
                payload: { stalledGoalIds: pulseResult.stalledGoals.map(g => g.goalId) },
            });
        }
    } catch (error) {
        console.error('🎯 [CogLoop] Goal Pulse ошибка, fallback на базовый patrol:', error);

        // Fallback — базовый patrol без Goal Pulse
        const focusGoals = await getFocusGoals();
        for (const goal of focusGoals.slice(0, 3)) {
            const recentActivity = await db.select({ cnt: count() })
                .from(goalActivityLog)
                .where(and(
                    eq(goalActivityLog.goalId, goal.id),
                    gt(goalActivityLog.createdAt, new Date(Date.now() - CONFIG.stalledGoalDays * 24 * 60 * 60 * 1000))
                ));

            if ((recentActivity[0]?.cnt || 0) === 0) {
                discoveries.push({
                    type: 'stalled_goal',
                    content: `Цель «${goal.title}» без активности уже ${CONFIG.stalledGoalDays}+ дней (прогресс: ${goal.progress}%)`,
                    relatedGoalId: goal.id,
                    confidence: 0.9,
                });
            }
        }
    }

    return {
        mode: 'goal_patrol',
        thoughts: `Goal Patrol завершён. Найдено ${discoveries.length} открытий, ${actionsProposed.length} предложений.`,
        discoveries,
        actionsProposed,
        tokensUsed,
        durationMs: Date.now() - startTime,
    };
}

/**
 * Opportunity Scan — Поиск скрытых связей в knowledge graph
 */
async function executeOpportunityScan(): Promise<ThinkingResult> {
    const startTime = Date.now();
    console.log('🔍 [CogLoop] Opportunity Scan — поиск скрытых связей');

    const discoveries: Discovery[] = [];

    // 1. Ищем темы, которые пересекаются с целями
    const focusGoals = await getFocusGoals();
    const hotTopics = await db.select()
        .from(topics)
        .where(gt(topics.factCount, 3))
        .orderBy(desc(topics.updatedAt))
        .limit(10);

    // 2. Для каждой горячей темы — есть ли связь с focus-целями?
    for (const topic of hotTopics) {
        for (const goal of focusGoals) {
            // Простая эвристика: проверяем содержит ли название темы ключевые слова из цели
            const goalKeywords = goal.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const topicName = topic.name.toLowerCase();
            
            const matchingKeywords = goalKeywords.filter(kw => topicName.includes(kw));
            if (matchingKeywords.length > 0) {
                discoveries.push({
                    type: 'goal_connection',
                    content: `Тема «${topic.name}» (${topic.factCount} фактов) связана с целью «${goal.title}» по ключевым словам: ${matchingKeywords.join(', ')}`,
                    relatedGoalId: goal.id,
                    confidence: 0.5 + (matchingKeywords.length * 0.15),
                });
            }
        }
    }

    // 3. Ищем факты-противоречия (разные утверждения на одну тему)
    // Лёгкая версия: ищем факты с одинаковым topic, но разным sentiment
    const factsWithTopics = await db.select()
        .from(facts)
        .where(gt(facts.createdAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)))
        .orderBy(desc(facts.createdAt))
        .limit(50);

    // Группируем факты по sourceMessageId
    const factsBySource = new Map<string, typeof factsWithTopics>();
    for (const fact of factsWithTopics) {
        const source = fact.sourceMessageId ? `msg_${fact.sourceMessageId}` : 'unknown';
        if (!factsBySource.has(source)) {
            factsBySource.set(source, []);
        }
        factsBySource.get(source)!.push(fact);
    }

    // Помечаем источники с множеством обновлений
    const entries = Array.from(factsBySource.entries());
    for (const [source, sourceFacts] of entries) {
        if (sourceFacts.length >= 5) {
            discoveries.push({
                type: 'pattern',
                content: `Источник «${source}» имеет ${sourceFacts.length} фактов за 2 недели — возможно стоит создать сводку`,
                confidence: 0.4,
            });
        }
    }

    return {
        mode: 'opportunity_scan',
        thoughts: `Просканировано ${hotTopics.length} тем и ${factsWithTopics.length} фактов. Найдено ${discoveries.length} связей.`,
        discoveries,
        actionsProposed: discoveries.length > 0 ? [{
            type: 'update_memory' as const,
            description: `Обнаружены ${discoveries.length} скрытых связей для следующего диалога`,
        }] : [],
        tokensUsed: 0,  // Opportunity scan — без AI calls
        durationMs: Date.now() - startTime,
    };
}

/**
 * Self-Analysis — Вечерний самоанализ
 */
async function executeSelfAnalysis(): Promise<ThinkingResult> {
    const startTime = Date.now();
    console.log('🔬 [CogLoop] Self-Analysis — вечерний самоанализ');

    // 1. Считаем статистику сегодняшнего дня (по московскому времени)
    const todayStart = getMoscowMidnight();

    const todayMessages = await db.select({ cnt: count() })
        .from(messages)
        .where(gt(messages.timestamp, todayStart));

    const todayUserMessages = await db.select({ cnt: count() })
        .from(messages)
        .where(and(
            gt(messages.timestamp, todayStart),
            eq(messages.sender, 'user')
        ));

    const todayFacts = await db.select({ cnt: count() })
        .from(facts)
        .where(gt(facts.createdAt, todayStart));

    const todayGoalActivity = await db.select({ cnt: count() })
        .from(goalActivityLog)
        .where(gt(goalActivityLog.createdAt, todayStart));

    const stats = {
        totalMessages: todayMessages[0]?.cnt || 0,
        userMessages: todayUserMessages[0]?.cnt || 0,
        factsLearned: todayFacts[0]?.cnt || 0,
        goalActivities: todayGoalActivity[0]?.cnt || 0,
    };

    const discoveries: Discovery[] = [];

    // 2. Анализируем — был ли день продуктивным?
    if (stats.userMessages === 0) {
        discoveries.push({
            type: 'pattern',
            content: 'Пользователь сегодня не обращался к ассистенту. Возможно, стоит предложить помощь утром.',
            confidence: 0.6,
        });
    }

    if (stats.goalActivities === 0 && stats.userMessages > 0) {
        discoveries.push({
            type: 'improvement',
            content: 'Были диалоги, но ни одной активности по целям. Возможно, ассистент не привязывает разговоры к целям.',
            confidence: 0.7,
        });
    }

    if (stats.factsLearned > 10) {
        discoveries.push({
            type: 'pattern',
            content: `Сегодня извлечено ${stats.factsLearned} фактов — продуктивный день для базы знаний.`,
            confidence: 0.8,
        });
    }

    const actionsProposed: ProposedAction[] = [];

    // 3. Записываем мета-данные в activity log
    actionsProposed.push({
        type: 'log_activity',
        description: `Итог дня: ${stats.userMessages} сообщений, ${stats.factsLearned} фактов, ${stats.goalActivities} действий по целям`,
        payload: stats,
    });

    return {
        mode: 'self_analysis',
        thoughts: `Самоанализ за день: ${JSON.stringify(stats)}. Обнаружено ${discoveries.length} паттернов.`,
        discoveries,
        actionsProposed,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
    };
}

/**
 * Strategic Thinking — Формирование стратегического видения
 * Делегирует глубокий анализ advisorEngine.
 */
async function executeStrategicThinking(): Promise<ThinkingResult> {
    const startTime = Date.now();
    console.log('🎯 [CogLoop] Strategic Thinking — формирование стратегического видения');

    const discoveries: Discovery[] = [];
    const actionsProposed: ProposedAction[] = [];
    let tokensUsed = 0;

    try {
        const vision = await runStrategicSession();

        if (vision) {
            tokensUsed = vision.tokensUsed;

            // Конвертируем советы в discoveries
            for (const advice of vision.advice) {
                const typeMap: Record<string, Discovery['type']> = {
                    'strategic_focus': 'pattern',
                    'balance_check': 'improvement',
                    'reevaluation': 'stalled_goal',
                    'cross_domain_insight': 'goal_connection',
                    'behavior_mirror': 'improvement',
                    'opportunity': 'opportunity',
                };

                discoveries.push({
                    type: typeMap[advice.type] || 'pattern',
                    content: `[${advice.title}] ${advice.content}`,
                    relatedGoalId: advice.relatedGoalIds?.[0],
                    confidence: advice.priority === 'high' ? 0.9 : advice.priority === 'medium' ? 0.7 : 0.5,
                });

                // Каждый совет → предложение пользователю
                actionsProposed.push({
                    type: 'suggest_to_user',
                    description: `🎯 ${advice.title}: ${advice.content}`,
                    payload: {
                        adviceType: advice.type,
                        relatedGoalIds: advice.relatedGoalIds,
                        suggestedAction: advice.suggestedAction,
                        profileBasis: advice.profileBasis,
                    },
                });
            }

            // Общее видение → предложение
            if (vision.summary) {
                actionsProposed.unshift({
                    type: 'suggest_to_user',
                    description: `📊 Стратегическое видение: ${vision.summary}`,
                    payload: { summary: vision.summary },
                });
            }
        }
    } catch (error) {
        console.error('🎯 [CogLoop] Ошибка Strategic Thinking:', error);
    }

    return {
        mode: 'strategic_thinking',
        thoughts: `Strategic Thinking завершён. ${discoveries.length} наблюдений, ${actionsProposed.length} предложений.`,
        discoveries,
        actionsProposed,
        tokensUsed,
        durationMs: Date.now() - startTime,
    };
}

// ============================================================================
// Главная функция
// ============================================================================

/**
 * Запуск одного мыслительного цикла.
 * Вызывается из proactiveScheduler.ts
 */
export async function runThinkingCycle(): Promise<ThinkingResult | null> {
    const mode = await determineThinkingMode();

    if (mode === 'idle') {
        return null;
    }

    console.log(`🧠 [CogLoop] Запуск мыслительного цикла: ${mode}`);

    let result: ThinkingResult;

    try {
        switch (mode) {
            case 'morning_warmup':
                result = await executeMorningWarmup();
                break;
            case 'goal_patrol':
                result = await executeGoalPatrol();
                break;
            case 'opportunity_scan':
                result = await executeOpportunityScan();
                break;
            case 'self_analysis':
                result = await executeSelfAnalysis();
                break;
            case 'strategic_thinking':
                result = await executeStrategicThinking();
                break;
            default:
                return null;
        }

        // Обновляем состояние
        lastCycleTime = new Date();
        cyclesToday++;
        lastThinkingResult = result;
        completedModesToday.add(mode);

        console.log(`🧠 [CogLoop] ✅ Цикл завершён: mode=${result.mode}, ${result.discoveries.length} discoveries, ${result.actionsProposed.length} actions, ${result.tokensUsed} tokens, ${result.durationMs}ms`);

        // Сохраняем discoveries как факты (тихо, без уведомления)
        await persistDiscoveries(result.discoveries);

        return result;
    } catch (error) {
        console.error(`🧠 [CogLoop] ❌ Ошибка мыслительного цикла (${mode}):`, error);
        return null;
    }
}

/**
 * Сохранение открытий в память (факты/activity log)
 * Тихий процесс — не уведомляет пользователя
 */
async function persistDiscoveries(discoveries: Discovery[]): Promise<void> {
    const highConfidence = discoveries.filter(d => d.confidence >= 0.7);

    for (const discovery of highConfidence) {
        try {
            // Записываем в activity log целей, если есть связь
            if (discovery.relatedGoalId) {
                const { logGoalActivity } = await import("./goalManager");
                await logGoalActivity(
                    discovery.relatedGoalId,
                    'cognitive_discovery',
                    `[CogLoop] ${discovery.content}`,
                    { type: discovery.type, confidence: discovery.confidence },
                );
            }
        } catch (err) {
            // Не критично — просто логируем
            console.error(`🧠 [CogLoop] Ошибка persist discovery:`, err);
        }
    }

    if (highConfidence.length > 0) {
        console.log(`🧠 [CogLoop] Сохранено ${highConfidence.length}/${discoveries.length} высокоуверенных discoveries`);
    }
}

/**
 * Получить сводку последних мыслей для инъекции в контекст агента
 * Вызывается из contextBuilder при формировании промпта
 */
export function getThinkingSummaryForContext(): string | null {
    if (!lastThinkingResult) return null;

    // Не показываем данные старше 4 часов
    if (lastCycleTime && (Date.now() - lastCycleTime.getTime()) > 4 * 60 * 60 * 1000) {
        return null;
    }

    const parts: string[] = [];

    // Предложенные действия
    const suggestions = lastThinkingResult.actionsProposed
        .filter(a => a.type === 'suggest_to_user');
    if (suggestions.length > 0) {
        parts.push(`📌 Фоновый анализ (${lastThinkingResult.mode}):`);
        for (const s of suggestions) {
            parts.push(`  • ${s.description}`);
        }
    }

    // Высокоприоритетные discoveries
    const important = lastThinkingResult.discoveries
        .filter(d => d.confidence >= 0.7)
        .slice(0, 3);
    if (important.length > 0) {
        parts.push('🧠 Обнаружено в фоне:');
        for (const d of important) {
            parts.push(`  • [${d.type}] ${d.content.substring(0, 150)}`);
        }
    }

    return parts.length > 0 ? parts.join('\n') : null;
}

// getMoscowHour — используется из ./lib/moscowTime
