/**
 * Tool: browser_open — Открыть веб-страницу в удалённом браузере
 * 
 * Создаёт сессию в Scraper Service, переходит по URL,
 * извлекает DOM-структуру (интерактивные элементы с селекторами).
 * 
 * Возвращает sessionId для дальнейших действий через browser_act/browser_read.
 */

import type { ToolDefinition, ToolResult } from '../types';

interface BrowserOpenInput {
    url: string;
    profile_id?: string;
    persistent?: boolean;
}

interface ScraperSession {
    session_id: string;
    url?: string;
    created_at?: string;
}

interface DomElement {
    id: number;
    tag: string;
    text?: string;
    selector: string;
    type?: string;
    href?: string;
    placeholder?: string;
    value?: string;
    aria_label?: string;
    role?: string;
}

interface DomResponse {
    url: string;
    title: string;
    elements_count: number;
    elements: DomElement[];
    structure: {
        headings: Array<{ level: number; text: string }>;
        forms: Array<{ action: string; method: string; inputs: any[] }>;
        navigation: Array<{ links: Array<{ text: string; href: string }> }>;
        images_count: number;
        links_count: number;
    };
}

function getScraperUrl(): string {
    return process.env.SCRAPER_SERVICE_URL || '';
}

// ─── Smart Profile Auto-Check ───

/**
 * Маппинг доменов на site_profile в Scraper Service.
 * Используется для фильтрации профилей по URL.
 */
const DOMAIN_TO_SITE_PROFILE: Record<string, string> = {
    'avito.ru': 'avito',
    'www.avito.ru': 'avito',
    'm.avito.ru': 'avito',
    'auto.ru': 'auto_ru',
    'www.auto.ru': 'auto_ru',
    'drom.ru': 'drom',
    'www.drom.ru': 'drom',
    'baza.drom.ru': 'drom',
};

interface ProfileInfo {
    profile_id: string;
    name: string;
    site_profile?: string;
    description?: string;
    cookies_count: number;
    last_used_at: string | null;
}

/**
 * Определяет site_profile по URL.
 * Например: "https://www.avito.ru/moskva" → "avito"
 */
function detectSiteProfile(url: string): string | null {
    try {
        const hostname = new URL(url).hostname;
        return DOMAIN_TO_SITE_PROFILE[hostname] || null;
    } catch {
        return null;
    }
}

/**
 * Фоново проверяет доступные профили в Scraper Service.
 * Фильтрует по site_profile (если определён из URL), но также включает
 * профили без site_profile (они могут подходить для любого сайта).
 * Если ничего не совпало — возвращает ВСЕ профили, чтобы AI мог выбрать.
 * Не блокирует основной flow — при ошибке просто возвращает пустой массив.
 */
async function fetchMatchingProfiles(scraperUrl: string, siteProfile: string | null): Promise<ProfileInfo[]> {
    try {
        const res = await fetch(`${scraperUrl}/profiles`, {
            signal: AbortSignal.timeout(3_000), // Быстрый таймаут — не задерживаем основной flow
        });
        if (!res.ok) return [];

        const data = await res.json();
        const allProfiles: ProfileInfo[] = data.profiles || data || [];

        if (allProfiles.length === 0) return [];

        // Без site_profile — возвращаем все (пусть AI решает)
        if (!siteProfile) return allProfiles;

        // Совпавшие по site_profile + профили без site_profile (они потенциально подходят для любого сайта)
        const matched = allProfiles.filter(p =>
            p.site_profile === siteProfile || !p.site_profile
        );

        // Если ничего не совпало — возвращаем все, чтобы AI увидел полный список
        return matched.length > 0 ? matched : allProfiles;
    } catch {
        return [];
    }
}

/**
 * Формирует подсказку о доступных профилях для AI.
 */
