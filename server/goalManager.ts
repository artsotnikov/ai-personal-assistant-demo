/**
 * Goal Manager — Менеджер целей пользователя
 * 
 * Функции:
 * - CRUD операции с целями
 * - Извлечение целей из сообщений
 * - Отслеживание прогресса
 * - Напоминания о просроченных целях
 */

import { db } from "./db";
import {
    goals, goalKeyResults, goalMilestones, goalTasks, goalActivityLog, ticktickTasks,
    type Goal, type InsertGoal,
    type GoalKeyResult, type InsertGoalKeyResult,
    type GoalMilestone, type InsertGoalMilestone,
    type GoalTask, type InsertGoalTask,
    type GoalActivityLog, type InsertGoalActivityLog,
} from "@shared/schema";
import { eq, and, lt, not, desc, isNotNull, sql } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { createGoalEmbedding } from "./embeddingService";

/**
 * Получение всех целей
 */
export async function getAllGoals(): Promise<Goal[]> {
    return db.select()
        .from(goals)
        .orderBy(goals.createdAt);
}

/**
 * Получение активных целей
 */
export async function getActiveGoals(): Promise<Goal[]> {
    return db.select()
        .from(goals)
        .where(eq(goals.status, "active"))
        .orderBy(goals.deadline);
}

/**
 * Получение цели по ID
 */
export async function getGoalById(id: number): Promise<Goal | null> {
    const result = await db.select()
        .from(goals)
        .where(eq(goals.id, id))
        .limit(1);
    return result[0] || null;
}

/**
 * Создание цели
 */
export async function createGoal(data: InsertGoal): Promise<Goal> {
    const result = await db.insert(goals)
        .values(data)
        .returning();

    const goal = result[0];
    console.log(`🎯 Создана цель: ${data.title}`);

    // Создаём embedding для семантического поиска (асинхронно, не блокируем)
    const textForEmbedding = `${data.title}. ${data.description || ''}`;
    createGoalEmbedding(goal.id, textForEmbedding).catch(err => {
        console.error(`⚠️ Не удалось создать embedding для цели ${goal.id}:`, err.message);
    });

    return goal;
}

/**
 * Обновление цели
 */
export async function updateGoal(
    id: number,
    updates: Partial<InsertGoal>
): Promise<Goal | null> {
    const result = await db.update(goals)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning();
    return result[0] || null;
}

/**
 * Обновление прогресса цели
 */
export async function updateGoalProgress(
    id: number,
    progress: number
): Promise<Goal | null> {
    // Ограничиваем прогресс 0-100
    const clampedProgress = Math.max(0, Math.min(100, progress));

    // Если прогресс 100%, автоматически отмечаем как выполнено
    const status = clampedProgress >= 100 ? "completed" : "active";

    return updateGoal(id, { progress: clampedProgress, status });
}

/**
 * Удаление цели
 */
export async function deleteGoal(id: number): Promise<void> {
    await db.delete(goals)
        .where(eq(goals.id, id));
}

/**
 * Получение просроченных целей
 */
export async function getOverdueGoals(): Promise<Goal[]> {
    const now = new Date();
    return db.select()
        .from(goals)
        .where(
            and(
                eq(goals.status, "active"),
                lt(goals.deadline, now)
            )
        );
}

/**
 * Получение срочных целей (дедлайн в ближайшие N дней)
 */
export async function getUrgentGoals(days: number = 7, limit: number = 3): Promise<Goal[]> {
    const now = new Date();
    const futureDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const result = await db.select()
        .from(goals)
        .where(
            and(
                eq(goals.status, "active"),
                lt(goals.deadline, futureDate)
            )
        )
        .orderBy(goals.deadline)
        .limit(limit);

    return result;
}

/**
 * Получение целей для контекста AI (гибридный подход)
 * 
 * Логика:
 * 1. Срочные (дедлайн скоро) — до 3
 * 2. Просроченные (требуют внимания) — до 2
 * 3. Семантически релевантные текущему сообщению — до 5
 * 
 * Итого максимум ~10 целей, без дубликатов
 */
export async function getGoalsForContext(userMessage: string): Promise<{
    goals: Goal[];
    summary: string;
}> {
    // Импортируем здесь, чтобы избежать циклических зависимостей
    const { searchGoalsByQuery } = await import("./embeddingService");

    try {
        // 1. Срочные цели (дедлайн в ближайшие 7 дней)
        const urgentGoals = await getUrgentGoals(7, 3);

        // 2. Просроченные цели
        const overdueGoals = (await getOverdueGoals()).slice(0, 2);

        // 3. Семантически релевантные
        let relevantGoals: Goal[] = [];
        try {
            const relevantResults = await searchGoalsByQuery(userMessage, 5, 0.45);
            if (relevantResults.length > 0) {
                const relevantIds = relevantResults.map(r => r.id);
                const allGoals = await getActiveGoals();
                relevantGoals = allGoals.filter(g => relevantIds.includes(g.id));
            }
        } catch (error) {
            console.log(`⚠️ Семантический поиск целей недоступен:`, error);
        }

        // Объединяем без дубликатов
        const seenIds = new Set<number>();
        const combinedGoals: Goal[] = [];

        for (const goal of [...overdueGoals, ...urgentGoals, ...relevantGoals]) {
            if (!seenIds.has(goal.id)) {
                seenIds.add(goal.id);
                combinedGoals.push(goal);
            }
        }

        // Формируем summary
        let summary = '';
        if (combinedGoals.length === 0) {
            summary = 'Целей не найдено';
        } else {
            const parts: string[] = [];
            if (overdueGoals.length > 0) parts.push(`${overdueGoals.length} просрочено`);
            if (urgentGoals.length > 0) parts.push(`${urgentGoals.length} срочных`);
            if (relevantGoals.length > 0) parts.push(`${relevantGoals.length} по теме`);
            summary = `${combinedGoals.length} целей (${parts.join(', ')})`;
        }

        return { goals: combinedGoals, summary };

    } catch (error) {
        console.error("Ошибка получения целей для контекста:", error);
        return { goals: [], summary: 'Ошибка загрузки целей' };
    }
}

