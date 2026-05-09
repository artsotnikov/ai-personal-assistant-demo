/**
 * Proactive Scheduler — Асинхронная проактивность
 * 
 * Периодически проверяет триггеры и отправляет напоминания:
 * - Дедлайны целей (hard landscape по GTD)
 * - Утренний briefing, вечерний recap (опционально)
 * - Персональные напоминания (user-set)
 * - Weekly Review (интерактивный обзор целей)
 * 
 * GTD: goal_stalled, topic_abandoned, goal_progress — убраны как push.
 * Эти данные доступны пассивно через Weekly Review.
 */

import { db } from "./db";
import { storage } from "./storage";
import { goals, topics, proactiveMessages, type Goal, type Topic } from "@shared/schema";
import { eq, and, lt, gt, desc, sql } from "drizzle-orm";
import { WebSocket } from "ws";
import * as notificationService from "./notificationSettingsService";
import * as reminderService from "./reminderService";
import * as aiTaskScheduler from "./aiTaskScheduler";
import * as webPushService from "./webPushService";
import { executeReActLoop, resolveToolsForRequest } from "./tools";
import { getAIClientForTask } from "./aiConfigService";
import { getFocusGoals, getFullGoalDetails, getGoalsNeedingReview, executeAutoQueries } from "./goalManager";
import { synthesizeAllCategories } from "./profileManager";
import { runThinkingCycle } from "./cognitiveLoop";
import { getLastStrategicVision, type StrategicVision, type StrategicAdvice } from "./advisorEngine";
import { getMoscowHour, getMoscowDayOfWeek, getMoscowMidnight, getMoscowFormattedDate, getMoscowFormattedTime } from "./lib/moscowTime";
import { apiHealth } from "./apiHealthMonitor";

// ============================================================================
// Конфигурация (default fallback, перезагружается из БД)
// ============================================================================

let CONFIG = {
    checkIntervalMs: 15 * 60 * 1000,
    cooldownHours: 4,
    maxDailyReminders: 5,
    recentActivityMinutes: 30,
    morningBriefingHour: 9,
    eveningBriefingHour: 21,
    goalStalledDays: 14,
    topicAbandonedDays: 21,
    enableMorningBriefing: true,
    enableEveningRecap: false,
    enableDeadlineAlerts: true,
    weeklyReviewDay: 1,       // 1 = понедельник
    weeklyReviewHour: 10,     // 10:00 MSK
    enableWeeklyReview: true,
};

// Загрузить настройки из БД
async function reloadConfig() {
    const dbConfig = await notificationService.getSchedulerConfig();
    CONFIG = { ...CONFIG, ...dbConfig };
}

// ============================================================================
// Типы
// ============================================================================

export type ProactiveMessageType =
    | 'deadline_today'
    | 'deadline_soon'
    | 'morning_briefing'
    | 'evening_recap'
    | 'personal_reminder'
    | 'weekly_review'
    | 'strategic_advice';

interface ProactiveMessageAction {
    id: string;
    label: string;
    icon?: string;
    variant?: 'primary' | 'secondary' | 'danger';
}

interface ProactiveMessage {
    type: ProactiveMessageType;
    title: string;
    content: string;
    priority: 'high' | 'medium' | 'low';
    relatedId?: number;
    relatedType?: string;
    actions?: ProactiveMessageAction[];  // Интерактивные кнопки
    /** Детали стратегических советов (только для strategic_advice) */
    adviceDetails?: {
        type: string;
        title: string;
        content: string;
        reasoning: string;
        priority: string;
        suggestedAction?: string;
        profileBasis?: string[];
        relatedGoalIds?: number[];
    }[];
}

// Глобальная ссылка на WebSocket клиентов (устанавливается из routes.ts)
let wsClients: Set<WebSocket> = new Set();

export function setWebSocketClients(clients: Set<WebSocket>) {
    wsClients = clients;
}

// ============================================================================
// Триггеры проактивности
// ============================================================================

/**
 * Проверка дедлайнов целей
 */
async function checkGoalDeadlines(): Promise<ProactiveMessage[]> {
    const messages: ProactiveMessage[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const in3Days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

    const activeGoals = await db.select()
        .from(goals)
        .where(eq(goals.status, "active"));

    for (const goal of activeGoals) {
        if (!goal.deadline) continue;

        const deadline = new Date(goal.deadline);
        const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());

        // Дедлайн сегодня
        if (deadlineDay.getTime() === today.getTime()) {
            messages.push({
                type: 'deadline_today',
                title: '🚨 Дедлайн сегодня!',
                content: `Цель "${goal.title}" должна быть выполнена сегодня. Прогресс: ${goal.progress}%`,
                priority: 'high',
                relatedId: goal.id,
                relatedType: 'goal',
            });
        }
        // Дедлайн завтра
        else if (deadlineDay.getTime() === tomorrow.getTime()) {
            messages.push({
                type: 'deadline_soon',
                title: '⏰ Дедлайн завтра',
                content: `Цель "${goal.title}" — дедлайн завтра. Прогресс: ${goal.progress}%`,
                priority: 'high',
                relatedId: goal.id,
                relatedType: 'goal',
            });
        }
        // Дедлайн через 3 дня
        else if (deadlineDay.getTime() === in3Days.getTime()) {
            messages.push({
                type: 'deadline_soon',
                title: '📅 Дедлайн через 3 дня',
                content: `Цель "${goal.title}" — осталось 3 дня. Прогресс: ${goal.progress}%`,
                priority: 'medium',
                relatedId: goal.id,
                relatedType: 'goal',
            });
        }
    }

    return messages;
}

