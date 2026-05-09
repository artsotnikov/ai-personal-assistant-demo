/**
 * Tool: browser_read — Прочитать содержимое страницы из браузерной сессии
 * 
 * Извлекает текстовое содержимое, DOM-элементы или полную структуру
 * из сессии, открытой через browser_open.
 */

import type { ToolDefinition, ToolResult } from '../types';

interface BrowserReadInput {
    session_id: string;
    mode?: 'text' | 'dom' | 'elements' | 'screenshot';
    context?: string;
}

const MAX_TEXT_LENGTH = 8000;

function getScraperUrl(): string {
    return process.env.SCRAPER_SERVICE_URL || '';
}

export const browserReadTool: ToolDefinition<BrowserReadInput> = {
    name: 'browser_read',
    description: `Прочитать содержимое текущей страницы из браузерной сессии.

Требует session_id из browser_open.

Режимы (mode):
- "text" (по умолчанию) — чистый текст страницы. Лучший выбор для извлечения информации (статьи, расписания, результаты поиска).
- "dom" — структура DOM + интерактивные элементы с селекторами. Используй когда нужно понять структуру для последующих browser_act.
- "elements" — только интерактивные элементы (кнопки, ссылки, формы) с координатами. Быстрее чем dom.
- "screenshot" — скриншот страницы + интерпретация vision-моделью. Используй когда текстовое представление не даёт понимания (визуальный контент, капча, карта, проверка результата). Передай context для целевого анализа.

Используй когда:
- После browser_act нужно прочитать результаты
- Нужно перечитать содержимое после скролла
- Хочешь узнать обновлённую структуру страницы
- Нужно визуально оценить страницу (screenshot + context)`,
    category: 'analytics',
    toolPack: 'web_browser',
    permission: 'read',
    isReadOnly: true,
    timeout: 30_000,
    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'ID сессии из browser_open',
            },
            mode: {
                type: 'string',
                description: 'Режим чтения: "text" (чистый текст), "dom" (структура + элементы), "elements" (только интерактивные элементы), "screenshot" (скриншот страницы). По умолчанию "text".',
                enum: ['text', 'dom', 'elements', 'screenshot'],
            },
            context: {
                type: 'string',
                description: 'Подсказка для vision-модели: что именно искать на скриншоте. Например: "Найди расписание сеансов фильма Аквамен" или "Проверь заполнена ли форма правильно". Используется только при mode=screenshot.',
            },
        },
        required: ['session_id'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        const scraperUrl = getScraperUrl();
        if (!scraperUrl) {
            return {
                success: false,
                error: 'SCRAPER_SERVICE_URL не настроен',
                displayText: '⚠️ Browser tools недоступны: не настроен SCRAPER_SERVICE_URL в .env',
            };
        }

        const mode = input.mode || 'text';

        try {
            let endpoint: string;
            let queryParams = '';

            switch (mode) {
                case 'text':
                    endpoint = 'content';
                    queryParams = '?extract=text';
                    break;
                case 'dom':
                    endpoint = 'dom';
                    break;
                case 'elements':
                    endpoint = 'elements';
                    break;
                case 'screenshot': {
                    // Скриншот — гибридный подход:
                    // 1. Получаем base64 PNG от Scraper
                    // 2. Интерпретируем через vision-модель (vision_analysis task)
                    // 3. Возвращаем текстовое описание + base64 для vision-capable моделей
                    const screenshotRes = await fetch(
                        `${scraperUrl}/sessions/${input.session_id}/screenshot?format=base64`,
                        { signal: AbortSignal.timeout(15_000) },
                    );

                    if (screenshotRes.status === 404) {
                        return {
                            success: false,
                            error: 'Сессия не найдена или истекла',
                            displayText: `❌ Сессия ${input.session_id} не найдена или истекла. Используй browser_open для создания новой.`,
                        };
                    }

                    const screenshotData = await screenshotRes.json();
                    const base64 = screenshotData.screenshot || screenshotData.data || screenshotData.image || '';

                    if (!base64) {
                        return {
                            success: false,
                            error: 'Скриншот пуст',
                            displayText: '❌ Не удалось получить скриншот.',
                        };
                    }

                    const sizeKB = Math.round(base64.length * 0.75 / 1024);
                    const pageTitle = screenshotData.title || screenshotData.url || 'unknown';

                    // Интерпретация через vision-модель
                    let interpretation = '';
                    try {
                        const { getAIClientForTask, callWithFallback: callAI } = await import('../../aiConfigService');
                        const visionConfig = await getAIClientForTask('vision_analysis');

                        const visionMessages = [
                            {
                                role: 'system' as const,
                                content: `Ты — AI-помощник с функцией зрения. Проанализируй скриншот веб-страницы и извлеки нужную информацию.
${input.context ? `\nЗАДАЧА ПОЛЬЗОВАТЕЛЯ: ${input.context}\nСфокусируйся на поиске именно этой информации. Если она видна — извлеки её детально.` : 'Опиши основной контент: текст, элементы интерфейса, кнопки, формы.'}
Будь кратким и информативным. Ответ на русском.`,
                            },
                            {
                                role: 'user' as const,
                                content: [
                                    {
                                        type: 'text' as const, text: input.context
                                            ? `Проанализируй скриншот страницы "${pageTitle}". Задача: ${input.context}`
                                            : `Опиши что ты видишь на скриншоте страницы "${pageTitle}":`,
                                    },
                                    { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' as const } },
                                ],
                            },
                        ];

                        const visionResult = await callAI(visionConfig, visionMessages);
                        interpretation = visionResult.content || '';
                        console.log(`[browser_read] 🔍 Vision interpretation: ${interpretation.length} chars (${visionResult.tokensUsed} tokens)`);
                    } catch (visionError: any) {
                        console.warn(`[browser_read] ⚠️ Vision interpretation failed (fallback to base64 only): ${visionError?.message}`);
                    }

                    // Формируем результат
                    const parts: string[] = [
                        `📸 Скриншот: ${pageTitle} (${sizeKB}KB)`,
                    ];

                    if (interpretation) {
                        parts.push('');
                        parts.push('🔍 Vision-анализ:');
                        parts.push(interpretation);
                    } else {
                        parts.push('');
                        parts.push('⚠️ Vision-модель недоступна. Изображение прикреплено — если ты видишь картинки, опиши что изображено.');
                    }

                    return {
                        success: true,
                        data: {
                            sessionId: input.session_id,
                            url: screenshotData.url,
                            title: screenshotData.title,
                            hasVisionInterpretation: !!interpretation,
                        },
                        displayText: parts.join('\n'),
                        imageBase64: base64,
                    };
                }
                default:
                    endpoint = 'content';
                    queryParams = '?extract=text';
            }

            const res = await fetch(
                `${scraperUrl}/sessions/${input.session_id}/${endpoint}${queryParams}`,
                { signal: AbortSignal.timeout(15_000) },
            );

            if (res.status === 404) {
                return {
                    success: false,
                    error: 'Сессия не найдена или истекла',
                    displayText: `❌ Сессия ${input.session_id} не найдена или истекла. Используй browser_open для создания новой.`,
                };
            }

            const data = await res.json();

            if (data.error) {
                return {
                    success: false,
                    error: data.error,
                    displayText: `❌ Ошибка чтения: ${data.error}`,
                };
            }

            // Форматирование результата в зависимости от mode
            const parts: string[] = [];

            if (mode === 'text') {
                let content = data.content || '';
                const fullLength = content.length;
                let truncated = false;

                if (content.length > MAX_TEXT_LENGTH) {
                    content = content.slice(0, MAX_TEXT_LENGTH);
                    truncated = true;
                }

                parts.push(`📄 ${data.title || 'Без заголовка'}`);
                parts.push(`🔗 ${data.url || 'N/A'}`);
                if (truncated) {
                    parts.push(`⚠️ Текст обрезан (${MAX_TEXT_LENGTH}/${fullLength} символов)`);
                }
                parts.push('');
                parts.push(content);

                return {
                    success: true,
                    data: { url: data.url, title: data.title, contentLength: fullLength, truncated },
                    displayText: parts.join('\n'),
                };
            }

            if (mode === 'elements') {
                const elements = data.elements || [];
                parts.push(`🔘 Интерактивные элементы (${elements.length}):`);
                parts.push(`🔗 ${data.url || 'N/A'}`);
                parts.push('');

                const maxElements = 50;
                for (const el of elements.slice(0, maxElements)) {
                    let desc = `  [${el.id}] <${el.tag}>`;
                    if (el.text) desc += ` "${el.text.slice(0, 60)}"`;
                    if (el.href) desc += ` → ${el.href.slice(0, 80)}`;
                    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
                    desc += ` | ${el.selector}`;
                    parts.push(desc);
                }
                if (elements.length > maxElements) {
                    parts.push(`  ... ещё ${elements.length - maxElements}`);
                }

                return {
                    success: true,
                    data: { url: data.url, elementsCount: elements.length },
                    displayText: parts.join('\n'),
                };
            }

            // mode === 'dom' — оптимизированный вывод (экономия токенов)
            parts.push(`📄 ${data.title || 'Без заголовка'}`);
            parts.push(`🔗 ${data.url || 'N/A'}`);
            parts.push('');

            // Headings (max 8)
            if (data.structure?.headings?.length > 0) {
                parts.push('📑 Заголовки:');
                for (const h of data.structure.headings.slice(0, 8)) {
                    parts.push(`  ${'#'.repeat(h.level)} ${h.text.slice(0, 80)}`);
                }
                parts.push('');
            }

            // Forms — С СЕЛЕКТОРАМИ для каждого поля (критично для browser_act)
            if (data.structure?.forms?.length > 0) {
                parts.push('📝 Формы:');
                for (const form of data.structure.forms.slice(0, 3)) {
                    parts.push(`  ${form.method?.toUpperCase() || 'POST'}${form.action ? ` → ${form.action.slice(0, 60)}` : ''}:`);
                    for (const inp of (form.inputs || []).slice(0, 15)) {
                        const tag = inp.tag || 'input';
                        const type = inp.type || 'text';
                        const name = inp.name ? ` name="${inp.name}"` : '';
                        const placeholder = inp.placeholder ? ` placeholder="${inp.placeholder.slice(0, 40)}"` : '';
                        const id = inp.id ? ` id="${inp.id}"` : '';
                        // Построить selector: приоритет id > name > placeholder
                        const selector = inp.id ? `#${inp.id}` : (inp.name ? `${tag}[name="${inp.name}"]` : (inp.placeholder ? `${tag}[placeholder="${inp.placeholder}"]` : ''));
                        parts.push(`    ${tag}[${type}]${name}${placeholder}${id}${selector ? ` → selector: "${selector}"` : ''}`);
                    }
                }
                parts.push('');
            }

            // Elements — компактный формат (max 25)
            const maxElements = 25;
            const elements = (data.elements || []).slice(0, maxElements);
            if (elements.length > 0) {
                parts.push(`🔘 Элементы (${Math.min(elements.length, maxElements)}/${data.elements_count || elements.length}):`);
                for (const el of elements) {
                    let desc = `  [${el.id}] <${el.tag}>`;
                    if (el.text) desc += ` "${el.text.slice(0, 50)}"`;
                    if (el.href) desc += ` → ${el.href.slice(0, 60)}`;
                    // Обрезаем длинные селекторы (экономия токенов)
                    const sel = el.selector || '';
                    desc += ` | ${sel.length > 80 ? sel.slice(0, 77) + '...' : sel}`;
                    parts.push(desc);
                }
                if ((data.elements_count || 0) > maxElements) {
                    parts.push(`  ... ещё ${data.elements_count - maxElements}`);
                }
            }

            return {
                success: true,
                data: {
                    url: data.url,
                    title: data.title,
                    elementsCount: data.elements_count,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Scraper Service timeout',
                    displayText: '⏳ Чтение страницы заняло слишком много времени.',
                };
            }

            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка browser_read: ${error?.message || error}`,
            };
        }
    },
};
