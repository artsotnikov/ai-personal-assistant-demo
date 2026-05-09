/**
 * Advisor Engine — Движок стратегического мышления
 * 
 * «Стратегический Советник»: ассистент формирует СОБСТВЕННОЕ видение
 * на основе профиля пользователя, целей, задач и контекста жизни.
 * 
 * В отличие от cognitiveLoop (мониторинг) и proactiveScheduler (триггеры),
 * advisorEngine формирует ГЛУБОКИЕ стратегические советы:
 * - Стратегический фокус — что сейчас важнее всего?
 * - Баланс-чек — перекосы между разными сферами жизни
 * - Переоценка — актуальны ли текущие цели?
 * - Связи и возможности — cross-domain инсайты
 * - Зеркало — паттерны поведения vs декларируемые ценности
 * 
 * Запускается из cognitiveLoop (mode: strategic_thinking)
 * или proactiveScheduler (1-2 раза в день).
 */

import { db } from "./db";
import {
    goals, goalActivityLog, facts, messages, topics,
    proactiveMessages, advisorFeedback,
    type Goal, type AdvisorFeedback,
} from "@shared/schema";
import { eq, and, gt, desc, sql, count, lt } from "drizzle-orm";
import { executeReActLoop, resolveToolsForRequest } from "./tools";
import { getAIClientForTask } from "./aiConfigService";
import { getFocusGoals, getActiveGoals, getFullGoalDetails } from "./goalManager";
import { getStructuredProfile, type StructuredProfile } from "./profileManager";
import { getMoscowHour } from "./lib/moscowTime";

// ============================================================================
// Конфигурация
// ============================================================================

const CONFIG = {
    /** Минимальный интервал между стратегическими сессиями (часы) */
    minIntervalHours: 8,

    /** Максимум стратегических сессий в день */
    maxSessionsPerDay: 2,

    /** Час по МСК для вечерней стратегической сессии */
    strategicHourEvening: 18,

    /** Час по МСК для дневной стратегической сессии */
    strategicHourDay: 13,

    /** Максимум советов за одну сессию */
    maxAdvicePerSession: 3,

    /** Cooldown для конкретного совета (часы) */
    adviceCooldownHours: 48,

    /** Максимум итераций ReAct Loop для глубокого анализа */
    maxReActIterations: 8,
};

// ============================================================================
// Типы
// ============================================================================

export type AdviceType =
    | 'strategic_focus'       // Что сейчас важнее всего
    | 'balance_check'         // Перекос между сферами жизни
    | 'reevaluation'          // Нужно ли пересмотреть цель?
    | 'cross_domain_insight'  // Связи между разными областями
    | 'behavior_mirror'       // Зеркало: паттерн vs декларация
    | 'opportunity';          // Нераскрытая возможность

export interface StrategicAdvice {
    type: AdviceType;
    title: string;
    content: string;
    reasoning: string;           // Почему AI так считает
    priority: 'high' | 'medium' | 'low';
    relatedGoalIds?: number[];
    profileBasis?: string[];     // На каких аспектах профиля основан совет
    suggestedAction?: string;    // Конкретное действие
}

export interface StrategicVision {
    /** Общее стратегическое видение (1-2 абзаца) */
    summary: string;

    /** Конкретные советы */
    advice: StrategicAdvice[];

    /** Метаданные */
    generatedAt: Date;
    tokensUsed: number;
    durationMs: number;
    profileCategoriesUsed: string[];
}

// ============================================================================
// Состояние (in-memory)
// ============================================================================

let lastVision: StrategicVision | null = null;
let lastVisionTime: Date | null = null;
let sessionsToday = 0;
let lastSessionDate: string | null = null;
/** Адаптивный интервал — меняется на основе фидбэка пользователя */
let adaptiveIntervalHours = CONFIG.minIntervalHours;

/**
 * Получить последнее стратегическое видение
 * (используется из contextBuilder для advisor context injection)
 */
export function getLastStrategicVision(): StrategicVision | null {
    return lastVision;
}