/**
 * Извлечение целей из сообщения пользователя
 */
export async function extractGoalsFromMessage(message: string): Promise<InsertGoal[]> {
    console.log(`🎯 [GoalExtractor] Начало извлечения целей из сообщения: "${message.substring(0, 100)}..."`);

    let aiConfig;
    try {
        aiConfig = await getAIClientForTask('goal_extraction');
        console.log(`🎯 [GoalExtractor] AI клиент успешно создан: ${aiConfig.provider}/${aiConfig.model}`);
    } catch (error) {
        console.error(`🎯 [GoalExtractor] ❌ Ошибка создания AI клиента:`, error);
        return [];
    }

    // Формируем текущую дату/время для корректного парсинга относительных дат
    const now = new Date();
    const moscowTimeStr = now.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long',
        hour12: false
    });
    const moscowISODate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

    const prompt = `Проанализируй сообщение пользователя и определи, содержит ли оно НАСТОЯЩУЮ ЖИЗНЕННУЮ ЦЕЛЬ.

═══════════════════════════════════════════════════════════════
ТЕКУЩАЯ ДАТА И ВРЕМЯ (Москва, UTC+3): ${moscowTimeStr}
ТЕКУЩАЯ ДАТА ISO: ${moscowISODate}
═══════════════════════════════════════════════════════════════

Сообщение:
"${message}"

═══════════════════════════════════════════════════════════════
КРИТЕРИИ НАСТОЯЩЕЙ ЦЕЛИ (должны выполняться ВСЕ):
═══════════════════════════════════════════════════════════════

✅ ДОЛГОСРОЧНОСТЬ: Достижение занимает недели, месяцы или годы
✅ ЗНАЧИМОСТЬ: Это важное жизненное достижение (финансовое, карьерное, личностное, здоровье)
✅ ИЗМЕРИМОСТЬ: Можно определить, достигнута цель или нет
✅ ТРЕБУЕТ ПЛАНИРОВАНИЯ: Нужны усилия, ресурсы, шаги для достижения

Индикаторы настоящих целей:
- "моя цель", "ставлю цель", "поставил цель"
- "хочу" + значимое достижение (купить, накопить, достичь, научиться)
- "планирую" + долгосрочный результат
- "мечтаю", "стремлюсь к"
- Конкретные сроки: "к маю", "до конца года", "через полгода"
- Конкретные суммы/метрики: "500 тысяч", "10 кг", "уровень B2"

═══════════════════════════════════════════════════════════════
ЧТО НЕ ЯВЛЯЕТСЯ ЦЕЛЬЮ (игнорируй полностью):
═══════════════════════════════════════════════════════════════

❌ КОМАНДЫ ДЛЯ СИСТЕМЫ:
   - "напомни", "создай напоминание", "поставь будильник"
   - "уведоми меня", "напомнить через N минут"
   
❌ ОДНОРАЗОВЫЕ ЗАДАЧИ (не цели):
   - "позвонить", "написать", "проверить", "купить молоко"
   - Любое действие, которое можно выполнить за минуты/часы
   
❌ ТЕСТОВЫЕ СООБЩЕНИЯ:
   - "протестировать", "проверить работу", "тест"
   
❌ ВОПРОСЫ И ОБСУЖДЕНИЯ:
   - "как сделать...", "что думаешь о...", "расскажи про..."

═══════════════════════════════════════════════════════════════
ПРИМЕРЫ
═══════════════════════════════════════════════════════════════

✅ ЦЕЛИ:
- "Хочу накопить на машину 500 тысяч к маю" → ЦЕЛЬ
- "Моя цель — выучить английский до уровня B2" → ЦЕЛЬ
- "Планирую открыть свой бизнес в этом году" → ЦЕЛЬ
- "Хочу похудеть на 10 кг" → ЦЕЛЬ

❌ НЕ ЦЕЛИ:
- "Напомни мне позвонить через 5 минут" → команда напоминания
- "Создать тестовое уведомление" → тестовая команда
- "Хочу заказать пиццу" → одноразовая задача
- "Протестировать как работают напоминания" → тест системы

═══════════════════════════════════════════════════════════════

Если найдена НАСТОЯЩАЯ цель, извлеки:
1. title — краткое название достижения
2. description — полное описание с деталями (сумма, сроки, контекст)
3. deadline — дедлайн в формате YYYY-MM-DD (если указан, иначе null)
4. progress — начальный прогресс (обычно 0)

ВАЖНО при парсинге сроков (используй ТЕКУЩУЮ ДАТУ выше!):
- "завтра" = следующий день от текущей даты
- "через неделю" = текущая дата + 7 дней
- "к маю" = май ТЕКУЩЕГО года (если май уже прошёл — следующего года)
- "в феврале" = февраль ТЕКУЩЕГО года (если уже прошёл — следующего)
- "до конца года" = 31 декабря ТЕКУЩЕГО года
- "через полгода" = текущая дата + 6 месяцев

Ответ СТРОГО в JSON:
{
  "goals": [
    {
      "title": "Краткое название цели",
      "description": "Полное описание",
      "deadline": "YYYY-MM-DD" или null,
      "progress": 0
    }
  ]
}

Если настоящих целей нет — верни: {"goals": []}`;

    console.log(`🎯 [GoalExtractor] Отправляю запрос в ${aiConfig.provider}/${aiConfig.model}...`);

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: aiConfig.systemPrompt!
            },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";
        console.log(`🎯 [GoalExtractor] Ответ OpenAI получен: "${content.substring(0, 200)}..."`);

        try {
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            console.log(`🎯 [GoalExtractor] Очищенный JSON: "${cleanContent.substring(0, 200)}..."`);

            const parsed = JSON.parse(cleanContent);
            console.log(`🎯 [GoalExtractor] JSON успешно распарсен, найдено целей: ${parsed.goals?.length || 0}`);

            const extractedGoals: InsertGoal[] = [];

            if (Array.isArray(parsed.goals)) {
                for (const goal of parsed.goals) {
                    if (goal.title) {
                        const newGoal: InsertGoal = {
                            title: goal.title,
                            description: goal.description || null,
                            deadline: goal.deadline ? new Date(goal.deadline) : null,
                            progress: goal.progress || 0,
                            status: "active",
                        };
                        extractedGoals.push(newGoal);
                        console.log(`🎯 [GoalExtractor] ✅ Извлечена цель: "${goal.title}" (дедлайн: ${goal.deadline || 'не указан'})`);
                    }
                }
            } else {
                console.log(`🎯 [GoalExtractor] ⚠️ parsed.goals не является массивом:`, parsed);
            }

            console.log(`🎯 [GoalExtractor] Итого извлечено целей: ${extractedGoals.length}`);
            return extractedGoals;

        } catch (parseError) {
            console.error(`🎯 [GoalExtractor] ❌ Ошибка парсинга JSON:`, parseError);
            console.error(`🎯 [GoalExtractor] ❌ Содержимое, которое не удалось распарсить:`, content);
            return [];
        }
    } catch (error) {
        console.error(`🎯 [GoalExtractor] ❌ Ошибка вызова OpenAI:`, error);
        return [];
    }
}