function formatProfileHint(profiles: ProfileInfo[], siteProfile: string | null): string {
    if (profiles.length === 0) return '';

    const siteName = siteProfile || 'этого сайта';
    const lines: string[] = [];

    if (profiles.length === 1) {
        const p = profiles[0];
        const cookies = p.cookies_count > 0 ? `🍪 ${p.cookies_count} cookies` : '⚠️ пустой (нужна авторизация)';
        const lastUsed = p.last_used_at
            ? `использован ${new Date(p.last_used_at).toLocaleDateString('ru-RU')}`
            : 'ещё не использовался';
        lines.push(`💡 Найден профиль для ${siteName}: "${p.name}" (${cookies}, ${lastUsed})`);
        if (p.cookies_count > 0) {
            lines.push(`   → Для авторизованной сессии перезапусти: browser_open(url: "...", profile_id: "${p.profile_id}", persistent: true)`);
        }
    } else {
        lines.push(`💡 Доступно ${profiles.length} профилей для ${siteName}:`);
        for (const p of profiles) {
            const cookies = p.cookies_count > 0 ? `🍪 ${p.cookies_count}` : '⚠️ пусто';
            const lastUsed = p.last_used_at
                ? new Date(p.last_used_at).toLocaleDateString('ru-RU')
                : 'не исп.';
            lines.push(`   • "${p.name}" [${p.profile_id}] — ${cookies} | ${lastUsed}${p.description ? ` | ${p.description}` : ''}`);
        }
        lines.push(`   → Уточни у пользователя, какой профиль использовать, или выбери по контексту.`);
    }

    return lines.join('\n');
}

// ─── DOM Formatting ───

/**
 * Формирует сжатое текстовое описание DOM для AI.
 * Ограничивает количество элементов и длину для экономии токенов.
 */
function formatDomForAI(dom: DomResponse): string {
    const parts: string[] = [];

    parts.push(`📄 ${dom.title}`);
    parts.push(`🔗 ${dom.url}`);
    parts.push('');

    // Заголовки
    if (dom.structure?.headings?.length > 0) {
        parts.push('📑 Заголовки:');
        for (const h of dom.structure.headings.slice(0, 10)) {
            parts.push(`  ${'#'.repeat(h.level)} ${h.text}`);
        }
        parts.push('');
    }

    // Формы
    if (dom.structure?.forms?.length > 0) {
        parts.push('📝 Формы:');
        for (const form of dom.structure.forms.slice(0, 5)) {
            const inputs = form.inputs.map((i: any) =>
                `${i.tag}[${i.type || 'text'}]${i.placeholder ? ` "${i.placeholder}"` : ''}${i.name ? ` name="${i.name}"` : ''}`
            ).join(', ');
            parts.push(`  ${form.method.toUpperCase()} ${form.action || '(inline)'}: ${inputs}`);
        }
        parts.push('');
    }

    // Интерактивные элементы (ограничиваем до 50 для экономии токенов)
    const maxElements = 50;
    const elements = dom.elements.slice(0, maxElements);

    if (elements.length > 0) {
        parts.push(`🔘 Интерактивные элементы (${elements.length}/${dom.elements_count}):`);
        for (const el of elements) {
            let desc = `  [${el.id}] <${el.tag}>`;
            if (el.text) desc += ` "${el.text.slice(0, 60)}"`;
            if (el.href) desc += ` → ${el.href.slice(0, 80)}`;
            if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
            if (el.type) desc += ` type=${el.type}`;
            desc += ` | selector: ${el.selector}`;
            parts.push(desc);
        }
        if (dom.elements_count > maxElements) {
            parts.push(`  ... ещё ${dom.elements_count - maxElements} элементов`);
        }
    }

    return parts.join('\n');
}

