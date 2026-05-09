/**
 * Tool: add_milestone — Добавить веху (milestone) к цели
 * 
 * Позволяет добавить веху с опциональным набором задач.
 * Автоматически определяет sortOrder и пересчитывает прогресс.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals, goalMilestones, goalTasks } from '@shared/schema';
import { eq, desc } from 'drizzle-orm';
import { recalculateGoalProgress, logGoalActivity } from '../../goalManager';

interface TaskInput {
    title: string;
    description?: string;
    dueDate?: string;
    priority?: 'high' | 'medium' | 'low';
}

interface AddMilestoneInput {
    goalId: number;
    title: string;
    description?: string;
    deadline?: string;
    weight?: number;
    tasks?: TaskInput[];
}

export const addMilestoneTool: ToolDefinition<AddMilestoneInput> = {
    name: 'add_milestone',
    description: `Добавить веху (milestone) к цели с опциональным набором задач.

Веха — это крупный этап на пути к цели. Внутри вехи — конкретные задачи (tasks).
Прогресс цели автоматически пересчитывается по завершённым задачам.

Пример: Цель "Запустить SaaS" → Веха "MVP" → Задачи: ["Выбрать стек", "Создать landing", "Настроить оплату"]`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели, к которой добавляется веха (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
            title: {
                type: 'string',
                description: 'Название вехи',
            },
            description: {
                type: 'string',
                description: 'Описание вехи',
            },
            deadline: {
                type: 'string',
                description: 'Дедлайн вехи в ISO 8601',
            },
            weight: {
                type: 'number',
                description: 'Вес вехи для расчёта прогресса (1-10, по умолчанию 1). Больше вес = больше влияние на общий прогресс цели.',
            },
            tasks: {
                type: 'array',
                description: 'Массив задач внутри вехи',
                items: {
                    type: 'object',
                },
            },
        },
        required: ['goalId', 'title'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            // 1. Проверяем существование цели
            const existing = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);
            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `Цель с ID ${input.goalId} не найдена.`,
                };
            }

            const goal = existing[0];

            // 2. Определяем sortOrder (max+1)
            const existingMilestones = await db.select({ sortOrder: goalMilestones.sortOrder })
                .from(goalMilestones)
                .where(eq(goalMilestones.goalId, input.goalId))
                .orderBy(desc(goalMilestones.sortOrder))
                .limit(1);
            const nextOrder = existingMilestones.length > 0 ? existingMilestones[0].sortOrder + 1 : 0;

            // 3. Создаём milestone
            // Валидация weight (1-10)
            const weight = input.weight ? Math.max(1, Math.min(10, Math.round(input.weight))) : 1;

            const milestoneResult = await db.insert(goalMilestones).values({
                goalId: input.goalId,
                title: input.title,
                description: input.description || null,
                deadline: input.deadline ? new Date(input.deadline) : null,
                sortOrder: nextOrder,
                weight,
                status: 'pending',
            }).returning();

            const milestone = milestoneResult[0];

            // 4. Создаём задачи если переданы
            let tasksCreated = 0;
            if (input.tasks && input.tasks.length > 0) {
                const taskValues = input.tasks.map((t, idx) => ({
                    milestoneId: milestone.id,
                    goalId: input.goalId,
                    title: t.title,
                    description: t.description || null,
                    dueDate: t.dueDate ? new Date(t.dueDate) : null,
                    priority: t.priority || 'medium',
                    sortOrder: idx,
                    status: 'todo' as const,
                }));

                await db.insert(goalTasks).values(taskValues);
                tasksCreated = taskValues.length;
            }

            // 5. Пересчитываем прогресс
            await recalculateGoalProgress(input.goalId);

            // 6. Activity log
            await logGoalActivity(input.goalId, 'note',
                `Добавлена веха: "${input.title}" (${tasksCreated} задач)`,
                { milestoneId: milestone.id, tasksCreated },
                ctx.messageId,
            );

            // 7. Формируем ответ
            const parts: string[] = [
                `📦 Веха "${input.title}" добавлена к цели "${goal.title}"`,
            ];
            if (tasksCreated > 0) {
                parts.push(`📋 Создано ${tasksCreated} задач`);
            }
            if (input.deadline) {
                parts.push(`📅 Дедлайн: ${new Date(input.deadline).toLocaleDateString('ru-RU')}`);
            }

            return {
                success: true,
                data: {
                    milestoneId: milestone.id,
                    goalId: input.goalId,
                    tasksCreated,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка добавления вехи: ${error?.message || error}`,
            };
        }
    },
};