/**
 * Генерация отчёта о прогрессе
 */
export async function generateProgressReport(): Promise<string> {
    const activeGoals = await getActiveGoals();
    const overdueGoals = await getOverdueGoals();
    const completedGoals = await db.select()
        .from(goals)
        .where(eq(goals.status, "completed"));

    const parts: string[] = [];

    parts.push(`📊 **Отчёт о целях**\n`);

    // Статистика
    parts.push(`📈 Статистика:`);
    parts.push(`- Активных целей: ${activeGoals.length}`);
    parts.push(`- Выполнено: ${completedGoals.length}`);
    parts.push(`- Просрочено: ${overdueGoals.length}\n`);

    // Активные цели
    if (activeGoals.length > 0) {
        parts.push(`🎯 **Активные цели:**`);
        for (const goal of activeGoals) {
            const progressBar = generateProgressBar(goal.progress);
            const deadline = goal.deadline
                ? ` (до ${goal.deadline.toLocaleDateString("ru-RU")})`
                : "";
            parts.push(`- ${goal.title}${deadline}: ${progressBar} ${goal.progress}%`);
        }
    }

    // Просроченные
    if (overdueGoals.length > 0) {
        parts.push(`\n⚠️ **Требуют внимания (просрочены):**`);
        for (const goal of overdueGoals) {
            parts.push(`- ${goal.title}`);
        }
    }

    return parts.join("\n");
}

/**
 * Визуальный прогресс-бар
 */
function generateProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Форматирование целей для промпта агента
 */
export async function getGoalsContextForPrompt(): Promise<string> {
    const activeGoals = await getActiveGoals();
    const overdueGoals = await getOverdueGoals();

    if (activeGoals.length === 0 && overdueGoals.length === 0) {
        return "";
    }

    const parts: string[] = ["## Цели пользователя"];

    if (activeGoals.length > 0) {
        parts.push("Активные:");
        for (const goal of activeGoals.slice(0, 5)) { // Лимитируем для промпта
            parts.push(`- [ID: ${goal.id}] ${goal.title} (${goal.progress}%)`);
        }
    }

    if (overdueGoals.length > 0) {
        parts.push("\n⚠️ Просрочены:");
        for (const goal of overdueGoals.slice(0, 3)) {
            parts.push(`- ${goal.title}`);
        }
    }

    return parts.join("\n");
}

// ============================================================================
// Фаза 2 — Автоматизация: milestones, tasks, focus, activity log
// ============================================================================

/**
 * Получение всех вех (milestones) цели
 */
export async function getMilestonesForGoal(goalId: number): Promise<GoalMilestone[]> {
    return db.select()
        .from(goalMilestones)
        .where(eq(goalMilestones.goalId, goalId))
        .orderBy(goalMilestones.sortOrder);
}