// GTD: checkStalledGoals, checkAbandonedTopics, checkGoalProgress удалены
// Эти данные больше не пушатся проактивно — они показываются только в контексте Weekly Review
// (см. generateWeeklyReview ниже, где stalled goals и abandoned topics собираются inline)

/**
 * Проверка персональных напоминаний
 */
async function checkPersonalReminders(): Promise<ProactiveMessage[]> {
    const messages: ProactiveMessage[] = [];

    const pendingReminders = await reminderService.getPendingReminders();

    for (const reminder of pendingReminders) {
        const description = reminder.description
            ? `${reminder.description}\n\n`
            : '';

        messages.push({
            type: 'personal_reminder',
            title: '⏰ ' + reminder.title,
            content: `${description}_Ответь «отложи на 15 минут», «отложи на час», «готово» или «отмени» для управления напоминанием._`,
            priority: reminder.priority as 'high' | 'medium' | 'low',
            relatedId: reminder.id,
            relatedType: 'reminder',
        });
    }

    return messages;
}

/**
 * Weekly Review — Еженедельный AI-обзор целей с коучингом
 * Запускается по понедельникам в 10:00 MSK
 * Приоритет: цели с истёкшим targetReviewDate → focus → active
 */
async function generateWeeklyReview(): Promise<ProactiveMessage | null> {
    const moscowHour = getMoscowHour();
    const moscowDay = getMoscowDayOfWeek();

    // Проверяем что сейчас нужный день и час
    if (moscowDay !== CONFIG.weeklyReviewDay || moscowHour !== CONFIG.weeklyReviewHour) {
        return null;
    }

    // Cooldown — проверка что weekly_review не отправлялся недавно (120-часовой cooldown в checkCooldown)
    if (!await checkCooldown('weekly_review')) {
        return null;
    }

    console.log('📋 [WeeklyReview] Запуск еженедельного обзора целей...');

    // 1. Собираем цели для обзора:
    //    приоритет: targetReviewDate истёк → focus → первые 5 активных
    let goalsForReview = await getGoalsNeedingReview();
    console.log(`📋 [WeeklyReview] Цели с истёкшим targetReviewDate: ${goalsForReview.length}`);

    if (goalsForReview.length === 0) {
        goalsForReview = await getFocusGoals();
        console.log(`📋 [WeeklyReview] Focus-цели: ${goalsForReview.length}`);
    }

    if (goalsForReview.length === 0) {
        const { getActiveGoals } = await import("./goalManager");
        const active = await getActiveGoals();
        goalsForReview = active.slice(0, 5);
        console.log(`📋 [WeeklyReview] Fallback на активные: ${goalsForReview.length}`);
    }

    if (goalsForReview.length === 0) {
        console.log('📋 [WeeklyReview] Нет целей для обзора');
        return null;
    }

    // 2. Собираем полные данные по каждой цели
    const goalsData: any[] = [];
    for (const goal of goalsForReview) {
        const details = await getFullGoalDetails(goal.id);
        if (!details) continue;

        const { milestones, tasks, keyResults, recentActivity } = details;
        const doneTasks = tasks.filter(t => t.status === 'done').length;
        const totalTasks = tasks.length;

        goalsData.push({
            id: goal.id,
            title: goal.title,
            description: goal.description,
            category: goal.category,
            priority: goal.priority,
            progress: `${goal.progress}%`,
            deadline: goal.deadline,
            deadlineWarning: goal.deadline ? (() => {
                const diffMs = new Date(goal.deadline).getTime() - Date.now();
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
                if (diffDays < 0) return `🔴 Просрочено на ${Math.abs(diffDays)} дн.!`;
                if (diffDays === 0) return `🔴 Дедлайн СЕГОДНЯ!`;
                if (diffDays <= 3) return `⚠️ Осталось ${diffDays} дн.!`;
                if (diffDays <= 7) return `🟡 Осталось ${diffDays} дн.`;
                return null;
            })() : null,
            milestones: milestones.map(m => `${m.title} [${m.status}]`).join(', ') || 'нет',
            tasks: `${doneTasks}/${totalTasks} завершено`,
            keyResults: keyResults.map(kr =>
                `${kr.title}: ${kr.currentValue}/${kr.targetValue} ${kr.unit || ''} (${kr.status})`
            ).join('; ') || 'нет',
            lastActivity: recentActivity[0]
                ? `${recentActivity[0].description} (${new Date(recentActivity[0].createdAt).toLocaleDateString('ru-RU')})`
                : 'нет активности',
        });
    }

    // 3. Собираем пассивные данные для контекста Weekly Review (GTD: pull-система)
    //    Stalled goals и abandoned topics показываем только здесь, не как отдельные push-уведомления
    const stalledGoals = await db.select()
        .from(goals)
        .where(and(
            eq(goals.status, 'active'),
            eq(goals.progress, 0),
            lt(goals.createdAt, new Date(Date.now() - CONFIG.goalStalledDays * 24 * 60 * 60 * 1000))
        ))
        .limit(5);

    const abandonedTopics = await db.select()
        .from(topics)
        .where(and(
            gt(topics.factCount, 5),
            lt(topics.updatedAt, new Date(Date.now() - CONFIG.topicAbandonedDays * 24 * 60 * 60 * 1000))
        ))
        .orderBy(desc(topics.factCount))
        .limit(3);

    // 4. AI анализирует и формирует weekly review
    const analysis = await executeSmartProactiveCheck(
        `Проведи ЕЖЕНЕДЕЛЬНЫЙ ОБЗОР целей пользователя. Сейчас утро понедельника — время подвести итоги прошлой недели и спланировать новую.

Для каждой цели:
1. Оцени прогресс за неделю
2. Выяви блокеры — что мешает продвижению?
3. Предложи конкретный следующий шаг на эту неделю
4. Задай 1 коучинговый вопрос: «Что мешает?», «Что можно упростить?», «Нужно ли пересмотреть приоритет?»

В конце обзора:
- Дай общую оценку прогресса
- Предложи фокус на следующую неделю (1-2 конкретных действия)
- Если видишь цели-дубликаты — предложи объединить (merge_goals)
- Если цель давно без прогресса — предложи обсудить или архивировать
- Если поле deadlineWarning заполнено — обязательно обрати внимание на приближающийся/просроченный дедлайн и предложи конкретные шаги
- В разделе «Зоны внимания» покажи цели без прогресса и заброшенные темы (если они есть в контексте)

Общайся как личный коуч — поддерживающе, но конкретно.`,
        JSON.stringify({
            дата: new Date().toLocaleDateString('ru-RU'),
            количество_целей: goalsData.length,
            цели: goalsData,
            цели_без_прогресса: stalledGoals.map(g => ({ title: g.title, дней_без_прогресса: Math.floor((Date.now() - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24)) })),
            заброшенные_темы: abandonedTopics.map(t => ({ name: t.name, дней_без_обновления: Math.floor((Date.now() - new Date(t.updatedAt).getTime()) / (1000 * 60 * 60 * 24)), фактов: t.factCount })),
        }),
    );

    if (!analysis || analysis.length < 50) {
        console.log('📋 [WeeklyReview] AI не сгенерировал достаточный обзор');
        return null;
    }

    // Обновляем targetReviewDate для обзорённых целей (+7 дней)
    for (const goal of goalsForReview) {
        const nextReview = new Date();
        nextReview.setDate(nextReview.getDate() + 7);
        await db.update(goals)
            .set({ targetReviewDate: nextReview, updatedAt: new Date() })
            .where(eq(goals.id, goal.id));
    }
    console.log(`📋 [WeeklyReview] targetReviewDate обновлён для ${goalsForReview.length} целей`);

    console.log(`📋 [WeeklyReview] ✅ Обзор готов (${analysis.length} символов)`);

    return {
        type: 'weekly_review',
        title: '📋 Еженедельный обзор целей',
        content: analysis,
        priority: 'high',
        actions: [
            { id: 'to_chat', label: 'В чат', icon: '💬', variant: 'primary' },
            { id: 'dismiss', label: 'Ок', variant: 'secondary' },
        ],
    };
}