export const browserOpenTool: ToolDefinition<BrowserOpenInput> = {
    name: 'browser_open',
    description: `Открыть веб-страницу в удалённом браузере для интерактивного взаимодействия.

Используй когда:
- Нужно взаимодействовать со страницей: кликать, заполнять формы, скроллить
- read_web_page не справился (SPA, динамический контент, формы)
- Нужно пошагово навигировать по сайту (поиск → результаты → детали)
- Нужно работать на сайте с авторизацией (передай profile_id)

Возвращает sessionId + список интерактивных элементов с CSS-селекторами.
После открытия используй browser_act для действий, browser_read для чтения.

🔐 Поддержка авторизованных сессий:
- profile_id — загрузить cookies из сохранённого профиля (сессия уже авторизована!)
- persistent — автоматически сохранять обновлённые cookies при закрытии сессии
- Без profile_id — чистая ephemeral сессия (по умолчанию, как раньше)
- Управление профилями: browser_profiles(action: "list" | "create" | "save")

⚠️ ВАЖНО: после завершения задачи сессия закроется автоматически через 10 минут.
Не открывай больше 3 сессий одновременно.`,
    category: 'analytics',
    toolPack: 'web_browser',
    permission: 'write',
    isReadOnly: false,
    timeout: 60_000,
    inputSchema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'URL страницы для открытия. Должен начинаться с http:// или https://',
            },
            profile_id: {
                type: 'string',
                description: 'ID профиля для загрузки cookies (из browser_profiles). Сессия будет уже авторизована!',
            },
            persistent: {
                type: 'boolean',
                description: 'Автоматически сохранять cookies в профиль при закрытии сессии. Требуется profile_id. По умолчанию false.',
            },
        },
        required: ['url'],
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

        try {
            // 1. Создать сессию (с профилем, если указан)
            const sessionBody: Record<string, any> = { ttl_minutes: 10 };
            if (input.profile_id) {
                sessionBody.profile_id = input.profile_id;
                if (input.persistent) {
                    sessionBody.persistent = true;
                }
            }

            // Smart auto-check: запускаем проверку профилей ПАРАЛЛЕЛЬНО с созданием сессии
            // Только если profile_id не указан — иначе профиль уже выбран
            const siteProfile = detectSiteProfile(input.url);
            const profilesPromise = !input.profile_id
                ? fetchMatchingProfiles(scraperUrl, siteProfile)
                : Promise.resolve([]);

            const createRes = await fetch(`${scraperUrl}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sessionBody),
                signal: AbortSignal.timeout(15_000),
            });

            if (!createRes.ok) {
                const errText = await createRes.text().catch(() => '');
                return {
                    success: false,
                    error: `Не удалось создать сессию: ${createRes.status} ${errText}`,
                    displayText: `❌ Ошибка создания браузерной сессии (${createRes.status}). Возможно, достигнут лимит сессий.`,
                };
            }

            const session: ScraperSession = await createRes.json();
            const sessionId = session.session_id;

            // 2. Перейти по URL
            const navRes = await fetch(`${scraperUrl}/sessions/${sessionId}/navigate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: input.url,
                    wait_until: 'domcontentloaded',
                    timeout: 30,
                }),
                signal: AbortSignal.timeout(35_000),
            });

            const navData = await navRes.json();
            if (!navData.success) {
                return {
                    success: false,
                    error: navData.error || 'Навигация не удалась',
                    displayText: `❌ Не удалось открыть ${input.url}: ${navData.error || 'unknown error'}`,
                };
            }

            // 3. Извлечь DOM
            const domRes = await fetch(`${scraperUrl}/sessions/${sessionId}/dom`, {
                signal: AbortSignal.timeout(10_000),
            });

            const dom: DomResponse = await domRes.json();

            // 4. Получить результат auto-check профилей (уже должен быть готов — запущен параллельно)
            const matchingProfiles = await profilesPromise;
            const profileHint = !input.profile_id ? formatProfileHint(matchingProfiles, siteProfile) : '';

            const profileLabel = input.profile_id ? ` 🔐 профиль: ${input.profile_id}` : '';
            const persistLabel = input.persistent ? ' | auto-save' : '';
            const parts: string[] = [
                `🌐 Браузер открыт (сессия: ${sessionId}${profileLabel}${persistLabel})`,
            ];

            // Подсказка о профилях — между заголовком и DOM
            if (profileHint) {
                parts.push('');
                parts.push(profileHint);
            }

            parts.push('');
            parts.push(formatDomForAI(dom));

            return {
                success: true,
                data: {
                    sessionId,
                    url: dom.url,
                    title: dom.title,
                    elementsCount: dom.elements_count,
                    profileId: input.profile_id || null,
                    persistent: input.persistent || false,
                    availableProfiles: matchingProfiles.length > 0 ? matchingProfiles : undefined,
                },
                displayText: parts.join('\n'),
            };
        } catch (error: any) {
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Scraper Service timeout',
                    displayText: `⏳ Scraper Service не ответил вовремя. Проверьте доступность ${scraperUrl}`,
                };
            }

            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка browser_open: ${error?.message || error}`,
            };
        }
    },
};
