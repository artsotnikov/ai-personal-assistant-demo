/**
 * Tool: create_reminder — Создать напоминание
 * 
 * Делегирует к reminderService.createReminder()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { createReminder } from '../../reminderService';

interface CreateReminderInput {
    title: string;
    remindAt: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high';
}

export const createReminderTool: ToolDefinition<CreateReminderInput> = {
    name: 'create_reminder',
    description: `Создать напоминание на определённое время. Используй когда пользователь просит напомнить о чём-либо. Время указывай в ISO 8601 формате с таймзоной +03:00 (Москва).`,
    category: 'planning',
    toolPack: 'scheduling',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Краткое описание — что напомнить',
            },
            remindAt: {
                type: 'string',
                description: 'Когда напомнить в формате ISO 8601, например "2026-02-15T10:00:00+03:00"',
            },
            description: {
                type: 'string',
                description: 'Дополнительные детали (опционально)',
            },
            priority: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Приоритет напоминания',
            },
        },
        required: ['title', 'remindAt'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const remindAt = new Date(input.remindAt);
            if (isNaN(remindAt.getTime())) {
                return {
                    success: false,
                    error: `Невалидная дата: ${input.remindAt}`,
                    displayText: `Ошибка: невалидная дата "${input.remindAt}". Используй ISO 8601 формат.`,
                };
            }

            const reminder = await createReminder({
                title: input.title,
                description: input.description || null,
                remindAt,
                status: 'pending',
                priority: input.priority || 'medium',
                sourceMessageId: _ctx.messageId || null,
            });

            return {
                success: true,
                data: { id: reminder.id, title: reminder.title, remindAt: reminder.remindAt },
                displayText: `✅ Напоминание создано: "${reminder.title}" на ${remindAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (MSK)`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка создания напоминания: ${error?.message || error}`,
            };
        }
    },
};