// getMoscowHour, getMoscowDayOfWeek — используются из ./lib/moscowTime

// ============================================================================
// Smart Proactive AI — ReAct Loop для проактивных проверок
// ============================================================================

const PROACTIVE_SYSTEM_PROMPT = `Ты — наблюдающий ассистент, работающий в фоновом режиме.
Твоя задача — АНАЛИЗИРОВАТЬ данные и формировать полезные уведомления.

ПРАВИЛА:
- Ты ОБЯЗАН вызвать tools, чтобы получить актуальные данные ПЕРЕД формированием ответа
- Ты ТОЛЬКО цитируешь РЕАЛЬНЫЕ данные из результатов tool calls
- ❌ ЗАПРЕЩЕНО придумывать задачи, факты, события или цели — ТОЛЬКО то, что вернули tools
- ❌ ЗАПРЕЩЕНО ссылаться на данные, которых нет в ответах tools
- Ты НЕ создаёшь напоминания, цели или задачи — только наблюдаешь
- Ты НЕ обновляешь прогресс целей автоматически
- ЗАПРЕТ: НЕ указывай абсолютные ссылки (например, http://localhost:5000) в тексте. 
  Если нужно сослаться на раздел приложения, используй относительные пути (например, /chat).

⚠️ ИСТОЧНИКИ ДАННЫХ О ЗАДАЧАХ:
- ИСПОЛЬЗУЙ ticktick_overview как ЕДИНСТВЕННЫЙ источник данных о задачах TickTick.
  Этот инструмент получает данные НАПРЯМУЮ из API TickTick — они всегда актуальны.
- НЕ ИСПОЛЬЗУЙ ticktick_search_tasks для формирования сводки — он ищет по кэшу БД,
  который может содержать устаревшие задачи.
- Если задача НЕ появляется в ticktick_overview, значит она ЗАВЕРШЕНА или УДАЛЕНА.

Дата и время указаны в контексте — используй их для определения «сегодня» и «завтра».

Ответь кратко и по делу — это уведомление, а не диалог.
Максимум 2-3 абзаца.
`;

