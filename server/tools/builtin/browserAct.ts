/**
 * Tool: browser_act — Выполнить действия на странице в удалённом браузере
 * 
 * Принимает sessionId (от browser_open) и массив действий.
 * Использует batch API Scraper Service для эффективного выполнения.
 * После действий автоматически извлекает обновлённый DOM.
 * 
 * Уровень 1: Автоскриншот + vision-диагностика при ошибке
 * Уровень 3: Поддержка evaluate (JS), navigate, координатного клика
 * Уровень 4: Middleware auto-recovery (Escape + ретрай)
 */

import type { ToolDefinition, ToolResult } from '../types';

interface BrowserAction {
    type: 'click' | 'type' | 'scroll' | 'press' | 'wait' | 'hover' | 'select' | 'evaluate' | 'navigate';
    selector?: string;
    value?: string;
    key?: string;
    x?: number;
    y?: number;
    ms?: number;
    script?: string;
    url?: string;
}

interface BrowserActInput {
    session_id: string;
    actions: BrowserAction[];
}

function getScraperUrl(): string {
    return process.env.SCRAPER_SERVICE_URL || '';
}

// ─── Уровень 1: Автоскриншот + vision-диагностика при ошибке ───

async function captureScreenshot(scraperUrl: string, sessionId: string): Promise<string | null> {
    try {
        const res = await fetch(
            `${scraperUrl}/sessions/${sessionId}/screenshot?format=base64`,
            { signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.screenshot || data.data || data.image || null;
    } catch {
        return null;
    }
}

async function visionDiagnose(
    screenshot: string,
    failedAction: BrowserAction,
    errorText: string,
): Promise<string> {
    try {
        const { getAIClientForTask, callWithFallback: callAI } = await import('../../aiConfigService');
        const visionConfig = await getAIClientForTask('vision_analysis');

        const actionDesc = failedAction.selector
            ? `${failedAction.type} на "${failedAction.selector}"`
            : `${failedAction.type} (x:${failedAction.x}, y:${failedAction.y})`;

        const messages = [
            {
                role: 'system' as const,
                content: `Ты — AI-помощник, анализирующий скриншот веб-страницы после неудачного действия браузера.
Действие: ${actionDesc}
Ошибка: ${errorText}

Проанализируй скриншот и ответь КРАТКО:
1. Что видно на странице? Есть ли баннеры, оверлеи, модальные окна поверх контента?
2. Видна ли целевая кнопка/элемент? Если да — укажи примерные координаты (x, y) в пикселях.
3. Что мешает клику? Перехватывает ли что-то pointer events?
Ответ на русском, компактно.`,
            },
            {
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: `Скриншот после ошибки "${errorText}":` },
                    { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${screenshot}`, detail: 'low' as const } },
                ],
            },
        ];

        const result = await callAI(visionConfig, messages);
        console.log(`[browser_act] 🔍 Vision diagnosis: ${result.content?.length || 0} chars (${result.tokensUsed} tokens)`);
        return result.content || 'Vision-модель не вернула ответ';
    } catch (err: any) {
        console.warn(`[browser_act] ⚠️ Vision diagnosis failed: ${err?.message}`);
        return 'Vision-модель недоступна. Скриншот приложен — изучите визуально.';
    }
}

// ─── Уровень 4: Middleware auto-recovery ───

interface RecoveryResult {
    recovered: boolean;
    screenshot: string | null;
    diagnosis: string;
    retryData?: any;
}

async function attemptAutoRecovery(
    scraperUrl: string,
    sessionId: string,
    failedAction: BrowserAction,
    errorText: string,
): Promise<RecoveryResult> {
    console.log(`[browser_act] 🔄 Auto-recovery: attempting Escape + retry for "${failedAction.type}" action`);

    // 1. Пробуем Escape — часто закрывает модальные окна и оверлеи
    try {
        await fetch(`${scraperUrl}/sessions/${sessionId}/press`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'Escape' }),
            signal: AbortSignal.timeout(5_000),
        });
        // Небольшая пауза после Escape
        await new Promise(resolve => setTimeout(resolve, 500));
    } catch {
        console.warn('[browser_act] ⚠️ Escape press failed, continuing recovery');
    }

    // 2. Скриншот для диагностики
    const screenshot = await captureScreenshot(scraperUrl, sessionId);

    // 3. Vision-диагностика (если есть скриншот)
    let diagnosis = 'Скриншот недоступен для анализа';
    let visionX: number | undefined;
    let visionY: number | undefined;

    if (screenshot) {
        diagnosis = await visionDiagnose(screenshot, failedAction, errorText);
        // Пытаемся извлечь координаты из ответа модели: ищем паттерн (x: 123, y: 456) или x=123 y=456
        const coordMatch = diagnosis.match(/[xX]\s*[:=]?\s*(\d+).*?[yY]\s*[:=]?\s*(\d+)/);
        if (coordMatch) {
            visionX = parseInt(coordMatch[1], 10);
            visionY = parseInt(coordMatch[2], 10);
        }
    }

    // 4. Попытка ретрая
    let recoveryAction = { ...failedAction };

    // Если это был клик (с селектором) по невидимому элементу, и у нас есть координаты от vision — используем их!
    if (failedAction.type === 'click' && failedAction.selector && visionX !== undefined && visionY !== undefined) {
        console.log(`[browser_act] 🔄 Auto-recovery: Switching to coordinate click (${visionX}, ${visionY}) based on vision`);
        recoveryAction = { type: 'click', x: visionX, y: visionY };
    }

    try {
        const retryRes = await fetch(`${scraperUrl}/sessions/${sessionId}/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actions: [recoveryAction],
                screenshot_after: false,
            }),
            signal: AbortSignal.timeout(15_000),
        });
        const retryData = await retryRes.json();

        if (retryData.success) {
            console.log('[browser_act] ✅ Auto-recovery succeeded!');
            return { recovered: true, screenshot, diagnosis, retryData };
        }
    } catch {
        console.warn('[browser_act] ⚠️ Retry failed');
    }

    return { recovered: false, screenshot, diagnosis };
}

