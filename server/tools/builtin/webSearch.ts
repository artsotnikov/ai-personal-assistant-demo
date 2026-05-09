/**
 * Tool: web_search — Поиск информации в интернете через Tavily API
 * 
 * Два режима:
 * - basic (1 кредит) — быстрый поиск фактов, дат, определений
 * - advanced (2 кредита) — глубокий поиск с извлечением контента страниц
 * 
 * Tavily специально создан для AI-агентов:
 * - Заходит на сайты и извлекает чистый контент
 * - AI-ранжирование по релевантности
 * - Возвращает готовый answer + source results
 */

import type { ToolDefinition, ToolResult } from '../types';

interface WebSearchInput {
    query: string;
    search_depth?: 'basic' | 'advanced';
    max_results?: number;
    include_answer?: boolean;
}

interface TavilyResult {
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
}

interface TavilyResponse {
    answer?: string;
    results: TavilyResult[];
    query: string;
    response_time: number;
}

const TAVILY_API_URL = 'https://api.tavily.com/search';

export const webSearchTool: ToolDefinition<WebSearchInput> = {
    name: 'web_search',
    description: `Поиск актуальной информации в интернете. Используй когда нужны данные, которых нет в памяти — текущие цены, даты событий, новости, факты, сравнения, статистика.

Два режима:
- search_depth "basic" — быстрый поиск фактов (по умолчанию). Для простых вопросов: даты, определения, короткие факты.
- search_depth "advanced" — глубокий поиск с извлечением контента страниц. Для цен, аналитики, сравнений, когда нужна детальная информация.

Примеры использования:
- "средняя цена Skoda Octavia 2024" → advanced
- "когда вышел iPhone 16" → basic
- "курс доллара сегодня" → basic
- "сравнение тарифов CRM систем" → advanced`,
    category: 'analytics',
    toolPack: 'web_access',
    permission: 'read',
    isReadOnly: true,
    timeout: 15_000,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос на русском или английском языке. Формулируй конкретно и чётко.',
            },
            search_depth: {
                type: 'string',
                description: 'Глубина поиска: "basic" (быстрый, 1 кредит — только для простейших фактов) или "advanced" (глубокий с извлечением контента страниц, 2 кредита). По умолчанию "advanced".',
                enum: ['basic', 'advanced'],
            },
            max_results: {
                type: 'number',
                description: 'Максимальное количество результатов (1-10, по умолчанию 5)',
            },
            include_answer: {
                type: 'string',
                description: 'Запросить готовый AI-ответ от поисковой системы. По умолчанию true.',
                default: true,
            },
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        const apiKey = process.env.TAVILY_API_KEY;

        if (!apiKey) {
            return {
                success: false,
                error: 'TAVILY_API_KEY не настроен',
                displayText: '⚠️ Веб-поиск недоступен: не настроен API-ключ Tavily. Добавьте TAVILY_API_KEY в .env',
            };
        }

        try {
            const searchDepth = input.search_depth || 'advanced';
            const maxResults = Math.min(Math.max(input.max_results || 5, 1), 10);
            const includeAnswer = input.include_answer !== false;

            const response = await fetch(TAVILY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: apiKey,
                    query: input.query,
                    search_depth: searchDepth,
                    max_results: maxResults,
                    include_answer: includeAnswer,
                    include_raw_content: false,
                }),
                signal: AbortSignal.timeout(12_000),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'unknown');
                return {
                    success: false,
                    error: `Tavily API error: ${response.status} ${errorText}`,
                    displayText: `❌ Ошибка веб-поиска (${response.status}). Попробуйте другой запрос.`,
                };
            }

            const data: TavilyResponse = await response.json();

            if (!data.results || data.results.length === 0) {
                return {
                    success: true,
                    data: { query: input.query, results: [] },
                    displayText: `По запросу "${input.query}" ничего не найдено в интернете.`,
                };
            }

            // Формируем displayText для AI
            const parts: string[] = [];

            if (data.answer) {
                parts.push(`📋 Краткий ответ: ${data.answer}`);
                parts.push('');
            }

            parts.push(`🔎 Результаты поиска (${data.results.length}, режим: ${searchDepth}):`);

            for (let i = 0; i < data.results.length; i++) {
                const r = data.results[i];
                const score = Math.round(r.score * 100);
                const date = r.published_date ? ` | ${r.published_date}` : '';
                parts.push(`${i + 1}. [${r.title}](${r.url}) (релевантность: ${score}%${date})`);

                // Контент — ограничиваем длину для экономии токенов
                const contentPreview = r.content.length > 500
                    ? r.content.slice(0, 500) + '...'
                    : r.content;
                parts.push(`   ${contentPreview}`);
                parts.push('');
            }

            parts.push(`⏱️ Время поиска: ${data.response_time.toFixed(1)}с`);

            return {
                success: true,
                data: {
                    query: input.query,
                    answer: data.answer,
                    results: data.results.map(r => ({
                        title: r.title,
                        url: r.url,
                        content: r.content,
                        score: r.score,
                        published_date: r.published_date,
                    })),
                    responseTime: data.response_time,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            // Таймаут
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Tavily API timeout',
                    displayText: '⏳ Веб-поиск занял слишком много времени. Попробуйте упростить запрос.',
                };
            }

            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка веб-поиска: ${error?.message || error}`,
            };
        }
    },
};
