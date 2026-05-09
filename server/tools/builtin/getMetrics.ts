/**
 * Tool: get_metrics — Получение бизнес-метрик
 * 
 * Делегирует к metricsTracker.getLatestSnapshot() и getMetricHistory()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getLatestSnapshot, getMetricHistory, getMetricTrend } from '../../metricsTracker';

interface GetMetricsInput {
    action: 'latest' | 'history' | 'trend';
    metricKey?: string;
    limit?: number;
}

export const getMetricsTool: ToolDefinition<GetMetricsInput> = {
    name: 'get_metrics',
    description: `Получить бизнес-метрики пользователя (MRR, revenue, clients, churn и др.). Используй 'latest' для последних метрик, 'history' для истории снэпшотов, 'trend' для динамики конкретной метрики.`,
    category: 'analytics',
    toolPack: 'business_metrics',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['latest', 'history', 'trend'],
                description: 'Действие: latest (последний снэпшот), history (история), trend (динамика одной метрики)',
            },
            metricKey: {
                type: 'string',
                description: 'Ключ метрики для trend (напр. "mrr", "revenue", "clients")',
            },
            limit: {
                type: 'number',
                description: 'Количество записей для history/trend (по умолчанию 6)',
            },
        },
        required: ['action'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            switch (input.action) {
                case 'latest': {
                    const snapshot = await getLatestSnapshot();
                    if (!snapshot) {
                        return {
                            success: true,
                            data: null,
                            displayText: 'Метрики ещё не сохранены.',
                        };
                    }
                    const metrics = snapshot.metrics as Record<string, number>;
                    const metricsStr = Object.entries(metrics)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    return {
                        success: true,
                        data: { period: snapshot.period, metrics, changes: snapshot.changes },
                        displayText: `📊 Метрики за ${snapshot.period}: ${metricsStr}`,
                    };
                }

                case 'history': {
                    const history = await getMetricHistory(input.limit || 6);
                    if (history.length === 0) {
                        return { success: true, data: [], displayText: 'История метрик пуста.' };
                    }
                    const historyStr = history
                        .map(s => `${s.period}: ${Object.entries(s.metrics as Record<string, number>).map(([k, v]) => `${k}=${v}`).join(', ')}`)
                        .join('\n');
                    return {
                        success: true,
                        data: history.map(s => ({ period: s.period, metrics: s.metrics })),
                        displayText: `📈 История метрик (${history.length} записей):\n${historyStr}`,
                    };
                }

                case 'trend': {
                    if (!input.metricKey) {
                        return { success: false, error: 'metricKey обязателен для action=trend', displayText: 'Укажи metricKey для просмотра динамики.' };
                    }
                    const trend = await getMetricTrend(input.metricKey, input.limit || 6);
                    if (trend.length === 0) {
                        return { success: true, data: [], displayText: `Нет данных по метрике "${input.metricKey}".` };
                    }
                    const trendStr = trend.map(t => `${t.period}: ${t.value}`).join('\n');
                    return {
                        success: true,
                        data: trend,
                        displayText: `📉 Динамика "${input.metricKey}" (${trend.length} точек):\n${trendStr}`,
                    };
                }

                default:
                    return { success: false, error: `Неизвестный action: ${input.action}`, displayText: `Неизвестное действие: ${input.action}` };
            }
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка получения метрик: ${error?.message || error}`,
            };
        }
    },
};
