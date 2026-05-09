/**
 * review_goals — AI-инструмент для обзора целей с коучинговыми вопросами
 * 
 * Фаза 3: Review и коучинг
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as goalManager from '../../goalManager';
import { db } from '../../db';
import { goals } from '@shared/schema';
import { eq } from 'drizzle-orm';

interface ReviewGoalsInput {
    scope?: 'focus' | 'all' | 'stalled';
}

/**
 * Вспомогательная функция: формирует предупреждение о дедлайне
 */
function getDeadlineWarning(deadline: Date): string | null {
    const now = new Date();
    const diffMs = new Date(deadline).getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
        return `🔴 Просрочено на ${Math.abs(diffDays)} дн.!`;
    } else if (diffDays === 0) {
        return `🔴 Дедлайн СЕГОДНЯ!`;
    } else if (diffDays <= 3) {
        return `⚠️ Осталось ${diffDays} дн.!`;
    } else if (diffDays <= 7) {
        return `🟡 Осталось ${diffDays} дн.`;
    }
    return null;
}

export const reviewGoalsTool: ToolDefinition<ReviewGoalsInput> = {
    name: 'review_goals',
    description: 'Провести обзор целей с коучинговым анализом. Анализирует прогресс, блокеры и предлагает следующие шаги. Используй для еженедельного review или когда пользователь спрашивает о прогрессе целей.',
    category: 'planning',
    toolPack: 'goals',
    permission: 'read',
    inputSchema: {
        type: 'object',
        properties: {
            scope: {
                type: 'string',
                enum: ['focus', 'all', 'stalled'],
                description: 'Какие цели обозревать: focus (только в фокусе, max 3), all (все активные), stalled (застрявшие без прогресса)',
            },
        },
        required: [],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        const scope = input.scope || 'focus';

        try {
            // 1. Получаем цели по scope
            let goalsToReview: Awaited<ReturnType<typeof goalManager.getAllGoals>>;

            if (scope === 'focus') {
                goalsToReview = await goalManager.getFocusGoals();
                // Если нет фокус-целей, берём первые 3 активные
                if (goalsToReview.length === 0) {
                    const active = await goalManager.getActiveGoals();
                    goalsToReview = active.slice(0, 3);
                }
            } else if (scope === 'stalled') {
                // Цели без прогресса более 14 дней
                const active = await goalManager.getActiveGoals();
                const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                goalsToReview = active.filter(g =>
                    g.progress === 0 && new Date(g.createdAt).getTime() < fourteenDaysAgo
                );
            } else {
                goalsToReview = await goalManager.getActiveGoals();
            }

            if (goalsToReview.length === 0) {
                return {
                    success: true,
                    data: { goalsReviewed: 0 },
                    displayText: 'Нет целей для обзора.',
                };
            }

            // 2. Собираем полные данные по каждой цели
            const reviewData: any[] = [];

            for (const goal of goalsToReview) {
                const details = await goalManager.getFullGoalDetails(goal.id);
                if (!details) continue;

                const { milestones, tasks, keyResults, recentActivity } = details;

                const totalTasks = tasks.length;
                const doneTasks = tasks.filter(t => t.status === 'done').length;
                const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
                const todoTasks = tasks.filter(t => t.status === 'todo').length;

                const krSummary = keyResults.map(kr => ({
                    title: kr.title,
                    progress: kr.targetValue ? `${kr.currentValue}/${kr.targetValue} ${kr.unit || ''}` : `${kr.currentValue} ${kr.unit || ''}`,
                    percent: kr.targetValue ? Math.round(((kr.currentValue || 0) / kr.targetValue) * 100) : null,
                    status: kr.status,
                }));

                const lastActivity = recentActivity[0];
                const daysSinceActivity = lastActivity
                    ? Math.floor((Date.now() - new Date(lastActivity.createdAt).getTime()) / (1000 * 60 * 60 * 24))
                    : Math.floor((Date.now() - new Date(goal.createdAt).getTime()) / (1000 * 60 * 60 * 24));

                // Дедлайн-предупреждения для цели и milestones
                const deadlineWarning = goal.deadline
                    ? getDeadlineWarning(goal.deadline)
                    : null;

                const milestoneDeadlineWarnings = milestones
                    .filter(m => m.deadline && m.status !== 'completed')
                    .map(m => ({ title: m.title, warning: getDeadlineWarning(m.deadline!) }))
                    .filter(w => w.warning !== null);

                reviewData.push({
                    id: goal.id,
                    title: goal.title,
                    description: goal.description,
                    smartDescription: goal.smartDescription,
                    category: goal.category,
                    priority: goal.priority,
                    progress: goal.progress,
                    deadline: goal.deadline,
                    deadlineWarning,
                    milestones: milestones.map(m => ({
                        title: m.title,
                        status: m.status,
                        deadline: m.deadline,
                        weight: m.weight,
                    })),
                    milestoneDeadlineWarnings: milestoneDeadlineWarnings.length > 0 ? milestoneDeadlineWarnings : undefined,
                    tasks: { total: totalTasks, done: doneTasks, inProgress: inProgressTasks, todo: todoTasks },
                    keyResults: krSummary,
                    daysSinceActivity,
                    recentActivity: recentActivity.slice(0, 3).map(a => ({
                        type: a.activityType,
                        description: a.description,
                        date: a.createdAt,
                    })),
                });

                // 3. Обновляем target_review_date — следующий обзор через неделю
                const nextReview = new Date();
                nextReview.setDate(nextReview.getDate() + 7);
                await db.update(goals)
                    .set({ targetReviewDate: nextReview, updatedAt: new Date() })
                    .where(eq(goals.id, goal.id));

                // 4. Логируем review в activity log
                await goalManager.logGoalActivity(goal.id, 'review',
                    `Обзор цели проведён. Прогресс: ${goal.progress}%, задач: ${doneTasks}/${totalTasks} завершено.`,
                    { scope, tasksCompleted: doneTasks, totalTasks, daysSinceActivity },
                );
            }

            // Формируем дедлайн-секцию для coaching context
            const goalsWithDeadlineWarnings = reviewData.filter(g => g.deadlineWarning);
            const deadlineCoachingNote = goalsWithDeadlineWarnings.length > 0
                ? `\n\n⚠️ ВНИМАНИЕ: ${goalsWithDeadlineWarnings.length} целей с приближающимися/просроченными дедлайнами! Обрати на них особое внимание и предложи конкретные шаги для ускорения.`
                : '';

            return {
                success: true,
                data: {
                    scope,
                    goalsReviewed: reviewData.length,
                    reviewData,
                    coachingContext: `Проанализируй каждую цель и задай 1-2 коучинговых вопроса: «Что мешает продвижению?», «Какой один шаг можно сделать сегодня?», «Нужно ли пересмотреть приоритеты?». Обрати внимание на поля deadlineWarning и milestoneDeadlineWarnings — если они заполнены, обязательно предупреди пользователя о приближающихся сроках.${deadlineCoachingNote}`,
                },
                displayText: `Обзор ${reviewData.length} целей завершён (scope: ${scope}).`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                displayText: `Ошибка обзора целей: ${error.message}`,
            };
        }
    },
};