/**
 * Очистка контента от случайных localhost ссылок (защита от галлюцинаций AI)
 */
function sanitizeContent(content: string): string {
    const appUrl = process.env.APP_URL || 'http://localhost:5000';
    if (!content) return content;
    
    // Заменяем http://localhost:5000 или https://localhost:5000 на APP_URL
    // Также заменяем просто localhost:5000 на домен из APP_URL если возможно
    let sanitized = content.replace(/https?:\/\/localhost:5000/g, appUrl);
    
    // Если в APP_URL есть протокол и домен, пробуем заменить "localhost:5000" без протокола
    try {
        const url = new URL(appUrl);
        sanitized = sanitized.replace(/localhost:5000/g, url.host);
    } catch (e) {
        // Fallback если APP_URL невалидный URL
    }
    
    return sanitized;
}

/**
 * Выполнить умную проактивную проверку через ReAct Loop с tools.
 * AI может вызывать get_goals, search_facts, update_goal, remember_fact и др.
 */
async function executeSmartProactiveCheck(
    taskDescription: string,
    contextData: string,
): Promise<string> {
    const tools = resolveToolsForRequest({
        agentSlug: 'proactive',
        exclude: ['delegate_task', 'schedule_task', 'create_reminder', 'update_goal', 'create_goal'],
    });

    const aiConfig = await getAIClientForTask('proactive_check');

    const result = await executeReActLoop({
        messages: [
            { role: 'system', content: PROACTIVE_SYSTEM_PROMPT },
            { role: 'user', content: `${taskDescription}\n\nКонтекст:\n${contextData}` },
        ],
        tools,
        aiConfig,
        context: { sessionId: 'proactive', messageId: 0, isSubagent: true },
        agentSlug: 'proactive',
        maxIterations: 6,
    });

    console.log(`[ProactiveAI] ✅ Завершено: ${result.iterations} итераций, ${result.toolCalls.length} tool calls, ${result.tokensUsed} tokens`);

    return sanitizeContent(result.content);
}

/**
 * Утренний briefing — AI-генерируемая сводка на день с tools
 */
async function generateMorningBriefing(): Promise<ProactiveMessage | null> {
    const moscowHour = getMoscowHour();

    // Отправляем только с 9:00 до 9:59
    if (moscowHour !== CONFIG.morningBriefingHour) {
        return null;
    }

    // Проверяем, отправляли ли уже сегодня
    if (!await checkCooldown('morning_briefing')) {
        return null;
    }

    try {
        const dateStr = getMoscowFormattedDate();
        const timeStr = getMoscowFormattedTime();

        const content = await executeSmartProactiveCheck(
            'Подготовь утренний брифинг для пользователя.\n\n'
            + '⚠️ ВАЖНО: Используй ТОЛЬКО актуальные данные из tool calls. НЕ придумывай задачи и факты.\n\n'
            + 'Выполни tool calls в таком порядке:\n'
            + '1. ticktick_overview — ОБЯЗАТЕЛЬНО ПЕРВЫМ! Это ЕДИНСТВЕННЫЙ источник задач (данные напрямую из API TickTick)\n'
            + '2. get_goals — активные цели и их прогресс, дедлайны\n'
            + '3. НЕ вызывай search_facts и ticktick_search_tasks — для утреннего брифинга они не нужны\n\n'
            + '⚠️ ТОЛЬКО ticktick_overview содержит актуальные задачи! НЕ ищи задачи другими инструментами.\n'
            + 'Если задачи нет в ticktick_overview — она уже выполнена или перенесена.\n\n'
            + 'На основе РЕАЛЬНЫХ данных из tools сформируй краткую сводку:\n'
            + '- 🔴 Просроченные задачи (если есть)\n'
            + '- 📅 Задачи на сегодня\n'
            + '- 🎯 Приоритеты по целям\n'
            + '- ⏰ Ближайшие дедлайны\n\n'
            + 'Максимум 10-15 строк. Начинай с самого важного.',
            `Сегодня: ${dateStr}, ${timeStr} (МСК)`,
        );

        return {
            type: 'morning_briefing',
            title: '☀️ Доброе утро!',
            content,
            priority: 'medium',
            actions: [
                { id: 'to_chat', label: 'В чат', variant: 'primary', icon: '💬' }
            ]
        };
    } catch (error) {
        console.error('[ProactiveAI] ❌ Ошибка утреннего брифинга:', error);
        return null;
    }
}

