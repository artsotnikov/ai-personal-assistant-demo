/**
 * Tool: read_web_page — Чтение веб-страницы через Jina Reader API
 * 
 * Jina Reader (r.jina.ai) конвертирует любую веб-страницу в чистый Markdown.
 * Рендерит JavaScript, обходит anti-bot, возвращает структурированный текст.
 * 
 * Использование: просто GET https://r.jina.ai/{url}
 * Работает без ключа (с ограничениями), с ключом — выше лимиты.
 */

import type { ToolDefinition, ToolResult } from '../types';

interface ReadWebPageInput {
    url: string;
    target_selector?: string;
}

const JINA_READER_BASE = 'https://r.jina.ai/';
const MAX_CONTENT_LENGTH = 8000; // Лимит символов для AI (экономия токенов)

export const readWebPageTool: ToolDefinition<ReadWebPageInput> = {
    name: 'read_web_page',
    description: `Прочитать содержимое веб-страницы по URL. Возвращает чистый текст/Markdown страницы.

Используй когда:
- Нужно прочитать конкретную страницу, URL которой уже известен
- web_search или perplexity_search нашли ссылку, и нужно получить подробности
- Пользователь дал ссылку и просит "посмотреть что там"
- Нужно извлечь текст со страницы (статья, описание товара, расписание)

НЕ используй когда:
- URL неизвестен — сначала используй web_search или perplexity_search
- Нужно взаимодействовать со страницей (кликать, заполнять формы) — для этого есть browser_open/browser_act

Опционально можно указать target_selector (CSS) для извлечения конкретного блока страницы.`,
    category: 'analytics',
    toolPack: 'web_access',
    permission: 'read',
    isReadOnly: true,
    timeout: 40_000, // 15s (Jina) + 20s (fallback) + запас
    inputSchema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'URL веб-страницы для чтения. Должен начинаться с http:// или https://',
            },
            target_selector: {
                type: 'string',
                description: 'Опциональный CSS-селектор для извлечения конкретного блока страницы. Например: "main", "#content", ".article-body"',
            },
        },
        required: ['url'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        // Валидация URL
        let url: string;
        try {
            const parsed = new URL(input.url);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return {
                    success: false,
                    error: 'URL должен начинаться с http:// или https://',
                    displayText: '❌ Некорректный URL. Укажи полный адрес, начинающийся с http:// или https://',
                };
            }
            url = parsed.toString();
        } catch {
            return {
                success: false,
                error: `Некорректный URL: ${input.url}`,
                displayText: `❌ Не удалось распознать URL: ${input.url}`,
            };
        }

        try {
            const headers: Record<string, string> = {
                'Accept': 'text/plain',
                'x-no-cache': 'true' // Запрашиваем без кеша
            };

            // Jina API Key (опционально)
            const jinaKey = process.env.JINA_API_KEY;
            if (jinaKey) {
                headers['Authorization'] = `Bearer ${jinaKey}`;
            }

            // CSS-селектор для таргетирования
            if (input.target_selector) {
                headers['x-target-selector'] = input.target_selector;
            }

            const readerUrl = `${JINA_READER_BASE}${url}`;

            // Основной запрос к Jina AI
            const response = await fetch(readerUrl, {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(15_000), // Таймаут 15 сек на основной источник
            });

            if (!response.ok) {
                throw new Error(`Jina Reader response not ok: ${response.status}`);
            }

            let content = await response.text();

            return processContent(url, content, 'Jina AI Reader');

        } catch (error: any) {
            // Если запрос к Jina отвалился (таймаут, 429, 500 и т.д.), 
            // пробуем fallback на markdown.new
            console.log(`[readWebPage] Jina API failed or timed out: ${error?.message || error}. Trying fallback to markdown.new...`);

            try {
                // markdown.new использует префикс, а также понимает заголовок Accept: text/markdown
                const fallbackUrl = `https://markdown.new/${url}`;

                const fallbackHeaders: Record<string, string> = {
                    'Accept': 'text/markdown'
                };

                // Примечание: markdown.new не поддерживает x-target-selector.
                // При необходимости фильтрации по CSS-селектору полный маркдаун обрезается в processContent.

                const fallbackResponse = await fetch(fallbackUrl, {
                    method: 'GET',
                    headers: fallbackHeaders,
                    signal: AbortSignal.timeout(20_000) // 20 сек таймаут для фолбэка
                });

                if (!fallbackResponse.ok) {
                    return {
                        success: false,
                        error: `Fallback markdown.new failed: ${fallbackResponse.status}`,
                        displayText: `❌ Не удалось прочитать страницу ни через основной канал, ни через запасной. Возможно, сайт сильно защищен (Cloudflare, анти-бот).`,
                    };
                }

                let content = await fallbackResponse.text();
                return processContent(url, content, 'markdown.new (fallback)');

            } catch (fallbackError: any) {
                return {
                    success: false,
                    error: `Both primary and fallback failed. Fallback error: ${fallbackError?.message || String(fallbackError)}`,
                    displayText: `⏳ Страница ${url} не загрузилась. Сработали таймауты или сайт блокирует доступ.`,
                };
            }
        }
    },
};

// Вспомогательная функция для обработки ответа (проверка на пустоту, обрезка, формирование ответа)
function processContent(url: string, content: string, source: string): ToolResult {
    if (!content || content.trim().length === 0) {
        return {
            success: true,
            data: { url, content: '' },
            displayText: `📄 Страница ${url} не содержит текстового контента (прочитано через ${source}).`,
        };
    }

    // Обрезаем слишком длинный контент для экономии токенов
    const fullLength = content.length;
    let truncated = false;
    let outputContent = content;
    if (fullLength > MAX_CONTENT_LENGTH) {
        outputContent = content.slice(0, MAX_CONTENT_LENGTH);
        truncated = true;
    }

    // Формируем displayText
    const parts: string[] = [];
    parts.push(`📄 Содержимое: ${url} (via ${source})`);
    if (truncated) {
        parts.push(`⚠️ Контент обрезан (${MAX_CONTENT_LENGTH}/${fullLength} символов)`);
    }
    parts.push('');
    parts.push(outputContent);

    return {
        success: true,
        data: {
            url,
            contentLength: fullLength,
            truncated,
            content: outputContent,
            source
        },
        displayText: parts.join('\n'),
    };
}
