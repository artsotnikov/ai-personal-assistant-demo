/**
 * merge_goals — AI-инструмент для объединения дублирующихся целей
 * 
 * Фаза 3: Review и коучинг
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as goalManager from '../../goalManager';

interface MergeGoalsInput {
    sourceGoalId: number;
    targetGoalId: number;
    mergeDescription?: string;
}

export const mergeGoalsTool: ToolDefinition<MergeGoalsInput> = {
    name: 'merge_goals',
    description: 'Объединить две дублирующиеся цели. Переносит все milestones, tasks, key results и activity log из source в target. Source-цель архивируется.',
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            sourceGoalId: {
                type: 'number',
                description: 'ID цели-источника (числовой ID из БД, [ID: X]. НЕ порядковый номер! Будет архивирована после объединения)',
            },
            targetGoalId: {
                type: 'number',
                description: 'ID цели-приëмника (числовой ID из БД, [ID: X]. НЕ порядковый номер! Получит все данные из source)',
            },
            mergeDescription: {
                type: 'string',
                description: 'Новое описание для объединённой цели (опционально)',
            },
        },
        required: ['sourceGoalId', 'targetGoalId'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        if (input.sourceGoalId === input.targetGoalId) {
            return {
                success: false,
                error: 'Нельзя объединить цель саму с собой',
                displayText: 'Ошибка: нельзя объединить цель саму с собой.',
            };
        }

        try {
            const source = await goalManager.getGoalById(input.sourceGoalId);
            const target = await goalManager.getGoalById(input.targetGoalId);

            if (!source) {
                return { success: false, error: `Цель-источник с ID ${input.sourceGoalId} не найдена`, displayText: `Цель с ID ${input.sourceGoalId} не найдена.` };
            }
            if (!target) {
                return { success: false, error: `Цель-приёмник с ID ${input.targetGoalId} не найдена`, displayText: `Цель с ID ${input.targetGoalId} не найдена.` };
            }

            const result = await goalManager.mergeGoals(input.sourceGoalId, input.targetGoalId, input.mergeDescription);

            return {
                success: true,
                data: {
                    sourceGoal: { id: input.sourceGoalId, title: source.title, newStatus: 'abandoned' },
                    targetGoal: { id: input.targetGoalId, title: target.title },
                    transferred: result,
                },
                displayText: `🔀 Цели объединены: "${source.title}" → "${target.title}". Перенесено: ${result.milestonesTransferred} milestones, ${result.tasksTransferred} tasks, ${result.keyResultsTransferred} KR.`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                displayText: `Ошибка объединения целей: ${error.message}`,
            };
        }
    },
};
