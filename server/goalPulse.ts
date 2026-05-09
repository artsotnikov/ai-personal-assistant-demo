/**
 * Goal Pulse — «Пульс целей»
 * 
 * Каждая цель «живая» — ассистент периодически проверяет,
 * можно ли продвинуть цель хотя бы на шаг.
 * 
 * Используется из cognitiveLoop.ts (mode: goal_patrol)
 * для обогащения данных patrol'а.
 */

import {
    getFocusGoals,
    getGoalPulseData,
    suggestNextStep,
    logGoalActivity,
    type GoalPulseData,
} from "./goalManager";

// ============================================================================
// Типы
// ============================================================================

export interface GoalPulseResult {
    goalsChecked: number;
    stalledGoals: StalledGoalInfo[];
    suggestions: GoalSuggestion[];
    discoveries: GoalPulseDiscovery[];
    durationMs: number;
}

export interface StalledGoalInfo {
    goalId: number;
    goalTitle: string;
    daysSinceLastActivity: number;
    progress: number;
}

export interface GoalSuggestion {
    goalId: number;
    goalTitle: string;
    suggestion: string;
}

export interface GoalPulseDiscovery {
    type: 'stalled' | 'deadline_risk' | 'new_facts' | 'progress_opportunity';
    goalId: number;
    goalTitle: string;
    content: string;
    confidence: number;
}

// ============================================================================
// Конфигурация
// ============================================================================

const CONFIG = {
    /** Максимум целей для проверки за один цикл */
    maxGoalsPerPulse: 5,

    /** Дней без активности для «застывшей» цели */
    stalledDays: 3,

    /** Максимум AI-предложений за один цикл (экономия токенов) */
    maxSuggestionsPerPulse: 2,

    /** Дней до дедлайна для пометки «risk» */
    deadlineRiskDays: 7,
};

// ============================================================================
// Главная функция
// ============================================================================

/**
 * Проверка пульса всех focus-целей.
 * 
 * Для каждой focus-цели:
 * 1. Агрегирует все данные (getGoalPulseData)
 * 2. Если цель застыла → генерирует AI-предложение (suggestNextStep)
 * 3. Проверяет приближение дедлайна
 * 4. Ищет новые связанные факты
 * 
 * Результат используется cognitiveLoop для формирования discoveries.
 */