/**
 * Получение задач внутри вехи
 */
export async function getTasksForMilestone(milestoneId: number): Promise<GoalTask[]> {
    return db.select()
        .from(goalTasks)
        .where(eq(goalTasks.milestoneId, milestoneId))
        .orderBy(goalTasks.sortOrder);
}

/**
 * Получение всех задач цели (по всем milestones)
 */
export async function getTasksForGoal(goalId: number): Promise<GoalTask[]> {
    return db.select()
        .from(goalTasks)
        .where(eq(goalTasks.goalId, goalId))
        .orderBy(goalTasks.sortOrder);
}

/**
 * Получение целей в фокусе (priority = 'focus', max 3)
 */
export async function getFocusGoals(): Promise<Goal[]> {
    return db.select()
        .from(goals)
        .where(and(
            eq(goals.priority, 'focus'),
            eq(goals.status, 'active'),
        ))
        .orderBy(goals.updatedAt);
}

/**
 * Запись в журнал активности цели
 */
export async function logGoalActivity(
    goalId: number,
    activityType: string,
    description: string,
    metadata?: Record<string, any>,
    sourceMessageId?: number,
): Promise<GoalActivityLog> {
    const result = await db.insert(goalActivityLog).values({
        goalId,
        activityType,
        description,
        metadata: metadata || null,
        sourceMessageId: sourceMessageId || null,
    }).returning();
    return result[0];
}

/**
 * Автоматический пересчёт прогресса цели снизу вверх:
 * tasks → milestones → goal
 * 
 * Логика:
 * 1. Для каждого milestone считаем % завершённых задач
 * 2. Если все задачи done → milestone.status = 'completed'
 * 3. Goal.progress = среднее по % milestones
 * 4. Если все milestones completed → goal.status = 'completed'
 * 5. Записываем в activity_log при изменении
 */
export async function recalculateGoalProgress(goalId: number): Promise<{
    oldProgress: number;
    newProgress: number;
    milestonesUpdated: number;
    goalCompleted: boolean;
}> {
    const goal = await getGoalById(goalId);
    if (!goal) throw new Error(`Цель с ID ${goalId} не найдена`);

    const milestones = await getMilestonesForGoal(goalId);

    // Если нет milestones — прогресс не меняем
    if (milestones.length === 0) {
        return { oldProgress: goal.progress, newProgress: goal.progress, milestonesUpdated: 0, goalCompleted: false };
    }

    let weightedPercent = 0;
    let totalWeight = 0;
    let milestonesUpdated = 0;

    for (const milestone of milestones) {
        const tasks = await getTasksForMilestone(milestone.id);
        const weight = milestone.weight || 1;

        let milestonePercent = 0;
        if (tasks.length > 0) {
            const doneTasks = tasks.filter(t => t.status === 'done').length;
            milestonePercent = Math.round((doneTasks / tasks.length) * 100);
        } else {
            // Если задач нет, используем уже имеющийся прогресс (например, от синхронизации с TickTick)
            milestonePercent = milestone.progress || 0;
        }

        // Определяем новый статус milestone
        let newMilestoneStatus: string = milestone.status;
        if (milestonePercent === 100) {
            newMilestoneStatus = 'completed';
        } else if (milestonePercent > 0) {
            newMilestoneStatus = 'in_progress';
        } else {
            newMilestoneStatus = 'pending';
        }

        // Обновляем milestone если статус изменился
        if (newMilestoneStatus !== milestone.status) {
            await db.update(goalMilestones)
                .set({
                    status: newMilestoneStatus,
                    completedAt: newMilestoneStatus === 'completed' ? new Date() : null,
                    updatedAt: new Date(),
                })
                .where(eq(goalMilestones.id, milestone.id));
            milestonesUpdated++;
        }

        weightedPercent += milestonePercent * weight;
        totalWeight += weight;
    }

    // Взвешенный прогресс по milestones (с учётом weight каждого milestone)
    const newProgress = totalWeight > 0 ? Math.round(weightedPercent / totalWeight) : 0;
    const oldProgress = goal.progress;

    // Перечитываем milestones после обновления
    const updatedMilestones = await getMilestonesForGoal(goalId);
    const goalCompleted = updatedMilestones.length > 0 && updatedMilestones.every(m => m.status === 'completed');

    // Обновляем прогресс цели
    const goalUpdates: Record<string, any> = {
        progress: newProgress,
        updatedAt: new Date(),
    };
    if (goalCompleted) {
        goalUpdates.status = 'completed';
    }

    await db.update(goals)
        .set(goalUpdates)
        .where(eq(goals.id, goalId));

    // Записываем в activity log если прогресс изменился
    if (newProgress !== oldProgress) {
        await logGoalActivity(goalId, 'progress_update',
            `Прогресс пересчитан: ${oldProgress}% → ${newProgress}%`,
            { oldProgress, newProgress, milestonesUpdated, goalCompleted },
        );
    }

    if (goalCompleted && goal.status !== 'completed') {
        await logGoalActivity(goalId, 'milestone_reached',
            `🎉 Цель завершена! Все milestones выполнены.`,
            { finalProgress: newProgress },
        );
    }

    console.log(`🎯 [GoalProgress] Цель #${goalId}: ${oldProgress}% → ${newProgress}% (${milestonesUpdated} milestones обновлено)`);

    return { oldProgress, newProgress, milestonesUpdated, goalCompleted };
}

