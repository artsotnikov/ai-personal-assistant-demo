/**
 * Tool: update_profile — Обновить профиль пользователя
 * 
 * Делегирует к profileManager.setProfileValue()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { setProfileValue } from '../../profileManager';

interface UpdateProfileInput {
    field: string;
    value: string;
    category?: string;
}

export const updateProfileTool: ToolDefinition<UpdateProfileInput> = {
    name: 'update_profile',
    description: `Обновить профиль пользователя — сохранить или изменить важную характеристику личности. Используй когда узнаёшь новую устойчивую информацию о личности, ценностях, сильных или слабых сторонах пользователя.`,
    category: 'memory',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            field: {
                type: 'string',
                description: 'Ключ поля профиля в snake_case (склонность_к_перфекционизму, ценность_свободы, экспертиза_saas и т.д.)',
            },
            value: {
                type: 'string',
                description: 'Описание черты/характеристики, 1-2 предложения. Должно быть контекстонезависимым.',
            },
            category: {
                type: 'string',
                description: 'Категория: personality (черты), values (ценности), ambitions (долгосрочные амбиции), cognitive_patterns (стиль мышления), strengths (сильные стороны), weaknesses (слабые стороны), expertise (домены знаний), emotional_triggers (мотивация/стресс), communication (стиль общения)',
                enum: [
                    'personality', 'values', 'ambitions',
                    'cognitive_patterns', 'strengths', 'weaknesses',
                    'expertise', 'emotional_triggers', 'communication'
                ],
            },
        },
        required: ['field', 'value', 'category'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const category = (input.category || 'personality') as any;

            const result = await setProfileValue(input.field, input.value, category);

            return {
                success: true,
                data: { key: result.key, value: result.value, category: result.category },
                displayText: `Профиль обновлён: ${input.field} = "${input.value}" (категория: ${category})`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка обновления профиля: ${error?.message || error}`,
            };
        }
    },
};
