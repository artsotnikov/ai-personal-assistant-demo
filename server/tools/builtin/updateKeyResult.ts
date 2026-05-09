/**
 * update_key_result — AI-инструмент для обновления метрики Key Result
 * 
 * Фаза 3: Review и коучинг
 */

import type { ToolDefinition, ToolResult } from '../types';
import * as goalManager from '../../goalManager';

interface UpdateKeyResultInput {
    keyResultId: number;
    currentValue: number;
}

export const updateKeyResultTool: ToolDefinition<UpdateKeyResultInput> = {
    name: 'update_key_result',
    description: 'Обновить текущее значение Key Result (метрики цели). Автоматически помечает как достигнутый если current >= target.',
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            keyResultId: {
                type: 'number',
                description: 'ID Key Result для обновления (числовой ID из БД, отображается как [KR ID: X] в деталях цели. НЕ порядковый номер!)',
            },
            currentValue: {
                type: 'number',
                description: 'Новое текущее значение метрики',
            },
        },
        required: ['keyResultId', 'currentValue'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            const updated = await goalManager.updateKeyResultValue(input.keyResultId, input.currentValue);

            if (!updated) {
                return {
                    success: false,
                    error: `Key Result с ID ${input.keyResultId} не найден`,
                    displayText: `Key Result с ID ${input.keyResultId} не найден.`,
                };
            }

            const progress = updated.targetValue
                ? Math.round(((updated.currentValue || 0) / updated.targetValue) * 100)
                : null;

            return {
                success: true,
                data: {
                    id: updated.id,
                    title: updated.title,
                    currentValue: updated.currentValue,
                    targetValue: updated.targetValue,
                    unit: updated.unit,
                    status: updated.status,
                    progress: progress !== null ? `${progress}%` : 'N/A',
                },
                displayText: updated.status === 'completed'
                    ? `🎉 Key Result "${updated.title}" достигнут!`
                    : `Key Result "${updated.title}" обновлён: ${updated.currentValue}/${updated.targetValue || '?'} ${updated.unit || ''}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                displayText: `Ошибка обновления Key Result: ${error.message}`,
            };
        }
    },
};