/**
 * Синхронизация цели с задачами в TickTick.
 * 
 * 1. Обновляет статусы внутренних goal_tasks, привязанных к TickTick по ID.
 * 2. Анализирует теги в TickTick и обновляет прогресс milestones/goals.
 */
export async function syncGoalWithTickTick(goalId: number): Promise<{
    tasksSynced: number;
    milestonesSynced: number;
    progressUpdated: boolean;
}> {
    const goal = await getGoalById(goalId);
    if (!goal) throw new Error(`Цель #${goalId} не найдена`);

    let tasksSynced = 0;
    let milestonesSynced = 0;

    // 1. Прямая синхронизация задач по ID
    tasksSynced = await syncGoalTasksFromTickTick(goalId);

    // 2. Теговая синхронизация вех (если есть syncTag)
    const milestones = await getMilestonesForGoal(goalId);
    for (const milestone of milestones) {
        if (milestone.syncTag) {
            const result = await syncMilestoneViaTag(milestone.id, milestone.syncTag);
            if (result) milestonesSynced++;
        }
    }

    // 3. Теговая синхронизация всей цели (если есть syncTag у самой цели)
    // В данном прототипе мы фокусируемся на вехах, но можно расширить.

    // 4. Пересчитываем прогресс в системе Целей
    const { oldProgress, newProgress } = await recalculateGoalProgress(goalId);

    return {
        tasksSynced,
        milestonesSynced,
        progressUpdated: oldProgress !== newProgress
    };
}

/**
 * Синхронизирует статусы goal_tasks через прямые ссылки на ticktick_task_id
 */
async function syncGoalTasksFromTickTick(goalId: number): Promise<number> {
    const tasks = await db.select()
        .from(goalTasks)
        .where(and(
            eq(goalTasks.goalId, goalId),
            isNotNull(goalTasks.ticktickTaskId)
        ));

    if (tasks.length === 0) return 0;

    let updated = 0;
    for (const task of tasks) {
        // Ищем задачу в нашем кеше TickTick
        const ttTask = await db.select()
            .from(ticktickTasks)
            .where(eq(ticktickTasks.taskId, task.ticktickTaskId!))
            .limit(1);

        if (ttTask[0]) {
            const status = ttTask[0].status === 2 ? 'done' : 'todo';
            if (status !== task.status) {
                await db.update(goalTasks)
                    .set({ 
                        status, 
                        completedAt: status === 'done' ? new Date() : null,
                        updatedAt: new Date()
                    })
                    .where(eq(goalTasks.id, task.id));
                updated++;
                
                await logGoalActivity(goalId, 'task_sync', 
                    `Статус задачи "${task.title}" обновлен из TickTick: ${status === 'done' ? '✅ Выполнено' : '⬜ В работе'}`,
                    { taskId: task.id, ttTaskId: task.ticktickTaskId }
                );
            }
        }
    }
    return updated;
}

/**
 * Синхронизирует веху по тегу из TickTick
 */
async function syncMilestoneViaTag(milestoneId: number, tag: string): Promise<boolean> {
    const cleanTag = tag.replace('#', '');
    
    // Ищем все задачи в TickTick с этим тегом
    // Используем raw SQL так как tags - это jsonb массив
    const ttTasks = await db.select()
        .from(ticktickTasks)
        .where(sql`tags @> ${JSON.stringify([cleanTag])}::jsonb`);

    if (ttTasks.length === 0) return false;

    // Считаем прогресс на основе этих задач
    const completedCount = ttTasks.filter(t => t.status === 2).length;
    const progress = Math.round((completedCount / ttTasks.length) * 100);

    const existing = await db.select().from(goalMilestones).where(eq(goalMilestones.id, milestoneId)).limit(1);
    if (!existing[0]) return false;

    const oldProgress = existing[0].progress;
    if (progress !== oldProgress) {
        await db.update(goalMilestones)
            .set({ 
                progress, 
                status: progress === 100 ? 'completed' : progress > 0 ? 'in_progress' : 'pending',
                completedAt: progress === 100 ? new Date() : null,
                updatedAt: new Date()
            })
            .where(eq(goalMilestones.id, milestoneId));
        return true;
    }
    return false;
}

// ============================================================================
// Фаза 3 — Review и коучинг: key results, activity log, merge, review
// ============================================================================

/**
 * Получение Key Results для цели
 */
export async function getKeyResultsForGoal(goalId: number): Promise<GoalKeyResult[]> {
    return db.select()
        .from(goalKeyResults)
        .where(eq(goalKeyResults.goalId, goalId))
        .orderBy(goalKeyResults.createdAt);
}

/**
 * Обновление значения Key Result
 */