// ─── Основной инструмент ───

export const browserActTool: ToolDefinition<BrowserActInput> = {
    name: 'browser_act',
    description: `Выполнить действия на странице, открытой через browser_open.

Требует session_id из предыдущего вызова browser_open.

Доступные действия (actions):
- click: клик по элементу. { type: "click", selector: "CSS-селектор" }
- click по координатам: { type: "click", x: 350, y: 200 } — когда селектор не работает (элемент перекрыт, невидим). Координаты можно получить из скриншота (browser_read mode=screenshot).
- type: ввод текста. { type: "type", selector: "CSS-селектор", value: "текст" }
- scroll: скролл. { type: "scroll", y: 500 } (пиксели вниз)
- press: нажать клавишу. { type: "press", key: "Enter" }
- wait: ожидание. { type: "wait", ms: 2000 } или { type: "wait", selector: ".results" }
- hover: наведение. { type: "hover", selector: "CSS-селектор" }
- select: выбор в select. { type: "select", selector: "CSS-селектор", value: "значение" }
- evaluate: выполнить JavaScript на странице. { type: "evaluate", script: "document.querySelector('.popup').remove()" }. Используй для: удаления оверлеев/баннеров, программного клика, извлечения данных, любых манипуляций с DOM.
- navigate: перейти по URL В ТОЙ ЖЕ сессии (сохраняет cookies). { type: "navigate", url: "https://example.com/page" }. Используй ВМЕСТО browser_open когда нужно перейти на другую страницу!

⚠️ ВАЖНО: Если нужно перейти на другой URL в рамках уже открытой сессии — используй navigate, НЕ browser_open! browser_open создаёт НОВУЮ сессию с потерей cookies и авторизации.

Селекторы берутся из поля "selector" элементов, полученных от browser_open или browser_read.

Пример сценария:
1. browser_open("https://afisha.ru") → получаем sessionId + элементы
2. browser_act(sessionId, [{ type: "type", selector: "input[name='q']", value: "Аквамен" }, { type: "press", key: "Enter" }])
3. browser_read(sessionId, "text") → читаем результаты

Пример обхода оверлея:
1. browser_act(sessionId, [{ type: "evaluate", script: "document.querySelectorAll('.overlay,.popup,.modal,[id*=Banner]').forEach(e=>e.remove())" }])
2. browser_act(sessionId, [{ type: "click", selector: "a.target-button" }])

🔄 При ошибке (элемент невидим, таймаут) инструмент АВТОМАТИЧЕСКИ:
- Нажмёт Escape для закрытия оверлеев
- Сделает скриншот с vision-диагностикой (что мешает)
- Повторит действие
Если recovery не помог — вернёт скриншот + диагноз для принятия решения.

⚠️ Действия выполняются последовательно. При ошибке выполнение останавливается.`,
    category: 'analytics',
    toolPack: 'web_browser',
    permission: 'write',
    isReadOnly: false,
    timeout: 90_000, // Увеличен для auto-recovery
    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description: 'ID сессии из browser_open',
            },
            actions: {
                type: 'array',
                description: 'Массив действий. Каждое действие — объект с полями: type (обязательно: "click"|"type"|"scroll"|"press"|"wait"|"hover"|"select"|"evaluate"|"navigate"), selector (CSS-селектор), value (текст для type/select), key (клавиша для press, напр. "Enter"), x/y (координаты для click), script (JS-код для evaluate), url (адрес для navigate), ms (миллисекунды для wait).',
                items: {
                    type: 'object',
                    description: 'Действие: { type, selector?, value?, key?, x?, y?, ms?, script?, url? }',
                },
            },
        },
        required: ['session_id', 'actions'],
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

        if (!input.actions || input.actions.length === 0) {
            return {
                success: false,
                error: 'Не указаны действия',
                displayText: '❌ Укажи хотя бы одно действие в массиве actions.',
            };
        }

        // Лимит действий для безопасности
        if (input.actions.length > 10) {
            return {
                success: false,
                error: 'Слишком много действий (максимум 10)',
                displayText: '❌ Максимум 10 действий за один вызов. Разбейте на несколько вызовов.',
            };
        }

        // ─── Превентивная валидация обязательных параметров ───
        // Отлавливаем ошибки ДО отправки в Scraper — экономит время и даёт понятные подсказки
        const validationErrors: string[] = [];
        for (let i = 0; i < input.actions.length; i++) {
            const a = input.actions[i];
            switch (a.type) {
                case 'click':
                    if (!a.selector && (a.x === undefined || a.y === undefined)) {
                        validationErrors.push(`Action #${i + 1} (click): требуется selector ИЛИ координаты (x, y). Используй browser_read(mode:"dom") чтобы найти нужный селектор.`);
                    }
                    break;
                case 'type':
                    if (!a.selector) {
                        validationErrors.push(`Action #${i + 1} (type): требуется selector. Используй browser_read(mode:"dom") чтобы найти нужный селектор.`);
                    }
                    if (!a.value && a.value !== '') {
                        validationErrors.push(`Action #${i + 1} (type): требуется value (текст для ввода).`);
                    }
                    break;
                case 'navigate':
                    if (!a.url && !a.value) {
                        validationErrors.push(`Action #${i + 1} (navigate): требуется url. Укажи полный URL: {"type":"navigate","url":"https://..."}`);
                    }
                    break;
                case 'evaluate':
                    if (!a.script && !a.value) {
                        validationErrors.push(`Action #${i + 1} (evaluate): требуется script (JavaScript код для выполнения).`);
                    }
                    break;
                case 'press':
                    if (!a.key) {
                        validationErrors.push(`Action #${i + 1} (press): требуется key (название клавиши, например "Enter").`);
                    }
                    break;
                case 'select':
                    if (!a.selector) {
                        validationErrors.push(`Action #${i + 1} (select): требуется selector.`);
                    }
                    break;
            }
        }

        if (validationErrors.length > 0) {
            return {
                success: false,
                error: `Ошибки валидации: ${validationErrors.length} action(s) без обязательных параметров`,
                displayText: `❌ Ошибки валидации (запрос НЕ отправлен в браузер):\n${validationErrors.map(e => `  • ${e}`).join('\n')}\n\n💡 Совет: вызови browser_read(mode:"dom") для получения актуальных селекторов.`,
            };
        }

        try {
            // Преобразование действий для Scraper Service
            const batchActions = input.actions.flatMap((a): any[] => {
                if (a.type === 'evaluate') {
                    return [{ type: 'evaluate', script: a.script || a.value }];
                }
                if (a.type === 'navigate') {
                    return [{ type: 'navigate', url: a.url || a.value, wait_until: 'domcontentloaded', timeout: 30 }];
                }

                // Smart Field Clearing: Очищаем поле перед вводом через JS (гарантированная совместимость)
                if (a.type === 'type' && a.selector) {
                    const safeSelector = a.selector.replace(/'/g, "\\'");
                    return [
                        { type: 'evaluate', script: `(function(){ const el = document.querySelector('${safeSelector}'); if(el) el.value = ''; })()` },
                        a
                    ];
                }

                return [a];
            });

            // Доп валидация на уровне warnings (не блокирует, но подсказывает агенту в display_text)
            const warnings: string[] = [];
            const badSelectors = ['input[type="checkbox"]', 'input[type="submit"]', 'button', 'input', 'a'];

            for (let i = 0; i < input.actions.length; i++) {
                const a = input.actions[i];
                if ((a.type === 'click' || a.type === 'type') && a.selector) {
                    const sel = a.selector.toLowerCase();
                    if (badSelectors.includes(sel.trim()) || sel.startsWith('input[type=')) {
                        warnings.push(`⚠️ Action #${i + 1}: Использован обобщённый селектор "${a.selector}". Это часто приводит к клику не по тому элементу. Используй уникальный селектор (#id или [name=...]).`);
                    }
                }
            }

            // Используем batch API
            const batchRes = await fetch(`${scraperUrl}/sessions/${input.session_id}/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actions: batchActions,
                    screenshot_after: false,
                }),
                signal: AbortSignal.timeout(45_000),
            });

            if (batchRes.status === 404) {
                return {
                    success: false,
                    error: 'Сессия не найдена или истекла',
                    displayText: `❌ Сессия ${input.session_id} не найдена или истекла. Используй browser_open для создания новой.`,
                };
            }

            const batchData = await batchRes.json();

            // Формируем отчёт о действиях
            const parts: string[] = [];
            parts.push(`🎯 Действия выполнены (${batchData.steps_completed}/${batchData.steps_total}):`);

            for (const step of batchData.results || []) {
                const icon = step.success ? '✅' : '❌';
                let desc = `  ${icon} ${step.type}`;
                if (step.url) desc += ` → ${step.url}`;
                if (step.error) desc += `: ${step.error}`;
                parts.push(desc);
            }

            parts.push('');
            parts.push(`📍 Текущая страница: ${batchData.final_title || 'N/A'}`);
            parts.push(`🔗 URL: ${batchData.final_url || 'N/A'}`);

            // ─── Уровень 1 + 4: При ошибке — auto-recovery ───
            if (!batchData.success) {
                // Определяем проваленное действие и текст ошибки
                const failedStep = (batchData.results || []).find((s: any) => !s.success);
                const failedIndex = (batchData.results || []).findIndex((s: any) => !s.success);
                const failedAction = input.actions[failedIndex] || input.actions[input.actions.length - 1];
                const errorText = failedStep?.error || 'unknown error';

                // Уровень 4: Попытка автоматического восстановления
                const recovery = await attemptAutoRecovery(
                    scraperUrl,
                    input.session_id,
                    failedAction,
                    errorText,
                );

                if (recovery.recovered) {
                    // Recovery успешен!
                    parts.length = 0; // Очищаем старый вывод
                    parts.push('🔄 Auto-recovery: действие выполнено после Escape');
                    parts.push(`📍 Текущая страница: ${recovery.retryData?.final_title || batchData.final_title || 'N/A'}`);
                    parts.push(`🔗 URL: ${recovery.retryData?.final_url || batchData.final_url || 'N/A'}`);

                    if (recovery.diagnosis) {
                        parts.push('');
                        parts.push(`📸 Что было на экране: ${recovery.diagnosis.slice(0, 300)}`);
                    }

                    // Извлекаем обновлённый DOM после recovery
                    try {
                        const domRes = await fetch(`${scraperUrl}/sessions/${input.session_id}/dom`, {
                            signal: AbortSignal.timeout(10_000),
                        });
                        const dom = await domRes.json();
                        if (dom.elements && dom.elements.length > 0) {
                            appendDomElements(parts, dom);
                        }
                    } catch { /* DOM extraction failed, not critical */ }

                    return {
                        success: true,
                        data: {
                            sessionId: input.session_id,
                            stepsCompleted: batchData.steps_total,
                            stepsTotal: batchData.steps_total,
                            finalUrl: recovery.retryData?.final_url || batchData.final_url,
                            finalTitle: recovery.retryData?.final_title || batchData.final_title,
                            autoRecovered: true,
                        },
                        displayText: parts.join('\n'),
                    };
                }

                // Recovery не помог — возвращаем ошибку с богатым контекстом
                parts.push('');
                parts.push('🔄 Auto-recovery: Escape + ретрай не помогли');

                if (recovery.diagnosis) {
                    parts.push('');
                    parts.push('📸 Vision-диагностика:');
                    parts.push(recovery.diagnosis);
                }

                // Подсказки для модели
                parts.push('');
                parts.push('💡 Рекомендации:');
                parts.push('  1. evaluate: удали мешающие элементы через JS: { type: "evaluate", script: "document.querySelectorAll(\'.overlay,.popup,.modal,[id*=Banner]\').forEach(e=>e.remove())" }');
                parts.push('  2. Координатный клик: { type: "click", x: ..., y: ... } — координаты из vision-диагностики выше');
                parts.push('  3. navigate: перейди по прямому URL: { type: "navigate", url: "..." }');

                return {
                    success: false,
                    data: {
                        sessionId: input.session_id,
                        stepsCompleted: batchData.steps_completed,
                        stepsTotal: batchData.steps_total,
                        finalUrl: batchData.final_url,
                        finalTitle: batchData.final_title,
                        autoRecoveryAttempted: true,
                    },
                    displayText: parts.join('\n'),
                    imageBase64: recovery.screenshot || undefined,
                };
            }

            // Если всё успешно — извлекаем обновлённый DOM
            try {
                const domRes = await fetch(`${scraperUrl}/sessions/${input.session_id}/dom`, {
                    signal: AbortSignal.timeout(10_000),
                });
                const dom = await domRes.json();

                if (dom.elements && dom.elements.length > 0) {
                    appendDomElements(parts, dom);
                }
            } catch {
                // DOM extraction failed, not critical
                parts.push('');
                parts.push('⚠️ Не удалось извлечь обновлённый DOM');
            }

            return {
                success: true,
                data: {
                    sessionId: input.session_id,
                    stepsCompleted: batchData.steps_completed,
                    stepsTotal: batchData.steps_total,
                    finalUrl: batchData.final_url,
                    finalTitle: batchData.final_title,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Scraper Service timeout',
                    displayText: '⏳ Действия заняли слишком много времени.',
                };
            }

            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка browser_act: ${error?.message || error}`,
            };
        }
    },
};

// ─── Вспомогательная функция для DOM-элементов ───

function appendDomElements(parts: string[], dom: any): void {
    const maxElements = 40;
    const elements = (dom.elements || []).slice(0, maxElements);

    parts.push('');
    parts.push(`🔘 Обновлённые элементы (${elements.length}/${dom.elements_count}):`);
    for (const el of elements) {
        let desc = `  [${el.id}] <${el.tag}>`;
        if (el.text) desc += ` "${el.text.slice(0, 60)}"`;
        if (el.href) desc += ` → ${el.href.slice(0, 80)}`;
        if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
        desc += ` | ${el.selector}`;
        parts.push(desc);
    }
    if (dom.elements_count > maxElements) {
        parts.push(`  ... ещё ${dom.elements_count - maxElements}`);
    }
}
