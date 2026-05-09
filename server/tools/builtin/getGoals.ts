/**
 * Tool: get_goals — Получить текущие цели пользователя
 * 
 * Прямой SQL через drizzle к таблице goals.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals } from '@shared/schema';
import { eq, desc } from 'drizzle-orm';

interface GetGoalsInput {
    status?: string;
    limit?: number;
}

export const getGoalsTool: ToolDefinition<GetGoalsInput> = {
    name: 'get_goals',
    description: `Получить текущие цели пользователя. Используй когда нужно узнать над чем работает пользователь, какие у него цели, их прогресс и дедлайны. Можно фильтровать по статусу.

ВАЖНО: Каждая цель имеет уникальный числовой ID (поле "id"). При любых операциях с целями (update_goal, add_milestone, refine_goal и др.) используй ИМЕННО этот ID, а НЕ порядковый номер цели в списке!`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description: 'Фильтр по статусу цели',
                enum: ['active', 'completed', 'abandoned'],
            },
            limit: {
                type: 'number',
                description: 'Максимальное количество целей (по умолчанию 10)',
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const limit = input.limit || 10;

            let query = db.select().from(goals).orderBy(desc(goals.createdAt)).limit(limit);

            let results;
            if (input.status) {
                results = await db.select().from(goals)
                    .where(eq(goals.status, input.status))
                    .orderBy(desc(goals.createdAt))
                    .limit(limit);
            } else {
                results = await query;
            }

            if (results.length === 0) {
                const statusText = input.status ? ` со статусом "${input.status}"` : '';
                return {
                    success: true,
                    data: [],
                    displayText: `Целей${statusText} не найдено.`,
                };
            }

            const goalsText = results
                .map((g) => {
                    const deadline = g.deadline
                        ? ` | дедлайн: ${g.deadline.toLocaleDateString('ru-RU')}`
                        : '';
                    const category = g.category ? ` | ${g.category}` : '';
                    const priority = g.priority ? ` | приоритет: ${g.priority}` : '';
                    return `• [ID: ${g.id}] [${g.status}] ${g.title} — прогресс: ${g.progress}%${deadline}${category}${priority}`;
                })
                .join('\n');

            return {
                success: true,
                data: results.map(g => ({
                    id: g.id,
                    title: g.title,
                    description: g.description,
                    status: g.status,
                    progress: g.progress,
                    deadline: g.deadline,
                    category: g.category,
                    priority: g.priority,
                })),
                displayText: `Найдено ${results.length} целей:\n${goalsText}\n\n⚠️ Для операций с целями используй ID из поля [ID: X], а НЕ порядковый номер!`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения целей: ${error?.message || error}`,
            };
        }
    },
};
