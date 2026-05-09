/**
 * Tool: create_goal — Создать цель
 * 
 * Делегирует к goalManager.createGoal()
 * Поддерживает новые поля системы «Живые цели»
 */

import type { ToolDefinition, ToolResult } from '../types';
import { createGoal } from '../../goalManager';
import { db } from '../../db';
import { goalActivityLog } from '@shared/schema';

interface CreateGoalInput {
    title: string;
    description?: string;
    smartDescription?: string;
    targetDate?: string;
    category?: 'business' | 'personal' | 'financial' | 'health';
    priority?: 'focus' | 'high' | 'medium' | 'low' | 'someday';
    reviewFrequency?: 'daily' | 'weekly' | 'monthly';
    parentGoalId?: number;
}

export const createGoalTool: ToolDefinition<CreateGoalInput> = {
    name: 'create_goal',
    description: `Создать новую цель для пользователя. Используй когда пользователь ставит цель, задачу или планирует достижение чего-либо.

После создания рекомендуется вызвать refine_goal для SMART-рефайна и декомпозиции.

Поля:
- title (обязательно): название цели
- description: подробное описание
- smartDescription: SMART-формулировка (если уже есть)
- category: business, personal, financial, health
- priority: focus (макс 3!), high, medium, low, someday
- targetDate: дедлайн в ISO 8601
- reviewFrequency: daily, weekly, monthly
- parentGoalId: ID родительской цели (если подцель)`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Название цели',
            },
            description: {
                type: 'string',
                description: 'Подробное описание цели и критерии успеха',
            },
            smartDescription: {
                type: 'string',
                description: 'SMART-формулировка цели',
            },
            targetDate: {
                type: 'string',
                description: 'Целевая дата достижения в формате ISO 8601',
            },
            category: {
                type: 'string',
                enum: ['business', 'personal', 'financial', 'health'],
                description: 'Категория цели',
            },
            priority: {
                type: 'string',
                enum: ['focus', 'high', 'medium', 'low', 'someday'],
                description: 'Приоритет (focus — максимум 3 активных!)',
            },
            reviewFrequency: {
                type: 'string',
                enum: ['daily', 'weekly', 'monthly'],
                description: 'Частота обзора',
            },
            parentGoalId: {
                type: 'number',
                description: 'ID родительской цели (если это подцель)',
            },
        },
        required: ['title'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const goal = await createGoal({
                title: input.title,
                description: input.description || null,
                smartDescription: input.smartDescription || null,
                deadline: input.targetDate ? new Date(input.targetDate) : null,
                category: input.category || null,
                priority: input.priority || 'medium',
                reviewFrequency: input.reviewFrequency || 'weekly',
                parentGoalId: input.parentGoalId || null,
                status: 'active',
                progress: 0,
            });

            // Записываем в activity log
            await db.insert(goalActivityLog).values({
                goalId: goal.id,
                activityType: 'note',
                description: `Цель создана: "${goal.title}"`,
                metadata: { source: 'create_goal_tool', category: input.category, priority: input.priority },
            });

            const details: string[] = [];
            if (input.category) details.push(`категория: ${input.category}`);
            if (input.priority) details.push(`приоритет: ${input.priority}`);
            if (input.targetDate) details.push(`дедлайн: ${new Date(input.targetDate).toLocaleDateString('ru-RU')}`);

            return {
                success: true,
                data: { id: goal.id, title: goal.title },
                displayText: `🎯 Цель создана: "${goal.title}"${details.length > 0 ? ` (${details.join(', ')})` : ''}\n\n💡 Совет: вызови refine_goal(goalId: ${goal.id}) для SMART-рефайна и декомпозиции.`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка создания цели: ${error?.message || error}`,
            };
        }
    },
};

