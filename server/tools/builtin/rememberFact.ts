/**
 * Tool: remember_fact — Сохранить факт о пользователе в память
 * 
 * Делегирует к factExtractor.saveFact()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { saveFact } from '../../factExtractor';

interface RememberFactInput {
    content: string;
    category?: string;
    confidence?: string;
    source?: string;
}

export const rememberFactTool: ToolDefinition<RememberFactInput> = {
    name: 'remember_fact',
    description: `Сохранить факт о пользователе в долгосрочную память. Используй когда пользователь сообщает важную информацию о себе, бизнесе, предпочтениях, решениях — всё, что стоит запомнить на будущее. Не дублируй уже известные факты.`,
    category: 'memory',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Текст факта для запоминания',
            },
            category: {
                type: 'string',
                description: 'Категория факта (тема для группировки)',
                enum: ['personal', 'business', 'preference', 'decision', 'health', 'relationship'],
            },
            confidence: {
                type: 'string',
                description: 'Уверенность в факте (по умолчанию high)',
                enum: ['high', 'medium', 'low'],
            },
            source: {
                type: 'string',
                description: 'Источник факта (по умолчанию tool_call)',
            },
        },
        required: ['content'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Маппинг category в topic для ExtractedFact
            const topicMap: Record<string, string> = {
                personal: 'Личное',
                business: 'Бизнес',
                preference: 'Предпочтения',
                decision: 'Решения',
                health: 'Здоровье',
                relationship: 'Отношения',
            };

            const topic = input.category ? (topicMap[input.category] || 'Общее') : 'Общее';
            const confidence = input.confidence || 'high';

            const result = await saveFact(
                { topic, content: input.content, confidence: confidence as 'high' | 'medium' | 'low' },
            );

            if (!result) {
                return {
                    success: true,
                    data: { duplicate: true },
                    displayText: `Факт уже существует в памяти (дубликат): "${input.content.substring(0, 80)}..."`,
                };
            }

            return {
                success: true,
                data: { factId: result.id, topic },
                displayText: `Факт сохранён в память (тема: ${topic}): "${input.content.substring(0, 80)}"`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка сохранения факта: ${error?.message || error}`,
            };
        }
    },
};