/**
 * Получить сводку стратегического видения для инъекции в контекст промпта.
 * Возвращает null если видение устарело (> 12 часов).
 */
export function getAdvisorContextForPrompt(): string | null {
    if (!lastVision || !lastVisionTime) return null;

    // Не показываем видение старше 12 часов
    const ageHours = (Date.now() - lastVisionTime.getTime()) / (1000 * 60 * 60);
    if (ageHours > 12) return null;

    const parts: string[] = [];

    // Общее видение
    if (lastVision.summary) {
        parts.push(`🎯 Стратегическое видение: ${lastVision.summary}`);
    }

    // Топ-3 совета
    const topAdvice = lastVision.advice
        .sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.priority] - order[b.priority];
        })
        .slice(0, 3);

    if (topAdvice.length > 0) {
        parts.push('📌 Ключевые наблюдения:');
        for (const advice of topAdvice) {
            const icon = getAdviceIcon(advice.type);
            parts.push(`  ${icon} ${advice.title}: ${advice.content.substring(0, 200)}`);
            if (advice.suggestedAction) {
                parts.push(`    → Действие: ${advice.suggestedAction}`);
            }
        }
    }

    return parts.length > 0 ? parts.join('\n') : null;
}

function getAdviceIcon(type: AdviceType): string {
    const icons: Record<AdviceType, string> = {
        strategic_focus: '🎯',
        balance_check: '⚖️',
        reevaluation: '🔄',
        cross_domain_insight: '💡',
        behavior_mirror: '🪞',
        opportunity: '✨',
    };
    return icons[type] || '📌';
}

// ============================================================================
// Проверки запуска
// ============================================================================

/**
 * Проверить, можно ли запускать стратегическую сессию сейчас
 */
export function canRunStrategicSession(): boolean {
    const todayKey = new Date().toISOString().split('T')[0];

    // Сброс дневного счётчика
    if (lastSessionDate !== todayKey) {
        sessionsToday = 0;
        lastSessionDate = todayKey;
    }

    // Лимит сессий в день
    if (sessionsToday >= CONFIG.maxSessionsPerDay) {
        return false;
    }

    // Адаптивный минимальный интервал
    if (lastVisionTime) {
        const hoursSince = (Date.now() - lastVisionTime.getTime()) / (1000 * 60 * 60);
        if (hoursSince < adaptiveIntervalHours) {
            return false;
        }
    }

    return true;
}



// ============================================================================
// Главная функция
// ============================================================================

/**
 * Запуск стратегической сессии.
 * 
 * 1. Загружает полный профиль (personality, values, ambitions, weaknesses)
 * 2. Загружает цели, задачи, текущую активность
 * 3. AI формирует стратегическое видение через ReAct Loop
 * 4. Генерирует конкретные советы разного типа
 */