/**
 * Вечерний recap — AI-генерируемые итоги дня с tools
 */
async function generateEveningRecap(): Promise<ProactiveMessage | null> {
    const moscowHour = getMoscowHour();

    // Отправляем только с 21:00 до 21:59
    if (moscowHour !== CONFIG.eveningBriefingHour) {
        return null;
    }

    // Проверяем, отправляли ли уже сегодня
    if (!await checkCooldown('evening_recap')) {
        return null;
    }

    try {
        const dateStr = getMoscowFormattedDate();
        const timeStr = getMoscowFormattedTime();

        const content = await executeSmartProactiveCheck(
            'Подготовь вечернюю сводку — итоги дня.\n\n'
            + '⚠️ ВАЖНО: Используй ТОЛЬКО актуальные данные из tool calls. НЕ придумывай задачи и события.\n\n'
            + 'Выполни tool calls:\n'
            + '1. ticktick_overview — ЕДИНСТВЕННЫЙ источник задач! Покажет что осталось, что просрочено\n'
            + '2. get_goals — текущий прогресс по целям\n'
            + '3. get_recent_messages с limit=10 — что обсуждали за день (только если нужен контекст)\n'
            + '4. НЕ используй ticktick_search_tasks — он может показать устаревшие данные из кэша\n\n'
            + '⚠️ ТОЛЬКО ticktick_overview содержит актуальные задачи! НЕ ищи задачи другими инструментами.\n\n'
            + 'На основе РЕАЛЬНЫХ данных сформируй краткую вечернюю сводку:\n'
            + '- 📊 Что выполнено / что осталось\n'
            + '- 🔴 Просроченные задачи (если есть — обрати внимание!)\n'
            + '- 📅 Что запланировано на завтра\n'
            + '- 🎯 Прогресс по целям\n\n'
            + 'Максимум 10-15 строк. Тон: ободряющий, конструктивный.',
            `Сегодня: ${dateStr}, ${timeStr} (МСК)`,
        );

        return {
            type: 'evening_recap',
            title: '🌙 Вечерняя сводка',
            content,
            priority: 'low',
            actions: [
                { id: 'to_chat', label: 'В чат', variant: 'primary', icon: '💬' }
            ]
        };
    } catch (error) {
        console.error('[ProactiveAI] ❌ Ошибка вечерней сводки:', error);
        return null;
    }
}

// ============================================================================
// Cooldown и фильтрация
// ============================================================================

/**
 * Проверка cooldown — не отправляли ли недавно такое же напоминание
 */
async function checkCooldown(type: ProactiveMessageType, relatedId?: number): Promise<boolean> {
    // Для briefing используем 20-часовой cooldown (чтобы точно 1 раз в день)
    // Для weekly_review — 120 часов (5 дней), чтобы не дублировать
    // Для strategic_advice — 10 часов (максимум 2 раза в день)
    const cooldownMs = (type === 'morning_briefing' || type === 'evening_recap')
        ? 20 * 60 * 60 * 1000
        : type === 'weekly_review'
            ? 120 * 60 * 60 * 1000
            : type === 'strategic_advice'
                ? 10 * 60 * 60 * 1000
                : CONFIG.cooldownHours * 60 * 60 * 1000;

    const cooldownTime = new Date(Date.now() - cooldownMs);

    const recent = await db.select()
        .from(proactiveMessages)
        .where(and(
            eq(proactiveMessages.messageType, type as any),
            relatedId ? eq(proactiveMessages.relatedEntityId, relatedId) : sql`1=1`,
            gt(proactiveMessages.sentAt, cooldownTime)
        ))
        .limit(1);

    return recent.length === 0; // true если cooldown прошёл
}

/**
 * Проверка дневного лимита напоминаний
 */
async function checkDailyLimit(): Promise<boolean> {
    const todayStart = getMoscowMidnight();

    const todayCount = await db.select({ count: sql<number>`count(*)` })
        .from(proactiveMessages)
        .where(gt(proactiveMessages.sentAt, todayStart));

    return (todayCount[0]?.count || 0) < CONFIG.maxDailyReminders;
}

/**
 * Запись отправленного напоминания
 */
async function recordSentMessage(message: ProactiveMessage, delivered: boolean): Promise<void> {
    await db.insert(proactiveMessages).values({
        messageType: message.type as any,
        title: message.title,
        content: message.content,
        priority: message.priority,
        relatedEntityId: message.relatedId,
        relatedEntityType: message.relatedType,
        delivered,
        deliveredAt: delivered ? new Date() : undefined,
        sentAt: new Date(),
    });
}

// ============================================================================
// Доставка — все проактивные сообщения идут в чат
// ============================================================================

