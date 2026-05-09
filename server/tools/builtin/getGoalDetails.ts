/**
 * Tool: get_goal_details — Полная иерархия одной цели
 * 
 * Делегирует к goalManager.getFullGoalDetails()
 * Возвращает: цель + milestones + tasks + key results + activity log
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getFullGoalDetails } from '../../goalManager';

interface GetGoalDetailsInput {
    goalId: number;
}

export const getGoalDetailsTool: ToolDefinition<GetGoalDetailsInput> = {
    name: 'get_goal_details',
    description: `Получить полную иерархию одной цели: саму цель, milestones, tasks, key results и последние записи activity log.
Используй когда нужно глубоко проанализировать конкретную цель, подготовить review, или понять текущий прогресс с разбивкой по вехам и задачам.

Параметры:
- goalId (обязательно): ID цели`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели для получения полной информации (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
        },
        required: ['goalId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const details = await getFullGoalDetails(input.goalId);

            if (!details) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `❌ Цель с ID ${input.goalId} не найдена`,
                };
            }

            const { goal, milestones, tasks, keyResults, recentActivity } = details;

            // Форматируем displayText
            const parts: string[] = [];

            // Основная информация
            const deadline = goal.deadline
                ? ` | дедлайн: ${goal.deadline.toLocaleDateString('ru-RU')}`
                : '';
            parts.push(`🎯 [ID: ${goal.id}] **${goal.title}** [${goal.status}] — ${goal.progress}%${deadline}`);
            if (goal.description) parts.push(`📝 ${goal.description}`);
            if (goal.smartDescription) parts.push(`🧠 SMART: ${goal.smartDescription}`);
            if (goal.category) parts.push(`📂 Категория: ${goal.category} | Приоритет: ${goal.priority}`);

            // Milestones и tasks
            if (milestones.length > 0) {
                parts.push(`\n📌 **Вехи (${milestones.length}):**`);
                for (const m of milestones) {
                    const mTasks = tasks.filter(t => t.milestoneId === m.id);
                    const doneTasks = mTasks.filter(t => t.status === 'done').length;
                    parts.push(`  • [milestone ID: ${m.id}] [${m.status}] ${m.title} (${doneTasks}/${mTasks.length} задач)`);
                    for (const t of mTasks) {
                        const icon = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
                        parts.push(`    ${icon} [task ID: ${t.id}] ${t.title}`);
                    }
                }
            }

            // Задачи без milestone
            const orphanTasks = tasks.filter(t => !t.milestoneId);
            if (orphanTasks.length > 0) {
                parts.push(`\n📋 **Задачи без вехи (${orphanTasks.length}):**`);
                for (const t of orphanTasks) {
                    const icon = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
                    parts.push(`  ${icon} [task ID: ${t.id}] ${t.title}`);
                }
            }

            // Key Results
            if (keyResults.length > 0) {
                parts.push(`\n📊 **Key Results (${keyResults.length}):**`);
                for (const kr of keyResults) {
                    const unit = kr.unit || '';
                    const progress = kr.targetValue
                        ? ` (${kr.currentValue}/${kr.targetValue} ${unit})`
                        : ` (${kr.currentValue} ${unit})`;
                    parts.push(`  • [KR ID: ${kr.id}] [${kr.status}] ${kr.title}${progress}`);
                }
            }

            // Activity log
            if (recentActivity.length > 0) {
                parts.push(`\n📜 **Последняя активность (${recentActivity.length}):**`);
                for (const a of recentActivity.slice(0, 5)) {
                    const date = a.createdAt.toLocaleDateString('ru-RU');
                    parts.push(`  • ${date}: ${a.description}`);
                }
            }

            return {
                success: true,
                data: details,
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения деталей цели: ${error?.message || error}`,
            };
        }
    },
};