export async function runStrategicSession(): Promise<StrategicVision | null> {
    if (!canRunStrategicSession()) {
        console.log('🎯 [Advisor] Пропуск — ещё не время или лимит исчерпан');
        return null;
    }

    const startTime = Date.now();
    console.log('🎯 [Advisor] ═══════════════════════════════════════');
    console.log('🎯 [Advisor] Запуск стратегической сессии...');

    try {
        // ── 1. Сбор данных ──

        // Профиль пользователя (ядро советника)
        const profile = await getStructuredProfile();
        const profileContext = formatProfileForAdvisor(profile);
        const profileCategoriesUsed = getUsedProfileCategories(profile);

        // Активные цели с деталями
        const activeGoals = await getActiveGoals();
        const focusGoals = await getFocusGoals();
        const goalsContext = await formatGoalsForAdvisor(activeGoals, focusGoals);

        // Статистика активности
        const activityStats = await getActivityStats();

        // Недавние темы разговоров
        const recentTopics = await getRecentConversationTopics();

        // История реакций (фидбэк луп)
        const feedbackHistory = await loadFeedbackHistory();
        const feedbackContext = formatFeedbackForPrompt(feedbackHistory);

        // Адаптивная частота на основе паттерна реакций
        adjustFrequency(feedbackHistory);

        // ── 2. AI анализ ──

        const contextData = JSON.stringify({
            дата: new Date().toLocaleDateString('ru-RU', {
                timeZone: 'Europe/Moscow',
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            }),
            время: new Date().toLocaleTimeString('ru-RU', {
                timeZone: 'Europe/Moscow',
                hour: '2-digit', minute: '2-digit',
            }),
            профиль: profileContext,
            цели: goalsContext,
            статистика_активности: activityStats,
            темы_разговоров: recentTopics,
            история_реакций: feedbackContext,
        }, null, 2);

        const strategicPrompt = buildStrategicPrompt(profileContext);

        const tools = resolveToolsForRequest({
            agentSlug: 'advisor',
            exclude: [
                'delegate_task', 'schedule_task', 'create_reminder',
                'update_goal', 'create_goal', 'remember_fact',
                'create_note', 'update_note', 'delete_note',
            ],
        });

        const aiConfig = await getAIClientForTask('proactive_check');

        const result = await executeReActLoop({
            messages: [
                { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
                { role: 'user', content: `${strategicPrompt}\n\nДАННЫЕ ДЛЯ АНАЛИЗА:\n${contextData}` },
            ],
            tools,
            aiConfig,
            context: { sessionId: 'advisor-engine', messageId: 0, isSubagent: true },
            agentSlug: 'advisor',
            maxIterations: CONFIG.maxReActIterations,
        });

        console.log(`🎯 [Advisor] AI завершил: ${result.iterations} итераций, ${result.toolCalls.length} tool calls, ${result.tokensUsed} tokens`);

        // ── 3. Парсинг результата ──

        const vision = parseAdvisorResponse(result.content, result.tokensUsed, startTime, profileCategoriesUsed);

        // ── 4. Обновление состояния ──

        lastVision = vision;
        lastVisionTime = new Date();
        sessionsToday++;

        console.log(`🎯 [Advisor] ✅ Стратегическое видение сформировано:`);
        console.log(`   📊 ${vision.advice.length} советов, ${vision.tokensUsed} tokens, ${vision.durationMs}ms`);
        console.log(`   🎯 Видение: ${vision.summary.substring(0, 100)}...`);
        console.log('🎯 [Advisor] ═══════════════════════════════════════');

        return vision;

    } catch (error) {
        console.error('🎯 [Advisor] ❌ Ошибка стратегической сессии:', error);
        return null;
    }
}

// ============================================================================
// Промпты
// ============================================================================

const ADVISOR_SYSTEM_PROMPT = `Ты — СТРАТЕГИЧЕСКИЙ СОВЕТНИК, работающий в фоновом режиме.
Ты НЕ секретарь и НЕ исполнитель — ты советник, который видит картину целиком.

ТВОЯ ПОЗИЦИЯ:
- Ты знаешь профиль пользователя: его ценности, амбиции, сильные и СЛАБЫЕ стороны
- Ты видишь его цели, задачи, активность (или её отсутствие)
- Ты можешь объективно оценить, движется ли он к своим амбициям
- Ты можешь мягко указать на противоречия между словами и действиями

ПРАВИЛА:
- Используй tools (search_facts, get_goals, ticktick_overview и др.) для получения АКТУАЛЬНЫХ данных
- НИКОГДА не придумывай данные — только из результатов tools и предоставленного контекста
- Будь КОНКРЕТЕН — не "стоит подумать о...", а "конкретно: сделай X потому что Y"
- Будь ЧЕСТЕН — если видишь проблему, скажи прямо, но уважительно
- Учитывай ЛИЧНОСТЬ: если в профиле "перфекционист" — не мотивируй "сделай идеально", 
  а наоборот "достаточно хорошо тоже работает"

ЗЕРКАЛО ПОВЕДЕНИЯ (behavior_mirror) — ОСОБОЕ ВНИМАНИЕ:
- ВНИМАТЕЛЬНО изучи секцию "слабости" (слабые стороны) из профиля
- Сравни декларированные ценности с реальными действиями (активность по целям, темы разговоров, просроченные задачи)
- Если пользователь говорит "здоровье важно", но все цели про бизнес — укажи на это
- Если слабость "откладывание" и 3+ цели без прогресса — это паттерн, назови его
- Тон: не обвинительный, а "я заметил паттерн..."

ФИДБЭК ЛУП — УЧИСЬ НА РЕАКЦИЯХ:
Если в контексте есть история реакций пользователя на предыдущие советы:
- "accepted" — пользователю нравятся такие советы → давай больше такого типа
- "discuss" — тема заинтересовала → копай глубже в этом направлении
- "not_now" — не время для таких советов → избегай этот тип/тему
- "dismissed" — пользователь отклонил не читая → ОЧЕНЬ нерелевантно, измени подход

ФОРМАТ ОТВЕТА — строго JSON:
{
  "summary": "Общее стратегическое видение (2-3 предложения), самое главное",
  "advice": [
    {
      "type": "strategic_focus|balance_check|reevaluation|cross_domain_insight|behavior_mirror|opportunity",
      "title": "Краткий заголовок (5-8 слов)",
      "content": "Детальное описание совета (2-4 предложения)",
      "reasoning": "Почему я так считаю (на основе каких данных)",
      "priority": "high|medium|low",
      "relatedGoalIds": [1, 2],
      "profileBasis": ["ambitions", "weaknesses"],
      "suggestedAction": "Конкретное действие, которое стоит сделать"
    }
  ]
}

Максимум 3 совета. Только самое важное.`;

function buildStrategicPrompt(profileContext: string): string {
    return `Проведи СТРАТЕГИЧЕСКИЙ АНАЛИЗ жизни и приоритетов пользователя.

Ты видишь его профиль, цели, активность и контекст. Твоя задача — сформировать 
СОБСТВЕННОЕ ВИДЕНИЕ: что сейчас действительно важно, что упускается, 
в правильном ли направлении движутся усилия.

ПЕРЕД формированием видения ОБЯЗАТЕЛЬНО вызови tools:
1. get_goals — получить актуальные цели и их прогресс
2. ticktick_overview — текущие задачи и просрочки
3. search_facts("приоритеты планы") — что пользователь сам считает важным

На основе ВСЕХ данных (профиль + tools + контекст) сформируй советы:

1. СТРАТЕГИЧЕСКИЙ ФОКУС (strategic_focus):
   - На что сейчас ОБЪЕКТИВНО стоит направить усилия?
   - Совпадает ли текущая активность с заявленными амбициями?

2. БАЛАНС-ЧЕК (balance_check):
   - Нет ли перекоса? (все цели в одной сфере, здоровье/отношения забыты?)
   - Давно ли пользователь занимался чем-то кроме работы?

3. ПЕРЕОЦЕНКА (reevaluation):
   - Есть ли цели, которые давно без прогресса? Стоят ли они усилий?
   - Не устарели ли какие-то планы?

4. ЗЕРКАЛО ПОВЕДЕНИЯ (behavior_mirror) — ГЛУБОКИЙ АНАЛИЗ:
   А) СОПОСТАВЬ СЛАБОСТИ из профиля с реальным поведением:
      - Если слабость — "прокрастинация", проверь: есть ли цели с 0% прогрессом или просроченные задачи?
      - Если слабость — "перфекционизм", проверь: много ли задач начаты, но не завершены?
      - Если слабость — "распыление фокуса", проверь: сколько активных целей одновременно?
   Б) СОПОСТАВЬ ЦЕННОСТИ с действиями:
      - Если ценность — "здоровье", но 0 целей в категории health → противоречие
      - Если ценность — "семья", но все разговоры про работу → паттерн
   Тон: "я заметил интересный паттерн...", не "ты не делаешь..."

5. ВОЗМОЖНОСТИ (opportunity / cross_domain_insight):
   - Есть ли неочевидные связи между целями, фактами, навыками?
   - Что пользователь мог бы использовать, но не использует?

Давай ТОЛЬКО КОНКРЕТНЫЕ, ОБОСНОВАННЫЕ советы. 
Не давай общих мотивационных фраз — каждый совет должен быть привязан к реальным данным.`;
}

// ============================================================================
// Форматирование данных
// ============================================================================

function formatProfileForAdvisor(profile: StructuredProfile): Record<string, any> {
    const result: Record<string, any> = {};

    if (Object.keys(profile.personality).length > 0) {
        result.личность = profile.personality;
    }
    if (profile.values.length > 0) {
        result.ценности = profile.values;
    }
    if (profile.ambitions.length > 0) {
        result.амбиции = profile.ambitions;
    }
    if (profile.cognitive_patterns.length > 0) {
        result.стиль_мышления = profile.cognitive_patterns;
    }
    if (profile.strengths.length > 0) {
        result.сильные_стороны = profile.strengths;
    }
    if (profile.weaknesses.length > 0) {
        result.слабости = profile.weaknesses;
    }
    if (profile.expertise.length > 0) {
        result.экспертиза = profile.expertise;
    }
    if (profile.emotional_triggers.length > 0) {
        result.эмоциональные_триггеры = profile.emotional_triggers;
    }

    return result;
}

function getUsedProfileCategories(profile: StructuredProfile): string[] {
    const used: string[] = [];
    if (Object.keys(profile.personality).length > 0) used.push('personality');
    if (profile.values.length > 0) used.push('values');
    if (profile.ambitions.length > 0) used.push('ambitions');
    if (profile.cognitive_patterns.length > 0) used.push('cognitive_patterns');
    if (profile.strengths.length > 0) used.push('strengths');
    if (profile.weaknesses.length > 0) used.push('weaknesses');
    if (profile.expertise.length > 0) used.push('expertise');
    if (profile.emotional_triggers.length > 0) used.push('emotional_triggers');
    return used;
}

async function formatGoalsForAdvisor(
    activeGoals: Goal[],
    focusGoals: Goal[]
): Promise<Record<string, any>> {
    const focusIds = new Set(focusGoals.map(g => g.id));

    const goalsData = await Promise.all(
        activeGoals.slice(0, 10).map(async (goal) => {
            const details = await getFullGoalDetails(goal.id);
            const pendingTasks = details?.tasks.filter(t => t.status !== 'done').length || 0;
            const completedTasks = details?.tasks.filter(t => t.status === 'done').length || 0;

            // Вычисляем дни без активности
            let daysSinceActivity = 0;
            if (details?.recentActivity && details.recentActivity.length > 0) {
                daysSinceActivity = Math.floor(
                    (Date.now() - new Date(details.recentActivity[0].createdAt).getTime()) / (1000 * 60 * 60 * 24)
                );
            } else {
                daysSinceActivity = Math.floor(
                    (Date.now() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24)
                );
            }

            return {
                id: goal.id,
                название: goal.title,
                категория: goal.category,
                прогресс: `${goal.progress}%`,
                фокус: focusIds.has(goal.id),
                приоритет: goal.priority,
                дедлайн: goal.deadline
                    ? `${new Date(goal.deadline).toLocaleDateString('ru-RU')} (${calcDaysUntil(goal.deadline)})`
                    : null,
                дней_без_активности: daysSinceActivity,
                задачи: `${completedTasks} выполнено, ${pendingTasks} в ожидании`,
            };
        })
    );

    return {
        всего_активных: activeGoals.length,
        в_фокусе: focusGoals.length,
        список: goalsData,
    };
}

function calcDaysUntil(deadline: string | Date): string {
    const days = Math.ceil((new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days < 0) return `просрочено на ${Math.abs(days)} дн.`;
    if (days === 0) return 'сегодня!';
    if (days === 1) return 'завтра';
    return `${days} дн.`;
}

async function getActivityStats(): Promise<Record<string, any>> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Сообщения за неделю
    const weeklyMessages = await db.select({ cnt: count() })
        .from(messages)
        .where(and(gt(messages.timestamp, weekAgo), eq(messages.sender, 'user')));

    // Сообщения сегодня
    const todayMessages = await db.select({ cnt: count() })
        .from(messages)
        .where(and(gt(messages.timestamp, todayStart), eq(messages.sender, 'user')));

    // Активности по целям за неделю
    const weeklyGoalActivity = await db.select({ cnt: count() })
        .from(goalActivityLog)
        .where(gt(goalActivityLog.createdAt, weekAgo));

    // Факты извлечены за неделю
    const weeklyFacts = await db.select({ cnt: count() })
        .from(facts)
        .where(gt(facts.createdAt, weekAgo));

    return {
        сообщений_за_неделю: weeklyMessages[0]?.cnt || 0,
        сообщений_сегодня: todayMessages[0]?.cnt || 0,
        действий_по_целям_за_неделю: weeklyGoalActivity[0]?.cnt || 0,
        фактов_за_неделю: weeklyFacts[0]?.cnt || 0,
    };
}

async function getRecentConversationTopics(): Promise<string[]> {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const recentUserMessages = await db.select({ content: messages.content })
        .from(messages)
        .where(and(
            gt(messages.timestamp, twoDaysAgo),
            eq(messages.sender, 'user')
        ))
        .orderBy(desc(messages.timestamp))
        .limit(10);

    // Возвращаем краткие превью сообщений
    return recentUserMessages.map(m =>
        (m.content || '').substring(0, 80).replace(/\n/g, ' ')
    ).filter(m => m.length > 10);
}

// ============================================================================
// Парсинг результата AI
// ============================================================================

function parseAdvisorResponse(
    content: string,
    tokensUsed: number,
    startTime: number,
    profileCategoriesUsed: string[]
): StrategicVision {
    const defaultVision: StrategicVision = {
        summary: '',
        advice: [],
        generatedAt: new Date(),
        tokensUsed,
        durationMs: Date.now() - startTime,
        profileCategoriesUsed,
    };

    try {
        // Извлекаем JSON из ответа
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('🎯 [Advisor] AI не вернул JSON, используем raw content');
            defaultVision.summary = content.substring(0, 500);
            return defaultVision;
        }

        const cleanJson = jsonMatch[0]
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        const parsed = JSON.parse(cleanJson);

        defaultVision.summary = parsed.summary || '';

        if (Array.isArray(parsed.advice)) {
            defaultVision.advice = parsed.advice
                .slice(0, CONFIG.maxAdvicePerSession)
                .map((a: any) => ({
                    type: validateAdviceType(a.type),
                    title: a.title || 'Без заголовка',
                    content: a.content || '',
                    reasoning: a.reasoning || '',
                    priority: (['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium') as 'high' | 'medium' | 'low',
                    relatedGoalIds: Array.isArray(a.relatedGoalIds) ? a.relatedGoalIds : [],
                    profileBasis: Array.isArray(a.profileBasis) ? a.profileBasis : [],
                    suggestedAction: a.suggestedAction || undefined,
                }));
        }

    } catch (error) {
        console.error('🎯 [Advisor] Ошибка парсинга JSON:', error);
        defaultVision.summary = content.substring(0, 500);
    }

    return defaultVision;
}

function validateAdviceType(type: string): AdviceType {
    const validTypes: AdviceType[] = [
        'strategic_focus', 'balance_check', 'reevaluation',
        'cross_domain_insight', 'behavior_mirror', 'opportunity',
    ];
    return validTypes.includes(type as AdviceType) ? type as AdviceType : 'strategic_focus';
}

// getMoscowHour — используется из ./lib/moscowTime

// ============================================================================
// Feedback Loop — адаптация на основе реакций пользователя
// ============================================================================

/**
 * Загрузить историю реакций пользователя на стратегические советы (последние 30 дней).
 */
async function loadFeedbackHistory(): Promise<AdvisorFeedback[]> {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const history = await db.select()
            .from(advisorFeedback)
            .where(gt(advisorFeedback.createdAt, thirtyDaysAgo))
            .orderBy(desc(advisorFeedback.createdAt))
            .limit(30);
        return history;
    } catch (error) {
        console.warn('🎯 [Advisor] Не удалось загрузить feedback history:', error);
        return [];
    }
}