export async function updateKeyResultValue(
    id: number,
    currentValue: number,
): Promise<GoalKeyResult | null> {
    // Получаем KR для проверки
    const existing = await db.select()
        .from(goalKeyResults)
        .where(eq(goalKeyResults.id, id))
        .limit(1);

    if (!existing[0]) return null;

    const kr = existing[0];
    const newStatus = (kr.targetValue && currentValue >= kr.targetValue) ? 'completed' : 'active';

    const result = await db.update(goalKeyResults)
        .set({
            currentValue,
            status: newStatus,
            updatedAt: new Date(),
        })
        .where(eq(goalKeyResults.id, id))
        .returning();

    // Логируем обновление
    if (result[0]) {
        await logGoalActivity(kr.goalId, 'progress_update',
            `Key Result "${kr.title}" обновлён: ${kr.currentValue} → ${currentValue}${kr.unit ? ' ' + kr.unit : ''}${newStatus === 'completed' ? ' ✅ Достигнут!' : ''}`,
            { keyResultId: id, oldValue: kr.currentValue, newValue: currentValue, target: kr.targetValue, completed: newStatus === 'completed' },
        );
    }

    return result[0] || null;
}

/**
 * Получение журнала активности цели
 */
export async function getGoalActivityLogEntries(
    goalId: number,
    limit: number = 20,
): Promise<GoalActivityLog[]> {
    return db.select()
        .from(goalActivityLog)
        .where(eq(goalActivityLog.goalId, goalId))
        .orderBy(desc(goalActivityLog.createdAt))
        .limit(limit);
}

/**
 * Получение целей, нуждающихся в обзоре (target_review_date <= NOW)
 */
export async function getGoalsNeedingReview(): Promise<Goal[]> {
    const now = new Date();
    return db.select()
        .from(goals)
        .where(and(
            eq(goals.status, 'active'),
            lt(goals.targetReviewDate, now),
        ))
        .orderBy(goals.targetReviewDate);
}

/**
 * Объединение двух целей: source → target
 * - Переносит milestones, tasks, key results, activity log
 * - Помечает source как abandoned
 * - Пересчитывает прогресс target
 */
export async function mergeGoals(
    sourceId: number,
    targetId: number,
    mergeDescription?: string,
): Promise<{ milestonesTransferred: number; tasksTransferred: number; keyResultsTransferred: number }> {
    const source = await getGoalById(sourceId);
    const target = await getGoalById(targetId);

    if (!source) throw new Error(`Цель-источник с ID ${sourceId} не найдена`);
    if (!target) throw new Error(`Цель-приёмник с ID ${targetId} не найдена`);

    // Определяем максимальный sort_order в target для milestones
    const targetMilestones = await getMilestonesForGoal(targetId);
    let maxSortOrder = targetMilestones.length > 0
        ? Math.max(...targetMilestones.map(m => m.sortOrder)) + 1
        : 0;

    // 1. Переносим milestones: обновляем goal_id и sort_order
    const sourceMilestones = await getMilestonesForGoal(sourceId);
    for (const milestone of sourceMilestones) {
        await db.update(goalMilestones)
            .set({ goalId: targetId, sortOrder: maxSortOrder++, updatedAt: new Date() })
            .where(eq(goalMilestones.id, milestone.id));
    }

    // 2. Переносим tasks: обновляем goal_id
    const sourceTasks = await getTasksForGoal(sourceId);
    for (const task of sourceTasks) {
        await db.update(goalTasks)
            .set({ goalId: targetId, updatedAt: new Date() })
            .where(eq(goalTasks.id, task.id));
    }

    // 3. Переносим key results
    const sourceKRs = await getKeyResultsForGoal(sourceId);
    for (const kr of sourceKRs) {
        await db.update(goalKeyResults)
            .set({ goalId: targetId, updatedAt: new Date() })
            .where(eq(goalKeyResults.id, kr.id));
    }

    // 4. Переносим activity log
    await db.update(goalActivityLog)
        .set({ goalId: targetId })
        .where(eq(goalActivityLog.goalId, sourceId));

    // 5. Помечаем source как abandoned
    await db.update(goals)
        .set({ status: 'abandoned', updatedAt: new Date() })
        .where(eq(goals.id, sourceId));

    // 6. Обновляем описание target если указано
    if (mergeDescription) {
        await db.update(goals)
            .set({ description: mergeDescription, updatedAt: new Date() })
            .where(eq(goals.id, targetId));
    }

    // 7. Логируем merge в обе цели
    await logGoalActivity(targetId, 'note',
        `🔀 Объединена с целью "${source.title}" (ID: ${sourceId})`,
        { mergedFromGoalId: sourceId, mergedFromTitle: source.title },
    );
    await logGoalActivity(sourceId, 'note',
        `🔀 Объединена в цель "${target.title}" (ID: ${targetId}). Эта цель архивирована.`,
        { mergedIntoGoalId: targetId, mergedIntoTitle: target.title },
    );

    // 8. Пересчитываем прогресс target
    await recalculateGoalProgress(targetId);

    console.log(`🔀 [GoalMerge] Цель #${sourceId} → #${targetId}: ${sourceMilestones.length} milestones, ${sourceTasks.length} tasks, ${sourceKRs.length} KRs`);

    return {
        milestonesTransferred: sourceMilestones.length,
        tasksTransferred: sourceTasks.length,
        keyResultsTransferred: sourceKRs.length,
    };
}

/**
 * Получение полной информации о цели (для review):
 * цель + milestones + tasks + key results + последние activity log
 */
export async function getFullGoalDetails(goalId: number): Promise<{
    goal: Goal;
    milestones: GoalMilestone[];
    tasks: GoalTask[];
    keyResults: GoalKeyResult[];
    recentActivity: GoalActivityLog[];
} | null> {
    const goal = await getGoalById(goalId);
    if (!goal) return null;

    const [milestones, tasks, keyResults, recentActivity] = await Promise.all([
        getMilestonesForGoal(goalId),
        getTasksForGoal(goalId),
        getKeyResultsForGoal(goalId),
        getGoalActivityLogEntries(goalId, 10),
    ]);

    return { goal, milestones, tasks, keyResults, recentActivity };
}