/**
 * Сохранить проактивное сообщение как обычное AI-сообщение в чат.
 * - Сохраняется в БД (персистентно)
 * - excludeFromContext: true (не засоряет промпт AI)
 * - Транслируется через WebSocket как new_message
 * - Заголовок добавляется к тексту для визуальной идентификации
 */
async function saveProactiveToChat(message: ProactiveMessage): Promise<boolean> {
    try {
        // Формируем content с заголовком
        const chatContent = `${message.title}\n\n${message.content}`;

        const chatMessage = await storage.createMessage({
            content: chatContent,
            type: 'text',
            sender: 'ai',
            status: 'sent',
            excludeFromContext: true,
        });

        // Транслируем как обычное сообщение чата
        const payload = JSON.stringify({
            type: 'new_message',
            message: chatMessage,
        });

        let delivered = false;
        for (const client of Array.from(wsClients)) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
                delivered = true;
            }
        }

        return delivered;
    } catch (err) {
        console.error('[ProactiveAI] ❌ Ошибка сохранения в чат:', err);
        return false;
    }
}

// ============================================================================
// Главный цикл
// ============================================================================

/**
 * Проверка всех триггеров и отправка напоминаний
 */
let isRunning = false;

async function runProactiveCheck(): Promise<void> {
    if (isRunning) {
        console.log('🔔 Proactive check already running, skipping');
        return;
    }
    isRunning = true;
    console.log('🔔 Proactive check started...');

    try {
        // Проверяем дневной лимит
        if (!await checkDailyLimit()) {
            console.log('🔔 Daily limit reached, skipping');
            return;
        }

        // Собираем все сообщения
        const allMessages: ProactiveMessage[] = [];

        // AI-Cron задачи (выполняются ВСЕГДА — это явные пользовательские scheduled tasks)
        try {
            const cronCount = await aiTaskScheduler.checkAndExecuteOverdueTasks();
            if (cronCount > 0) {
                console.log(`📅 [AiCron] Выполнено ${cronCount} cron-задач`);
            }
        } catch (error) {
            console.error('📅 [AiCron] Ошибка проверки cron-задач:', error);
        }

        // Тихие часы — ГЛОБАЛЬНЫЙ СТОП для всех уведомлений
        const quietHoursActive = await notificationService.isQuietHours();
        if (quietHoursActive) {
            console.log('🌙 Тихие часы — все уведомления отложены');
            return;
        }

        // ТикТик — Глобальная синхронизация (фоновое обновление кэша)
        try {
            const { tickTickService } = await import("./services/tickTickService");
            if (tickTickService.isConfigured() && tickTickService.isAuthenticated()) {
                // Синхронизируем каждые 15 минут
                const lastSync = await storage.getSetting('last_ticktick_sync');
                const now = Date.now();
                if (!lastSync || now - parseInt(lastSync) > 15 * 60 * 1000) {
                    console.log('🔄 [TickTick] Фоновая синхронизация задач...');
                    await tickTickService.syncAllProjects();
                    await storage.setSetting('last_ticktick_sync', now.toString());
                }
            }
        } catch (error) {
            console.error('🔄 [TickTick] Ошибка фоновой синхронизации:', error);
        }

        // Персональные напоминания (user-created, remindAt наступило)
        const reminderMessages = await checkPersonalReminders();
        allMessages.push(...reminderMessages);

        // Briefings
        const morningBriefing = await generateMorningBriefing();
        if (morningBriefing) {
            allMessages.push(morningBriefing);
        }

        const eveningRecap = await generateEveningRecap();
        if (eveningRecap) {
            allMessages.push(eveningRecap);
        }

        // Strategic Advice — доставка стратегического видения (после CogLoop)
        // Проверяем, есть ли свежее видение от advisorEngine
        const latestVision = getLastStrategicVision();
        if (latestVision && latestVision.advice.length > 0) {
            // Проверяем cooldown для strategic_advice
            if (await checkCooldown('strategic_advice')) {
                const strategicMsg = formatStrategicAdviceMessage(latestVision);
                if (strategicMsg) {
                    allMessages.push(strategicMsg);
                }
            }
        }

        // GTD: goal_progress push удалён — AI-советы показываются только при Weekly Review или по запросу
        const moscowHour = getMoscowHour();

        // Weekly Review (понедельник, 10:00 MSK)
        if (CONFIG.enableWeeklyReview) {
            try {
                const weeklyReview = await generateWeeklyReview();
                if (weeklyReview) {
                    allMessages.push(weeklyReview);
                }
            } catch (error) {
                console.error('❌ Ошибка weekly review:', error);
            }
        }

        // AutoQuery для Key Results (1 раз в день, 11:00 MSK, с cooldown)
        if (moscowHour === 11) {
            try {
                const lastAutoQuery = await storage.getSetting('last_autoquery_date');
                const todayStr = new Date().toISOString().split('T')[0];
                if (lastAutoQuery !== todayStr) {
                    const autoQueryResults = await executeAutoQueries();
                    if (autoQueryResults.updated > 0) {
                        console.log(`📊 [AutoQuery] Обновлено ${autoQueryResults.updated}/${autoQueryResults.total} KR`);
                    }
                    await storage.setSetting('last_autoquery_date', todayStr);
                }
            } catch (error) {
                console.error('❌ Ошибка autoQuery:', error);
            }
        }

        // Дедлайны — hard landscape (GTD), всегда проверяем
        // GTD: goal_stalled и topic_abandoned push удалены — показываются только в Weekly Review
        // Дедлайны — high priority, проверяем ВСЕГДА (не зависит от других сообщений)
        const deadlineMessages = await checkGoalDeadlines();
        allMessages.push(...deadlineMessages);

        // Сортируем по приоритету
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        allMessages.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

        // Отправляем максимум 2 сообщения за проверку
        let sentCount = 0;
        for (const message of allMessages) {
            if (sentCount >= 2) break;

            // Для briefing и strategic_advice cooldown уже проверен внутри функции/выше
            if (message.type !== 'morning_briefing' && message.type !== 'evening_recap' && message.type !== 'strategic_advice') {
                if (!await checkCooldown(message.type, message.relatedId)) {
                    continue;
                }
            }

            // === Единый канал доставки: сохраняем в чат как AI-сообщение ===
            let delivered = await saveProactiveToChat(message);

            // Fallback 1: Web Push (если WebSocket не доставил)
            if (!delivered) {
                try {
                    const pushTitle = message.title || 'AI Ассистент';
                    delivered = await webPushService.sendPushToAll(
                        pushTitle,
                        message.content.substring(0, 200),
                        { type: message.type, tag: `proactive-${message.type}` }
                    );
                    if (delivered) {
                        console.log(`🔔 Web Push delivered: ${message.type}`);
                    }
                } catch (error) {
                    console.error('🔔 Web Push error:', error);
                }
            }

            // Fallback 2: Telegram (если ни WS ни Push не доставили)
            if (!delivered && await notificationService.isTelegramEnabled()) {
                try {
                    const priorityEmoji = message.priority === 'high' ? '🚨' : message.priority === 'medium' ? '📊' : '💡';
                    let text = '';

                    const appUrl = process.env.APP_URL || 'http://localhost:5000';

                    if (message.type === 'morning_briefing') {
                        text = `☀️ <b>Доброе утро!</b>\n\n${escapeHtml(message.content)}`;
                        text += `\n\n<a href="${appUrl}/chat">Перейти в чат</a>`;
                        delivered = await notificationService.sendTelegramMessage(text);
                    } else if (message.type === 'evening_recap') {
                        text = `🌙 <b>Вечерняя сводка</b>\n\n${escapeHtml(message.content)}`;
                        text += `\n\n<a href="${appUrl}/chat">Перейти в чат</a>`;
                        delivered = await notificationService.sendTelegramMessage(text);
                    } else if (message.type === 'personal_reminder' && message.relatedId) {
                        // Напоминание с inline кнопками (Telegram)
                        text = `${priorityEmoji} <b>${escapeHtml(message.title)}</b>\n\n${escapeHtml(message.content)}`;
                        const buttons = [
                            [
                                { text: '⏸️ +15 мин', callback_data: `snooze_15:${message.relatedId}` },
                                { text: '⏰ +1 час', callback_data: `snooze_60:${message.relatedId}` },
                            ],
                            [
                                { text: '✅ Готово', callback_data: `done:${message.relatedId}` },
                                { text: '❌ Отменить', callback_data: `cancel:${message.relatedId}` },
                            ],
                        ];
                        const result = await notificationService.sendTelegramMessageWithButtons(text, buttons);
                        delivered = result.ok;
                    } else {
                        text = `${priorityEmoji} <b>${escapeHtml(message.title)}</b>\n\n${escapeHtml(message.content)}`;
                        text += `\n\n<a href="${appUrl}/chat">Открыть помощника</a>`;
                        delivered = await notificationService.sendTelegramMessage(text);
                    }

                    if (delivered) {
                        console.log(`📱 Telegram fallback: ${message.type}`);
                    }
                } catch (error) {
                    console.error('📱 Telegram fallback error:', error);
                }
            }

            await recordSentMessage(message, delivered);

            // Помечаем напоминание как отправленное
            if (message.type === 'personal_reminder' && delivered && message.relatedId) {
                await reminderService.markReminderSent(message.relatedId);
            }

            console.log(`🔔 Proactive: ${message.type} - ${message.title} (delivered: ${delivered})`);
            sentCount++;
        }

        if (sentCount === 0) {
            console.log('🔔 No proactive messages to send');
        }

        // 🧠 Cognitive Loop: фоновый мыслительный цикл ассистента
        // + Profile Synthesis: фоновая проверка и синтез профиля
        // Оба запускаются fire-and-forget, не блокируют доставку уведомлений

        // 🛡️ API Health Guard: пропускаем фоновые AI-задачи если провайдер недоступен
        if (!apiHealth.isAnyProviderHealthy()) {
            console.warn('[ProactiveAI] ⚠️ Все AI-провайдеры на паузе — пропускаем CogLoop и ProfileSynthesis');
        } else {
            runThinkingCycle().then(result => {
                if (result) {
                    console.log(`🧠 [CogLoop] ${result.mode}: ${result.discoveries.length} discoveries, ${result.tokensUsed} tokens`);
                }
            }).catch(err =>
                console.error('[CogLoop] ❌ Ошибка мыслительного цикла:', err)
            );

            synthesizeAllCategories().catch(err =>
                console.error('[ProfileSynthesis] ❌ Ошибка фонового синтеза:', err)
            );
        }
    } catch (error) {
        console.error('🔔 Proactive check error:', error);
    } finally {
        isRunning = false;
    }
}