/**
 * Форматировать историю реакций для инъекции в промпт AI.
 * Группирует по типам советов и показывает паттерн реакций.
 */
function formatFeedbackForPrompt(history: AdvisorFeedback[]): Record<string, any> | null {
    if (history.length === 0) return null;

    // Агрегация по типу реакций
    const reactionCounts = {
        discuss: history.filter(h => h.reaction === 'discuss').length,
        accepted: history.filter(h => h.reaction === 'accepted').length,
        not_now: history.filter(h => h.reaction === 'not_now').length,
        dismissed: history.filter(h => h.reaction === 'dismissed').length,
    };

    // Агрегация по типу совета
    const byAdviceType: Record<string, { total: number; reactions: Record<string, number> }> = {};
    for (const fb of history) {
        if (!byAdviceType[fb.adviceType]) {
            byAdviceType[fb.adviceType] = { total: 0, reactions: {} };
        }
        byAdviceType[fb.adviceType].total++;
        byAdviceType[fb.adviceType].reactions[fb.reaction] = (byAdviceType[fb.adviceType].reactions[fb.reaction] || 0) + 1;
    }

    // Определяем предпочтения
    const preferred: string[] = [];
    const avoided: string[] = [];

    for (const [type, data] of Object.entries(byAdviceType)) {
        const positiveRate = ((data.reactions['discuss'] || 0) + (data.reactions['accepted'] || 0)) / data.total;
        const negativeRate = ((data.reactions['dismissed'] || 0) + (data.reactions['not_now'] || 0)) / data.total;

        if (positiveRate > 0.6) preferred.push(type);
        if (negativeRate > 0.6) avoided.push(type);
    }

    // Последние 5 реакций для контекста
    const recentReactions = history.slice(0, 5).map(h => ({
        тип_совета: h.adviceType,
        заголовок: h.adviceTitle,
        реакция: h.reaction,
        когда: h.createdAt?.toISOString().split('T')[0] || 'unknown',
    }));

    return {
        общая_статистика: reactionCounts,
        предпочитаемые_типы: preferred.length > 0 ? preferred : 'пока не определены',
        избегаемые_типы: avoided.length > 0 ? avoided : 'нет',
        последние_реакции: recentReactions,
    };
}

