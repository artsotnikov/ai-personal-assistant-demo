/**
 * Tool: set_goal_focus — Установить/снять фокус для цели
 * 
 * Focus-система: максимум 3 цели одновременно в фокусе.
 * Цели в фокусе получают приоритет в context, proactive checks, reviews.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { getFocusGoals, logGoalActivity } from '../../goalManager';

const MAX_FOCUS_GOALS = 3;

interface SetGoalFocusInput {
    goalId: number;
    focus: boolean;
}

export const setGoalFocusTool: ToolDefinition<SetGoalFocusInput> = {
    name: 'set_goal_focus',
    description: `Установить или снять фокус для цели. Максимум ${MAX_FOCUS_GOALS} цели в фокусе одновременно.

Цели в фокусе:
- Показываются первыми в контексте AI
- Получают приоритет в проактивных проверках
- Включаются в weekly review

При снятии фокуса priority меняется на 'high'.`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
            focus: {
                type: 'boolean',
                description: 'true — поставить в фокус, false — снять',
            },
        },
        required: ['goalId', 'focus'],
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

            if (input.focus) {
                // Ставим в фокус — проверяем лимит
                const currentFocus = await getFocusGoals();

                // Если уже в фокусе — ничего не делаем
                if (currentFocus.some(g => g.id === input.goalId)) {
                    return {
                        success: true,
                        data: { goalId: input.goalId, focus: true },
                        displayText: `Цель "${goal.title}" уже в фокусе.`,
                    };
                }

                // Проверяем лимит
                if (currentFocus.length >= MAX_FOCUS_GOALS) {
                    const focusList = currentFocus
                        .map(g => `  • "${g.title}" (ID: ${g.id})`)
                        .join('\n');
                    return {
                        success: false,
                        error: `Лимит фокуса (${MAX_FOCUS_GOALS}) достигнут`,
                        displayText: `⚠️ Лимит фокуса: максимум ${MAX_FOCUS_GOALS} цели.\n\nСейчас в фокусе:\n${focusList}\n\nСначала сними фокус с одной из них (set_goal_focus goalId=X, focus=false).`,
                    };
                }

                // Ставим фокус
                await db.update(goals)
                    .set({ priority: 'focus', updatedAt: new Date() })
                    .where(eq(goals.id, input.goalId));

                await logGoalActivity(input.goalId, 'note',
                    `🎯 Цель поставлена в фокус (${currentFocus.length + 1}/${MAX_FOCUS_GOALS})`,
                    { previousPriority: goal.priority },
                    ctx.messageId,
                );

                return {
                    success: true,
                    data: { goalId: input.goalId, focus: true, focusCount: currentFocus.length + 1 },
                    displayText: `🎯 Цель "${goal.title}" поставлена в фокус (${currentFocus.length + 1}/${MAX_FOCUS_GOALS}).`,
                };
            } else {
                // Снимаем фокус
                if (goal.priority !== 'focus') {
                    return {
                        success: true,
                        data: { goalId: input.goalId, focus: false },
                        displayText: `Цель "${goal.title}" не была в фокусе (priority: ${goal.priority}).`,
                    };
                }

                await db.update(goals)
                    .set({ priority: 'high', updatedAt: new Date() })
                    .where(eq(goals.id, input.goalId));

                const remainingFocus = await getFocusGoals();

                await logGoalActivity(input.goalId, 'note',
                    `Фокус снят, priority → high (осталось в фокусе: ${remainingFocus.length}/${MAX_FOCUS_GOALS})`,
                    { newPriority: 'high' },
                    ctx.messageId,
                );

                return {
                    success: true,
                    data: { goalId: input.goalId, focus: false, focusCount: remainingFocus.length },
                    displayText: `Фокус снят с цели "${goal.title}" (priority → high). В фокусе: ${remainingFocus.length}/${MAX_FOCUS_GOALS}.`,
                };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка изменения фокуса: ${error?.message || error}`,
            };
        }
    },
};