/**
 * Получение непоказанных напоминаний (для показа при входе)
 */
export async function getPendingNotifications(): Promise<ProactiveMessage[]> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const pending = await db.select()
        .from(proactiveMessages)
        .where(and(
            eq(proactiveMessages.delivered, false),
            eq(proactiveMessages.dismissed, false),
            gt(proactiveMessages.sentAt, oneDayAgo)
        ))
        .orderBy(desc(proactiveMessages.sentAt))
        .limit(5);

    return pending.map(p => ({
        type: p.messageType as ProactiveMessageType,
        title: p.title,
        content: p.content,
        priority: p.priority as 'high' | 'medium' | 'low',
        relatedId: p.relatedEntityId || undefined,
        relatedType: p.relatedEntityType || undefined,
    }));
}

/**
 * Пометить напоминания как доставленные
 */
export async function markNotificationsDelivered(ids: number[]): Promise<void> {
    for (const id of ids) {
        await db.update(proactiveMessages)
            .set({ delivered: true })
            .where(eq(proactiveMessages.id, id));
    }
}

// ============================================================================
// Strategic Advice Formatter
// ============================================================================

/**
 * Форматирует стратегическое видение от advisorEngine в ProactiveMessage
 */
function formatStrategicAdviceMessage(vision: StrategicVision): ProactiveMessage | null {
    if (!vision || vision.advice.length === 0) return null;

    // Формируем содержимое из видения + топ советов
    const parts: string[] = [];

    if (vision.summary) {
        parts.push(`📊 **Стратегическое видение:**\n${vision.summary}`);
    }

    const adviceIcons: Record<string, string> = {
        strategic_focus: '🎯',
        balance_check: '⚖️',
        reevaluation: '🔄',
        cross_domain_insight: '💡',
        behavior_mirror: '🪞',
        opportunity: '✨',
    };

    for (const advice of vision.advice.slice(0, 3)) {
        const icon = adviceIcons[advice.type] || '📌';
        parts.push(`${icon} **${advice.title}**\n${advice.content}`);
        if (advice.suggestedAction) {
            parts.push(`→ *Рекомендация:* ${advice.suggestedAction}`);
        }
    }

    const content = parts.join('\n\n');

    // Определяем приоритет по наличию high-priority советов
    const hasHighPriority = vision.advice.some(a => a.priority === 'high');
    const priority = hasHighPriority ? 'high' : 'medium';

    return {
        type: 'strategic_advice',
        title: '🎯 Стратегический совет',
        content,
        priority: priority as 'high' | 'medium' | 'low',
        actions: [
            { id: 'discuss', label: 'Обсудить', icon: '💬', variant: 'primary' },
            { id: 'accepted', label: 'Принял', icon: '✅', variant: 'secondary' },
            { id: 'not_now', label: 'Не сейчас', icon: '⏭️', variant: 'secondary' },
        ],
        // Передаём структурированные данные советов для UI-карточки
        adviceDetails: vision.advice.slice(0, 3).map(a => ({
            type: a.type,
            title: a.title,
            content: a.content,
            reasoning: a.reasoning,
            priority: a.priority,
            suggestedAction: a.suggestedAction,
            profileBasis: a.profileBasis,
            relatedGoalIds: a.relatedGoalIds,
        })),
    };
}

// ============================================================================
// Утилиты
// ============================================================================

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ============================================================================
// Инициализация
// ============================================================================

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Запуск scheduler
 */
export async function startProactiveScheduler(): Promise<void> {
    if (schedulerInterval) {
        console.log('🔔 Proactive scheduler already running');
        return;
    }

    // Загружаем настройки из БД
    await reloadConfig();

    console.log(`🔔 Proactive scheduler started (interval: ${CONFIG.checkIntervalMs / 1000}s)`);

    // Первая проверка через 1 минуту после старта
    setTimeout(() => {
        runProactiveCheck();
    }, 60 * 1000);

    // Периодические проверки
    schedulerInterval = setInterval(async () => {
        await reloadConfig(); // Перезагружаем настройки
        runProactiveCheck();
    }, CONFIG.checkIntervalMs);
}

/**
 * Остановка scheduler
 */
export function stopProactiveScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('🔔 Proactive scheduler stopped');
    }
}