/**
 * Адаптивная регулировка частоты советов на основе паттерна реакций.
 * 
 * Логика:
 * - Много `discuss`/`accepted` → уменьшаем интервал (больше советов)
 * - Много `dismissed`/`not_now` → увеличиваем интервал (меньше советов)
 * - Нейтральный → стандартный интервал
 */
function adjustFrequency(history: AdvisorFeedback[]): void {
    if (history.length < 3) {
        // Недостаточно данных — используем стандарт
        adaptiveIntervalHours = CONFIG.minIntervalHours;
        return;
    }

    // Считаем по последним 10 реакциям
    const recent = history.slice(0, 10);
    const positive = recent.filter(h => h.reaction === 'discuss' || h.reaction === 'accepted').length;
    const negative = recent.filter(h => h.reaction === 'dismissed' || h.reaction === 'not_now').length;

    const positiveRate = positive / recent.length;
    const negativeRate = negative / recent.length;

    if (positiveRate > 0.6) {
        // Пользователю нравится → чаще (мин 6 часов)
        adaptiveIntervalHours = Math.max(6, CONFIG.minIntervalHours - 2);
        console.log(`🎯 [Advisor] Адаптивная частота: ↑ (${adaptiveIntervalHours}ч), positive=${(positiveRate * 100).toFixed(0)}%`);
    } else if (negativeRate > 0.6) {
        // Пользователю не нравится → реже (макс 24 часа)
        adaptiveIntervalHours = Math.min(24, CONFIG.minIntervalHours + 8);
        console.log(`🎯 [Advisor] Адаптивная частота: ↓ (${adaptiveIntervalHours}ч), negative=${(negativeRate * 100).toFixed(0)}%`);
    } else {
        // Нейтрально → стандарт
        adaptiveIntervalHours = CONFIG.minIntervalHours;
    }
}