export async function runGoalPulse(): Promise<GoalPulseResult> {
    const startTime = Date.now();
    console.log('💓 [GoalPulse] Запуск проверки пульса целей...');

    const focusGoals = await getFocusGoals();
    const goalsToCheck = focusGoals.slice(0, CONFIG.maxGoalsPerPulse);

    const stalledGoals: StalledGoalInfo[] = [];
    const suggestions: GoalSuggestion[] = [];
    const discoveries: GoalPulseDiscovery[] = [];

    let suggestionsGenerated = 0;

    for (const goal of goalsToCheck) {
        try {
            const pulseData = await getGoalPulseData(goal.id);
            if (!pulseData) continue;

            // 1. Проверяем застой
            if (pulseData.isStalled) {
                stalledGoals.push({
                    goalId: goal.id,
                    goalTitle: goal.title,
                    daysSinceLastActivity: pulseData.daysSinceLastActivity,
                    progress: goal.progress,
                });

                discoveries.push({
                    type: 'stalled',
                    goalId: goal.id,
                    goalTitle: goal.title,
                    content: `Цель «${goal.title}» без активности ${pulseData.daysSinceLastActivity} дн. (прогресс: ${goal.progress}%)`,
                    confidence: 0.9,
                });

                // AI-предложение следующего шага (лимит)
                if (suggestionsGenerated < CONFIG.maxSuggestionsPerPulse) {
                    const suggestion = await suggestNextStep(goal.id);
                    if (suggestion) {
                        suggestions.push({
                            goalId: goal.id,
                            goalTitle: goal.title,
                            suggestion,
                        });
                        suggestionsGenerated++;
                    }
                }
            }

            // 2. Проверяем приближение дедлайна
            if (goal.deadline) {
                const daysUntilDeadline = Math.ceil(
                    (new Date(goal.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                );

                if (daysUntilDeadline <= CONFIG.deadlineRiskDays && daysUntilDeadline > 0 && goal.progress < 80) {
                    discoveries.push({
                        type: 'deadline_risk',
                        goalId: goal.id,
                        goalTitle: goal.title,
                        content: `Цель «${goal.title}»: ${daysUntilDeadline} дн. до дедлайна, прогресс ${goal.progress}%. Нужно ускориться!`,
                        confidence: 0.95,
                    });
                }

                if (daysUntilDeadline <= 0) {
                    discoveries.push({
                        type: 'deadline_risk',
                        goalId: goal.id,
                        goalTitle: goal.title,
                        content: `Цель «${goal.title}» ПРОСРОЧЕНА на ${Math.abs(daysUntilDeadline)} дн.! Нужно обсудить — продлить или закрыть?`,
                        confidence: 1.0,
                    });
                }
            }

            // 3. Новые факты в памяти, связанные с целью
            if (pulseData.relatedFacts.length > 0) {
                discoveries.push({
                    type: 'new_facts',
                    goalId: goal.id,
                    goalTitle: goal.title,
                    content: `Найдено ${pulseData.relatedFacts.length} факт(ов) в памяти, семантически связанных с целью «${goal.title}»`,
                    confidence: 0.6,
                });
            }

            // 4. Прогресс-возможность (есть незавершённые задачи, но цель не stalled)
            if (!pulseData.isStalled && pulseData.tasks.length > 0) {
                const pendingTasks = pulseData.tasks.filter(t => t.status !== 'done');
                const doneToday = pulseData.recentActivity.filter(a => {
                    const actDate = new Date(a.createdAt).toDateString();
                    return actDate === new Date().toDateString();
                });

                if (pendingTasks.length > 0 && doneToday.length === 0) {
                    discoveries.push({
                        type: 'progress_opportunity',
                        goalId: goal.id,
                        goalTitle: goal.title,
                        content: `Цель «${goal.title}»: ${pendingTasks.length} незавершённых задач. Сегодня ещё не было активности — самое время!`,
                        confidence: 0.5,
                    });
                }
            }
        } catch (error) {
            console.error(`💓 [GoalPulse] Ошибка проверки цели #${goal.id}:`, error);
        }
    }

    const result: GoalPulseResult = {
        goalsChecked: goalsToCheck.length,
        stalledGoals,
        suggestions,
        discoveries,
        durationMs: Date.now() - startTime,
    };

    console.log(`💓 [GoalPulse] Завершено: ${goalsToCheck.length} целей, ${stalledGoals.length} застывших, ${suggestions.length} предложений, ${discoveries.length} discoveries (${result.durationMs}ms)`);

    return result;
}

/**
 * Получить сводку pulse для инъекции в контекст агента.
 * Лёгкая функция — не вызывает AI, только данные.
 */
export async function getGoalPulseSummary(): Promise<string | null> {
    const focusGoals = await getFocusGoals();
    if (focusGoals.length === 0) return null;

    const parts: string[] = [];

    for (const goal of focusGoals.slice(0, 3)) {
        const pulseData = await getGoalPulseData(goal.id);
        if (!pulseData) continue;

        const statusEmoji = pulseData.isStalled ? '🔴' : goal.progress >= 80 ? '🟢' : '🟡';
        const deadlineInfo = goal.deadline
            ? (() => {
                const days = Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                return days <= 0 ? '(ПРОСРОЧЕНА!)' : days <= 7 ? `(${days} дн. до дедлайна)` : '';
            })()
            : '';

        parts.push(`${statusEmoji} ${goal.title}: ${goal.progress}% ${deadlineInfo}${pulseData.isStalled ? ` — нет активности ${pulseData.daysSinceLastActivity} дн.` : ''}`);
    }

    return parts.length > 0
        ? `💓 Пульс целей:\n${parts.join('\n')}`
        : null;
}