// ============================================================================
// Goal Pulse — агрегация данных и AI-генерация следующего шага
// ============================================================================

export interface GoalPulseData {
    goal: Goal;
    milestones: GoalMilestone[];
    tasks: GoalTask[];
    keyResults: GoalKeyResult[];
    recentActivity: GoalActivityLog[];
    relatedFacts: Array<{ id: number; similarity: number }>;
    daysSinceLastActivity: number;
    isStalled: boolean;
    ticktickTaskCount: number;
    ticktickDoneCount: number;
}

/**
 * Агрегация всех источников данных для одной цели.
 * Используется Goal Pulse и Cognitive Loop для анализа состояния цели.
 */
export async function getGoalPulseData(goalId: number): Promise<GoalPulseData | null> {
    const goal = await getGoalById(goalId);
    if (!goal) return null;

    const STALLED_DAYS = 3;

    const [milestones, tasks, keyResults, recentActivity] = await Promise.all([
        getMilestonesForGoal(goalId),
        getTasksForGoal(goalId),
        getKeyResultsForGoal(goalId),
        getGoalActivityLogEntries(goalId, 10),
    ]);

    // Семантически связанные факты
    let relatedFacts: Array<{ id: number; similarity: number }> = [];
    try {
        const { searchFactsByQuery } = await import("./embeddingService");
        relatedFacts = await searchFactsByQuery(goal.title, 5, 0.45);
    } catch {
        // Embedding сервис может быть недоступен
    }

    // Дней без активности
    let daysSinceLastActivity = 999;
    if (recentActivity.length > 0) {
        const lastActivityDate = new Date(recentActivity[0].createdAt);
        daysSinceLastActivity = Math.floor(
            (Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24)
        );
    } else if (goal.createdAt) {
        daysSinceLastActivity = Math.floor(
            (Date.now() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        );
    }

    // TickTick привязки
    let ticktickTaskCount = 0;
    let ticktickDoneCount = 0;
    try {
        const ttTasks = await db.select()
            .from(goalTasks)
            .where(and(
                eq(goalTasks.goalId, goalId),
                isNotNull(goalTasks.ticktickTaskId),
            ));
        ticktickTaskCount = ttTasks.length;
        ticktickDoneCount = ttTasks.filter(t => t.status === 'done').length;
    } catch { /* ignore */ }

    return {
        goal,
        milestones,
        tasks,
        keyResults,
        recentActivity,
        relatedFacts,
        daysSinceLastActivity,
        isStalled: daysSinceLastActivity >= STALLED_DAYS,
        ticktickTaskCount,
        ticktickDoneCount,
    };
}

/**
 * AI-генерация конкретного следующего шага для цели.
 * Вызывается когда цель «застыла» (нет активности > 3 дней).
 */
export async function suggestNextStep(goalId: number): Promise<string | null> {
    const pulseData = await getGoalPulseData(goalId);
    if (!pulseData) return null;

    const { goal, milestones, tasks, keyResults, daysSinceLastActivity } = pulseData;

    const pendingTasks = tasks.filter(t => t.status !== 'done');
    const activeKRs = keyResults.filter(kr => kr.status === 'active');

    const prompt = `Ты — коуч по достижению целей. Предложи ОДИН конкретный, измеримый следующий шаг.

ЦЕЛЬ: "${goal.title}"
${goal.description ? `Описание: ${goal.description}` : ''}
Прогресс: ${goal.progress}%
${goal.deadline ? `Дедлайн: ${new Date(goal.deadline).toLocaleDateString('ru-RU')}` : 'Без дедлайна'}
Дней без активности: ${daysSinceLastActivity}

${milestones.length > 0 ? `Вехи: ${milestones.map(m => `${m.title} [${m.status}]`).join(', ')}` : 'Вех нет'}
${pendingTasks.length > 0 ? `Незавершённые задачи: ${pendingTasks.slice(0, 5).map(t => t.title).join(', ')}` : 'Задач нет'}
${activeKRs.length > 0 ? `Активные KR: ${activeKRs.map(kr => `${kr.title}: ${kr.currentValue}/${kr.targetValue}`).join(', ')}` : ''}

ПРАВИЛА:
- Предложи ОДИН конкретный шаг, который можно сделать за 15-30 минут
- Шаг должен быть понятным и actionable
- Учитывай текущий прогресс и незавершённые задачи
- Ответь одним предложением, без маркдауна`;

    try {
        const aiConfig = await getAIClientForTask('proactive_check');
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.7, maxTokens: 150 },
            [
                { role: 'system', content: 'Ты коуч. Предлагай конкретные, маленькие шаги.' },
                { role: 'user', content: prompt },
            ]
        );

        const suggestion = result.content?.trim();
        if (!suggestion || suggestion.length < 10) return null;

        // Записываем предложение в activity log
        await logGoalActivity(goalId, 'ai_suggestion',
            `💡 Предложение: ${suggestion}`,
            { source: 'goal_pulse', daysSinceLastActivity },
        );

        return suggestion;
    } catch (error) {
        console.error(`💡 [GoalPulse] Ошибка suggestNextStep для цели #${goalId}:`, error);
        return null;
    }
}

