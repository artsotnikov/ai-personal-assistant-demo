/**
 * Tool: browser_profiles — Управление постоянными браузерными профилями
 * 
 * CRUD-операции над профилями в Scraper Service.
 * Профиль = сохранённые cookies + localStorage.
 * Позволяет авторизоваться один раз и повторно использовать сессию.
 */

import type { ToolDefinition, ToolResult } from '../types';

interface BrowserProfilesInput {
    action: 'list' | 'create' | 'delete' | 'save';
    name?: string;
    site_profile?: string;
    description?: string;
    profile_id?: string;
    session_id?: string;
}

interface ProfileInfo {
    profile_id: string;
    name: string;
    site_profile?: string;
    description?: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    cookies_count: number;
}

function getScraperUrl(): string {
    return process.env.SCRAPER_SERVICE_URL || '';
}

export const browserProfilesTool: ToolDefinition<BrowserProfilesInput> = {
    name: 'browser_profiles',
    description: `Управление постоянными браузерными профилями (cookies + localStorage).

Профиль позволяет сохранить авторизацию на сайте и повторно использовать её без логина.

Действия (action):
- "list" — список всех профилей. Покажет имя, сайт, количество cookies, дату использования.
- "create" — создать новый профиль. Требуется name (имя) и site_profile (avito, auto_ru, drom).
- "delete" — удалить профиль. Требуется profile_id.
- "save" — сохранить cookies из активной браузерной сессии в профиль. Требуется profile_id + session_id.

Типичный сценарий:
1. browser_profiles(action: "create", name: "avito_main", site_profile: "avito") → создаём профиль
2. browser_open(url: "https://avito.ru/profile/login") → открываем страницу логина
3. browser_act(...) → вводим логин/пароль, авторизуемся
4. browser_profiles(action: "save", profile_id: "...", session_id: "...") → сохраняем cookies
5. В будущем: browser_open(url: "https://avito.ru", profile_id: "...") → сессия уже авторизована!

⚠️ Перед первым использованием проверь список профилей (action: "list") — возможно, нужный профиль уже создан.`,
    category: 'analytics',
    toolPack: 'web_browser',
    permission: 'write',
    isReadOnly: false,
    timeout: 15_000,
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'Действие: "list" | "create" | "delete" | "save"',
                enum: ['list', 'create', 'delete', 'save'],
            },
            name: {
                type: 'string',
                description: 'Имя профиля (для create). Например: "avito_main", "auto_ru_seller"',
            },
            site_profile: {
                type: 'string',
                description: 'Профиль сайта (для create): "avito", "auto_ru", "drom"',
            },
            description: {
                type: 'string',
                description: 'Описание профиля (для create, опционально)',
            },
            profile_id: {
                type: 'string',
                description: 'ID профиля (для delete, save)',
            },
            session_id: {
                type: 'string',
                description: 'ID активной браузерной сессии (для save — из browser_open)',
            },
        },
        required: ['action'],
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
            switch (input.action) {
                // ─── LIST ───
                case 'list': {
                    const res = await fetch(`${scraperUrl}/profiles`, {
                        signal: AbortSignal.timeout(10_000),
                    });

                    if (!res.ok) {
                        return {
                            success: false,
                            error: `Ошибка получения профилей: ${res.status}`,
                            displayText: `❌ Не удалось получить список профилей (${res.status})`,
                        };
                    }

                    const data = await res.json();
                    const profiles: ProfileInfo[] = data.profiles || data || [];

                    if (profiles.length === 0) {
                        return {
                            success: true,
                            data: { profiles: [] },
                            displayText: '📋 Профилей пока нет. Создай новый через action: "create".',
                        };
                    }

                    const lines: string[] = [`📋 Браузерные профили (${profiles.length}):`];
                    for (const p of profiles) {
                        const cookies = p.cookies_count > 0 ? `🍪 ${p.cookies_count} cookies` : '⚠️ пустой';
                        const lastUsed = p.last_used_at
                            ? `использован ${new Date(p.last_used_at).toLocaleDateString('ru-RU')}`
                            : 'ещё не использовался';
                        lines.push(`  • ${p.name} [${p.profile_id}] — ${p.site_profile || 'generic'} | ${cookies} | ${lastUsed}`);
                        if (p.description) lines.push(`    ${p.description}`);
                    }

                    return {
                        success: true,
                        data: { profiles },
                        displayText: lines.join('\n'),
                    };
                }

                // ─── CREATE ───
                case 'create': {
                    if (!input.name) {
                        return {
                            success: false,
                            error: 'Не указано имя профиля',
                            displayText: '❌ Для создания профиля укажи name. Пример: { action: "create", name: "avito_main", site_profile: "avito" }',
                        };
                    }

                    const res = await fetch(`${scraperUrl}/profiles`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: input.name,
                            site_profile: input.site_profile,
                            description: input.description,
                        }),
                        signal: AbortSignal.timeout(10_000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        return {
                            success: false,
                            error: `Ошибка создания профиля: ${res.status} ${errText}`,
                            displayText: `❌ Не удалось создать профиль (${res.status}). ${errText}`,
                        };
                    }

                    const profile: ProfileInfo = await res.json();

                    return {
                        success: true,
                        data: { profile },
                        displayText: [
                            `✅ Профиль создан:`,
                            `  Имя: ${profile.name}`,
                            `  ID: ${profile.profile_id}`,
                            `  Сайт: ${profile.site_profile || 'generic'}`,
                            ``,
                            `Следующий шаг: авторизуйся на сайте через browser_open + browser_act,`,
                            `затем сохрани cookies: browser_profiles(action: "save", profile_id: "${profile.profile_id}", session_id: "...")`,
                        ].join('\n'),
                    };
                }

                // ─── DELETE ───
                case 'delete': {
                    if (!input.profile_id) {
                        return {
                            success: false,
                            error: 'Не указан profile_id',
                            displayText: '❌ Для удаления профиля укажи profile_id. Список: browser_profiles(action: "list")',
                        };
                    }

                    const res = await fetch(`${scraperUrl}/profiles/${input.profile_id}`, {
                        method: 'DELETE',
                        signal: AbortSignal.timeout(10_000),
                    });

                    if (res.status === 404) {
                        return {
                            success: false,
                            error: 'Профиль не найден',
                            displayText: `❌ Профиль ${input.profile_id} не найден.`,
                        };
                    }

                    if (!res.ok) {
                        return {
                            success: false,
                            error: `Ошибка удаления: ${res.status}`,
                            displayText: `❌ Не удалось удалить профиль (${res.status})`,
                        };
                    }

                    return {
                        success: true,
                        data: { deleted: input.profile_id },
                        displayText: `🗑️ Профиль ${input.profile_id} удалён.`,
                    };
                }

                // ─── SAVE ───
                case 'save': {
                    if (!input.profile_id || !input.session_id) {
                        return {
                            success: false,
                            error: 'Не указан profile_id или session_id',
                            displayText: '❌ Для сохранения cookies укажи profile_id и session_id (из browser_open).',
                        };
                    }

                    const res = await fetch(`${scraperUrl}/profiles/${input.profile_id}/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: input.session_id }),
                        signal: AbortSignal.timeout(10_000),
                    });

                    if (res.status === 404) {
                        return {
                            success: false,
                            error: 'Профиль или сессия не найдены',
                            displayText: `❌ Профиль ${input.profile_id} или сессия ${input.session_id} не найдены.`,
                        };
                    }

                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        return {
                            success: false,
                            error: `Ошибка сохранения: ${res.status} ${errText}`,
                            displayText: `❌ Не удалось сохранить cookies (${res.status}). ${errText}`,
                        };
                    }

                    const data = await res.json();
                    const profile = data.profile || data;

                    return {
                        success: true,
                        data: { profile },
                        displayText: [
                            `✅ Cookies сохранены в профиль ${profile.name || input.profile_id}`,
                            `  🍪 ${profile.cookies_count || '?'} cookies`,
                            ``,
                            `Теперь можно использовать: browser_open(url: "...", profile_id: "${input.profile_id}")`,
                        ].join('\n'),
                    };
                }

                default:
                    return {
                        success: false,
                        error: `Неизвестное действие: ${input.action}`,
                        displayText: `❌ Неизвестное действие "${input.action}". Доступные: list, create, delete, save.`,
                    };
            }
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
                displayText: `❌ Ошибка browser_profiles: ${error?.message || error}`,
            };
        }
    },
};
