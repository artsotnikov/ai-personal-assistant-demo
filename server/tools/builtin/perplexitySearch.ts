/**
 * Tool: perplexity_search — Умный поиск через Perplexity Sonar API
 * 
 * Perplexity Sonar обходит сайты, собирает информацию и формирует
 * AI-ответ с цитатами. Идеально для сложных вопросов, требующих
 * анализа нескольких источников.
 * 
 * API совместим с OpenAI chat/completions.
 */

import type { ToolDefinition, ToolResult } from '../types';

interface PerplexitySearchInput {
    query: string;
    mode?: 'fast' | 'deep';
}

interface PerplexityCitation {
    url: string;
}

interface PerplexityResponse {
    choices: Array<{
        message: {
            content: string;
            role: string;
        };
        finish_reason: string;
    }>;
    citations?: string[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

export const perplexitySearchTool: ToolDefinition<PerplexitySearchInput> = {
    name: 'perplexity_search',
    description: `Умный поиск в интернете через Perplexity Sonar. В отличие от обычного поиска, Perplexity САМА обходит сайты, анализирует контент и формирует готовый ответ с цитатами.

Используй когда:
- Нужен развёрнутый ответ на сложный вопрос (не просто ссылки, а именно ответ)
- Нужно собрать информацию из нескольких источников
- Вопросы про расписания, цены, события, сравнения, обзоры
- Вопросы, требующие анализа актуальных данных из интернета

Два режима:
- mode "fast" — быстрый ответ (модель sonar). Для простых фактов.
- mode "deep" — глубокий анализ (модель sonar-pro). Для сложных вопросов, сравнений, исследований.

Примеры:
- "расписание фильма Аквамен в кинотеатрах Спб" → deep
- "курс доллара сегодня" → fast
- "сравни тарифы Мегафон и МТС" → deep
- "когда ближайший матч Зенита" → fast`,
    category: 'analytics',
    toolPack: 'web_access',
    permission: 'read',
    isReadOnly: true,
    timeout: 30_000,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Вопрос или поисковый запрос. Формулируй как вопрос на естественном языке — Perplexity лучше работает с вопросами, чем с ключевыми словами.',
            },
            mode: {
                type: 'string',
                description: 'Режим поиска: "fast" (быстрый, модель sonar) или "deep" (глубокий анализ, модель sonar-pro). По умолчанию "fast".',
                enum: ['fast', 'deep'],
            },
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        const apiKey = process.env.PERPLEXITY_API_KEY;

        if (!apiKey) {
            return {
                success: false,
                error: 'PERPLEXITY_API_KEY не настроен',
                displayText: '⚠️ Perplexity Search недоступен: не настроен API-ключ. Добавьте PERPLEXITY_API_KEY в .env',
            };
        }

        const model = input.mode === 'deep' ? 'sonar-pro' : 'sonar';
        const requestBody = JSON.stringify({
            model,
            messages: [
                {
                    role: 'system',
                    content: 'Ты — поисковый помощник. Отвечай на русском языке. Давай конкретные, структурированные ответы с фактами. Указывай источники.',
                },
                {
                    role: 'user',
                    content: input.query,
                },
            ],
            max_tokens: model === 'sonar-pro' ? 4096 : 2048,
            temperature: 0.1,
        });

        // Retry helper — один повтор через 2с при сетевой ошибке
        const fetchWithRetry = async (attempt: number): Promise<ToolResult> => {
            // Используем AbortController вместо AbortSignal.timeout() для совместимости с Node < 17.3
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25_000);

            try {
                const response = await fetch(PERPLEXITY_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: requestBody,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'unknown');
                    console.error(`[Perplexity] HTTP ${response.status}: ${errorText.substring(0, 200)}`);
                    return {
                        success: false,
                        error: `Perplexity API error: ${response.status}`,
                        displayText: response.status === 401
                            ? '❌ Perplexity: неверный API-ключ (401). Проверьте PERPLEXITY_API_KEY в .env'
                            : response.status === 429
                                ? '⏱️ Perplexity: превышен лимит запросов (429). Попробуйте через несколько секунд.'
                                : `❌ Ошибка Perplexity API (${response.status}). Попробуйте другой запрос.`,
                    };
                }

                const data: PerplexityResponse = await response.json();
                const answer = data.choices?.[0]?.message?.content;

                if (!answer) {
                    return {
                        success: true,
                        data: { query: input.query, answer: null },
                        displayText: `По запросу "${input.query}" Perplexity не смогла сформировать ответ.`,
                    };
                }

                const parts: string[] = [];
                parts.push(`🔍 Perplexity Sonar (${model}):`);
                parts.push('');
                parts.push(answer);

                if (data.citations && data.citations.length > 0) {
                    parts.push('');
                    parts.push('📎 Источники:');
                    for (let i = 0; i < data.citations.length; i++) {
                        parts.push(`  [${i + 1}] ${data.citations[i]}`);
                    }
                }

                const tokens = data.usage?.total_tokens;
                if (tokens) {
                    parts.push('');
                    parts.push(`📊 Токены: ${tokens}`);
                }

                return {
                    success: true,
                    data: {
                        query: input.query,
                        model,
                        answer,
                        citations: data.citations || [],
                        tokensUsed: tokens,
                    },
                    displayText: parts.join('\n'),
                };

            } catch (error: any) {
                clearTimeout(timeoutId);

                // Собираем полный диагноз (error.cause содержит реальную причину fetch failed)
                const cause = error?.cause;
                const causeMsg = cause instanceof Error ? cause.message : String(cause || '');
                const errorCode = error?.code || cause?.code || '';

                const diagnosis = errorCode === 'ENOTFOUND'
                    ? `DNS: не удалось разрешить api.perplexity.ai (${causeMsg})`
                    : errorCode === 'ECONNREFUSED'
                        ? `ECONNREFUSED: соединение отклонено (${causeMsg})`
                        : errorCode === 'ECONNRESET'
                            ? `ECONNRESET: соединение сброшено (${causeMsg})`
                            : errorCode === 'CERT_HAS_EXPIRED' || errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
                                ? `SSL ошибка: ${errorCode} (${causeMsg})`
                                : causeMsg
                                    ? `${error?.message} → cause: ${causeMsg}`
                                    : error?.message || String(error);

                // Abort/Timeout
                if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
                    return {
                        success: false,
                        error: 'Perplexity timeout: запрос занял больше 25 секунд',
                        displayText: '⏳ Perplexity не ответила за 25 секунд. Попробуйте упростить запрос.',
                    };
                }

                // Сетевая ошибка — retry на первой попытке
                const isNetworkError = error?.message === 'fetch failed' || errorCode === 'ECONNRESET' || errorCode === 'ENOTFOUND';
                if (isNetworkError && attempt < 2) {
                    await new Promise(res => setTimeout(res, 2000));
                    return fetchWithRetry(2);
                }

                // Финальная ошибка — diagnosis пишется в error поле (→ tool_call_logs.error)
                return {
                    success: false,
                    error: `Perplexity network error: ${diagnosis}`,
                    displayText: `❌ Ошибка Perplexity: ${diagnosis}`,
                };
            }
        };

        return fetchWithRetry(1);
    },
};