// ============================================================================
// AutoQuery — автоматическое обновление Key Results
// ============================================================================

/**
 * Получение активных Key Results с заполненным autoQuery
 */
export async function getKeyResultsWithAutoQuery(): Promise<GoalKeyResult[]> {
    return db.select()
        .from(goalKeyResults)
        .where(and(
            eq(goalKeyResults.status, 'active'),
            isNotNull(goalKeyResults.autoQuery),
        ))
        .orderBy(goalKeyResults.goalId);
}

/**
 * Выполнение autoQuery для всех KR с заполненным auto_query.
 * Для каждого KR:
 * 1. AI интерпретирует описание autoQuery через tools
 * 2. Извлекает числовое значение из ответа
 * 3. Обновляет currentValue через updateKeyResultValue
 * 
 * Возвращает статистику выполнения.
 */
export async function executeAutoQueries(): Promise<{
    total: number;
    updated: number;
    errors: number;
    details: Array<{ krId: number; title: string; oldValue: number | null; newValue: number | null; error?: string }>;
}> {
    const keyResults = await getKeyResultsWithAutoQuery();

    if (keyResults.length === 0) {
        return { total: 0, updated: 0, errors: 0, details: [] };
    }

    console.log(`📊 [AutoQuery] Найдено ${keyResults.length} KR с autoQuery`);

    // Lazy import чтобы избежать циркулярных зависимостей
    const { executeReActLoop, resolveToolsForRequest } = await import('./tools');
    const { getAIClientForTask: getConfig } = await import('./aiConfigService');

    const tools = resolveToolsForRequest({
        agentSlug: 'proactive',
        exclude: ['delegate_task', 'schedule_task'],
    });
    const aiConfig = await getConfig('proactive_check');

    const details: Array<{ krId: number; title: string; oldValue: number | null; newValue: number | null; error?: string }> = [];
    let updated = 0;
    let errors = 0;

    for (const kr of keyResults) {
        try {
            // Получаем название цели для контекста
            const goal = await getGoalById(kr.goalId);
            const goalTitle = goal?.title || `Цель #${kr.goalId}`;

            const prompt = `Определи ТЕКУЩЕЕ числовое значение для метрики.

Цель: "${goalTitle}"
Key Result: "${kr.title}"
Метрика: ${kr.metric || kr.title}
Единица измерения: ${kr.unit || 'шт'}
Целевое значение: ${kr.targetValue}
Текущее значение (последнее): ${kr.currentValue}

Описание как получить значение:
${kr.autoQuery}

Используй доступные tools (search_facts, get_goals и др.) чтобы найти актуальные данные.
ОТВЕТЬ СТРОГО в формате JSON: {"value": <число>, "source": "откуда взял данные"}
Если не можешь определить — верни: {"value": null, "source": "не удалось определить"}`;

            const result = await executeReActLoop({
                messages: [
                    { role: 'system', content: 'Ты помощник для получения метрик. Определи текущее значение метрики, используя доступные tools. Ответь ТОЛЬКО JSON с полями value и source.' },
                    { role: 'user', content: prompt },
                ],
                tools,
                aiConfig,
                context: { sessionId: 'autoquery', messageId: 0, isSubagent: true },
                agentSlug: 'proactive',
                maxIterations: 5,
            });

            // Парсим ответ — извлекаем число
            const content = result.content?.trim() || '';
            let newValue: number | null = null;

            // Пробуем JSON
            try {
                const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                const parsed = JSON.parse(clean);
                if (parsed.value !== null && parsed.value !== undefined && !isNaN(Number(parsed.value))) {
                    newValue = Number(parsed.value);
                }
            } catch {
                // Fallback: ищем первое число в ответе
                const match = content.match(/(\d+(?:\.\d+)?)/);
                if (match) {
                    newValue = Number(match[1]);
                }
            }

            if (newValue !== null && newValue !== kr.currentValue) {
                await updateKeyResultValue(kr.id, newValue);
                details.push({ krId: kr.id, title: kr.title, oldValue: kr.currentValue, newValue });
                updated++;
                console.log(`📊 [AutoQuery] KR #${kr.id} "${kr.title}": ${kr.currentValue} → ${newValue}`);
            } else if (newValue === null) {
                details.push({ krId: kr.id, title: kr.title, oldValue: kr.currentValue, newValue: null, error: 'Не удалось извлечь значение' });
                console.log(`📊 [AutoQuery] KR #${kr.id} "${kr.title}": не удалось получить значение`);
            } else {
                // Значение не изменилось
                details.push({ krId: kr.id, title: kr.title, oldValue: kr.currentValue, newValue });
                console.log(`📊 [AutoQuery] KR #${kr.id} "${kr.title}": без изменений (${newValue})`);
            }
        } catch (error: any) {
            errors++;
            details.push({ krId: kr.id, title: kr.title, oldValue: kr.currentValue, newValue: null, error: error?.message || String(error) });
            console.error(`📊 [AutoQuery] ❌ Ошибка KR #${kr.id}:`, error?.message);
        }
    }

    console.log(`📊 [AutoQuery] Итого: ${keyResults.length} KR, ${updated} обновлено, ${errors} ошибок`);
    return { total: keyResults.length, updated, errors, details };
}
