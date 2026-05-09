#!/usr/bin/env node
/**
 * MCP Server — Google Calendar
 * 
 * Собственный MCP-сервер на базе официального googleapis.
 * Запускается как child process через StdioClientTransport.
 * 
 * Tools:
 *   - list_events   — получить события за период
 *   - create_event  — создать событие
 *   - update_event  — обновить событие
 *   - delete_event  — удалить событие
 * 
 * OAuth: читает credentials.json + token.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// OAuth2 Setup
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Корень проекта:
// - dev:  __dirname = server/mcp/         → ../../ = корень
// - prod: __dirname = dist/               → ../ = корень
// Также пробуем process.cwd() как fallback
function findProjectFile(filename: string): string {
    const candidates = [
        path.resolve(__dirname, '../../', filename),  // dev
        path.resolve(__dirname, '../', filename),     // production
        path.resolve(process.cwd(), filename),        // fallback
    ];
    const found = candidates.find(p => fs.existsSync(p));
    return found || candidates[2]; // fallback на cwd если не нашли
}

const CREDENTIALS_PATH = findProjectFile('google-credentials.json');
const TOKEN_PATH = findProjectFile('google-token.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Retry configuration
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH']);

/**
 * Проверка, является ли ошибка транзиентной (имеет смысл retry)
 */
function isRetryableError(error: any): boolean {
    // HTTP status codes
    if (error?.code && RETRYABLE_HTTP_CODES.has(Number(error.code))) return true;
    if (error?.response?.status && RETRYABLE_HTTP_CODES.has(error.response.status)) return true;
    // Network errors (direct code)
    if (error?.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;
    if (error?.cause?.code && RETRYABLE_ERROR_CODES.has(error.cause.code)) return true;
    // Generic network error messages
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('socket hang up') || msg.includes('network') || msg.includes('timeout')) return true;
    if (msg.includes('fetch failed') || msg.includes('failed to fetch')) return true;
    // googleapis wraps inner errors in error.errors[]
    if (Array.isArray(error?.errors)) {
        return error.errors.some((e: any) => isRetryableError(e));
    }
    // Ключевой кейс: google-auth-library бросает ошибку с пустым message при сетевом сбое
    // ("request to https://oauth2.googleapis.com/token failed, reason: ") — reason пустой
    if (msg.includes('oauth2.googleapis.com') || msg.includes('googleapis.com')) return true;
    return false;
}

/**
 * Проверка, является ли ошибка аутентификационной (нужна ре-инициализация OAuth)
 */
function isAuthError(error: any): boolean {
    const status = error?.code || error?.response?.status;
    if (status === 401 || status === 403) return true;
    const msg = String(error?.message || '').toLowerCase();
    return msg.includes('invalid_grant') || msg.includes('token has been expired') || msg.includes('token has been revoked');
}

/**
 * Retry wrapper с exponential backoff
 */
async function withRetry<T>(fn: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // При ошибке аутентификации — сбросить кэш и пересоздать клиент
            if (isAuthError(error)) {
                console.error(`[MCP-Calendar] 🔑 Auth error в ${operationName}: ${error?.message}. Пересоздаю OAuth client...`);
                calendarApi = null as any; // Сброс кэша
                cachedOAuth2Client = null; // Сброс OAuth клиента
                if (attempt < RETRY_MAX_ATTEMPTS) {
                    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    console.error(`[MCP-Calendar] 🔄 Retry ${attempt}/${RETRY_MAX_ATTEMPTS} через ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
            }

            // При транзиентной ошибке — retry с backoff
            if (isRetryableError(error) && attempt < RETRY_MAX_ATTEMPTS) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.error(`[MCP-Calendar] 🔄 Retry ${attempt}/${RETRY_MAX_ATTEMPTS} для ${operationName}: ${error?.message}. Жду ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // Не-retry ошибка — бросаем сразу
            throw error;
        }
    }
    throw lastError;
}

/**
 * Загрузить или создать OAuth2 клиент
 */
function loadOAuth2Client(): OAuth2Client {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error(
            `[MCP-Calendar] credentials.json не найден: ${CREDENTIALS_PATH}\n` +
            `Создайте OAuth Desktop App в Google Cloud Console и сохраните credentials.json`
        );
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const { client_id, client_secret, redirect_uris } =
        credentials.installed || credentials.web;

    const oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0]);

    // Загружаем сохранённый токен
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
        oauth2Client.setCredentials(token);

        // Автообновление токена
        oauth2Client.on('tokens', (tokens) => {
            const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            const updated = { ...existing, ...tokens };
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
            console.error('[MCP-Calendar] 🔄 Token refreshed and saved');
        });
    } else {
        // Интерактивная авторизация через URL
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
        });
        console.error(`[MCP-Calendar] ⚠️ Нужна авторизация. Откройте URL:\n${authUrl}`);
        console.error(`После авторизации выполните:\n  node server/mcp/googleCalendarAuth.ts <code>`);
        throw new Error('[MCP-Calendar] Требуется первоначальная OAuth авторизация');
    }

    return oauth2Client;
}

// ============================================================================
// Calendar API helpers
// ============================================================================

let calendarApi: calendar_v3.Calendar | null = null;
let cachedOAuth2Client: OAuth2Client | null = null;

/**
 * Проактивное обновление access_token
 * Вызывается при старте и по таймеру — чтобы к моменту реального API вызова
 * access_token уже был свежий и не требовался промежуточный refresh.
 */
async function forceRefreshToken(): Promise<boolean> {
    try {
        const client = cachedOAuth2Client || loadOAuth2Client();
        cachedOAuth2Client = client;

        // Принудительно обновляем access_token
        const { credentials } = await client.refreshAccessToken();
        client.setCredentials(credentials);

        // Сохраняем обновлённый токен на диск
        if (fs.existsSync(TOKEN_PATH)) {
            const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            const updated = { ...existing, ...credentials };
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
        }

        const expiresIn = credentials.expiry_date
            ? Math.round((credentials.expiry_date - Date.now()) / 60000)
            : '?';
        console.error(`[MCP-Calendar] ✅ Token proactively refreshed (expires in ${expiresIn} min)`);
        return true;
    } catch (error: any) {
        const msg = error?.message || '';
        if (msg.includes('invalid_grant')) {
            console.error(`[MCP-Calendar] ❌ Refresh token is invalid, expired or revoked.`);
            console.error(`[MCP-Calendar] 🔑 Please run re-authentication: npx tsx server/mcp/googleCalendarAuth.ts`);
        } else {
            console.error(`[MCP-Calendar] ⚠️ Proactive refresh failed: ${msg}`);
        }
        return false;
    }
}

/**
 * Запуск периодического обновления токена (каждые 50 минут)
 * Google access_token живёт ~60 минут, обновляем за 10 минут до истечения
 */
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 минут

function startProactiveRefresh(): void {
    setInterval(async () => {
        console.error('[MCP-Calendar] 🔄 Periodic token refresh...');
        await forceRefreshToken();
    }, REFRESH_INTERVAL_MS);
    console.error(`[MCP-Calendar] ⏰ Proactive refresh scheduled (every ${REFRESH_INTERVAL_MS / 60000} min)`);
}

function getCalendar(): calendar_v3.Calendar {
    if (!calendarApi) {
        console.error('[MCP-Calendar] 🔧 Создаю/пересоздаю Calendar API client...');
        const auth = cachedOAuth2Client || loadOAuth2Client();
        cachedOAuth2Client = auth;
        calendarApi = google.calendar({ version: 'v3', auth });
    }
    return calendarApi;
}

/**
 * Health check: проверяет, что токен валиден и API доступен
 */
async function healthCheck(): Promise<boolean> {
    try {
        const calendar = getCalendar();
        await calendar.calendarList.list({ maxResults: 1 });
        console.error('[MCP-Calendar] ✅ Health check passed — API доступен');
        return true;
    } catch (error: any) {
        console.error(`[MCP-Calendar] ⚠️ Health check failed: ${error?.message}`);
        calendarApi = null; // Сброс кэша для пересоздания
        return false;
    }
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
    {
        name: 'google-calendar',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// ── List Tools ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'list_events',
            description: 'Получить события из Google Календаря за указанный период',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    timeMin: {
                        type: 'string',
                        description: 'Начало периода в ISO 8601 (например "2026-03-23T00:00:00+03:00")',
                    },
                    timeMax: {
                        type: 'string',
                        description: 'Конец периода в ISO 8601',
                    },
                    query: {
                        type: 'string',
                        description: 'Поиск по тексту события (опционально)',
                    },
                    calendarId: {
                        type: 'string',
                        description: 'ID календаря (по умолчанию "primary")',
                    },
                    maxResults: {
                        type: 'number',
                        description: 'Максимум событий (по умолчанию 20)',
                    },
                },
                required: ['timeMin', 'timeMax'],
            },
        },
        {
            name: 'create_event',
            description: 'Создать новое событие в Google Календаре',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    summary: {
                        type: 'string',
                        description: 'Название события',
                    },
                    startTime: {
                        type: 'string',
                        description: 'Начало события в ISO 8601 с таймзоной',
                    },
                    endTime: {
                        type: 'string',
                        description: 'Конец события в ISO 8601 с таймзоной',
                    },
                    description: {
                        type: 'string',
                        description: 'Описание (опционально)',
                    },
                    location: {
                        type: 'string',
                        description: 'Место проведения (опционально)',
                    },
                    calendarId: {
                        type: 'string',
                        description: 'ID календаря (по умолчанию "primary")',
                    },
                },
                required: ['summary', 'startTime', 'endTime'],
            },
        },
        {
            name: 'update_event',
            description: 'Обновить существующее событие в Google Календаре',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'ID события для обновления',
                    },
                    summary: {
                        type: 'string',
                        description: 'Новое название (опционально)',
                    },
                    startTime: {
                        type: 'string',
                        description: 'Новое время начала в ISO 8601 (опционально)',
                    },
                    endTime: {
                        type: 'string',
                        description: 'Новое время окончания в ISO 8601 (опционально)',
                    },
                    description: {
                        type: 'string',
                        description: 'Новое описание (опционально)',
                    },
                    location: {
                        type: 'string',
                        description: 'Новое место (опционально)',
                    },
                    calendarId: {
                        type: 'string',
                        description: 'ID календаря (по умолчанию "primary")',
                    },
                },
                required: ['eventId'],
            },
        },
        {
            name: 'delete_event',
            description: 'Удалить событие из Google Календаря',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'ID события для удаления',
                    },
                    calendarId: {
                        type: 'string',
                        description: 'ID календаря (по умолчанию "primary")',
                    },
                },
                required: ['eventId'],
            },
        },
    ],
}));

// ── Call Tool ────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'list_events':
                return await handleListEvents(args as any);
            case 'create_event':
                return await handleCreateEvent(args as any);
            case 'update_event':
                return await handleUpdateEvent(args as any);
            case 'delete_event':
                return await handleDeleteEvent(args as any);
            default:
                return {
                    content: [{ type: 'text' as const, text: `Неизвестный tool: ${name}` }],
                    isError: true,
                };
        }
    } catch (error: any) {
        console.error(`[MCP-Calendar] ❌ Ошибка в ${name}:`, error?.message || error);
        return {
            content: [{ type: 'text' as const, text: `Ошибка: ${error?.message || error}` }],
            isError: true,
        };
    }
});

// ============================================================================
// Tool Handlers
// ============================================================================

interface ListEventsArgs {
    timeMin: string;
    timeMax: string;
    query?: string;
    calendarId?: string;
    maxResults?: number;
}

async function handleListEvents(args: ListEventsArgs) {
    return withRetry(async () => {
        const calendar = getCalendar();
        const response = await calendar.events.list({
            calendarId: args.calendarId || 'primary',
            timeMin: args.timeMin,
            timeMax: args.timeMax,
            q: args.query,
            maxResults: args.maxResults || 20,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];

        if (events.length === 0) {
            return {
                content: [{ type: 'text' as const, text: 'Событий не найдено за указанный период.' }],
            };
        }

        const formatted = events.map((event, i) => {
            const start = event.start?.dateTime || event.start?.date || '?';
            const end = event.end?.dateTime || event.end?.date || '?';
            const location = event.location ? ` | 📍 ${event.location}` : '';
            const desc = event.description ? `\n   ${event.description.substring(0, 100)}` : '';
            return `${i + 1}. **${event.summary || '(без названия)'}**\n   🕐 ${start} → ${end}${location}${desc}\n   ID: ${event.id}`;
        });

        return {
            content: [{
                type: 'text' as const,
                text: `📅 Найдено ${events.length} событий:\n\n${formatted.join('\n\n')}`,
            }],
        };
    }, 'list_events');
}

interface CreateEventArgs {
    summary: string;
    startTime: string;
    endTime: string;
    description?: string;
    location?: string;
    calendarId?: string;
}

async function handleCreateEvent(args: CreateEventArgs) {
    return withRetry(async () => {
        const calendar = getCalendar();
        const event = await calendar.events.insert({
            calendarId: args.calendarId || 'primary',
            requestBody: {
                summary: args.summary,
                description: args.description,
                location: args.location,
                start: { dateTime: args.startTime },
                end: { dateTime: args.endTime },
            },
        });

        return {
            content: [{
                type: 'text' as const,
                text: `✅ Событие создано: "${event.data.summary}"\n` +
                    `🕐 ${event.data.start?.dateTime} → ${event.data.end?.dateTime}\n` +
                    `ID: ${event.data.id}\n` +
                    `Ссылка: ${event.data.htmlLink}`,
            }],
        };
    }, 'create_event');
}

interface UpdateEventArgs {
    eventId: string;
    summary?: string;
    startTime?: string;
    endTime?: string;
    description?: string;
    location?: string;
    calendarId?: string;
}

async function handleUpdateEvent(args: UpdateEventArgs) {
    return withRetry(async () => {
        const calendar = getCalendar();
        const calendarId = args.calendarId || 'primary';

        // Формируем объект только с теми полями, которые нужно обновить (Patch)
        const requestBody: calendar_v3.Schema$Event = {};
        if (args.summary !== undefined) requestBody.summary = args.summary;
        if (args.description !== undefined) requestBody.description = args.description;
        if (args.location !== undefined) requestBody.location = args.location;
        if (args.startTime) requestBody.start = { dateTime: args.startTime };
        if (args.endTime) requestBody.end = { dateTime: args.endTime };

        const updated = await calendar.events.patch({
            calendarId,
            eventId: args.eventId,
            requestBody,
        });

        return {
            content: [{
                type: 'text' as const,
                text: `✅ Событие обновлено: "${updated.data.summary}"\n` +
                    `🕐 ${updated.data.start?.dateTime} → ${updated.data.end?.dateTime}\n` +
                    `ID: ${updated.data.id}`,
            }],
        };
    }, 'update_event');
}

interface DeleteEventArgs {
    eventId: string;
    calendarId?: string;
}

async function handleDeleteEvent(args: DeleteEventArgs) {
    return withRetry(async () => {
        const calendar = getCalendar();
        await calendar.events.delete({
            calendarId: args.calendarId || 'primary',
            eventId: args.eventId,
        });

        return {
            content: [{
                type: 'text' as const,
                text: `🗑️ Событие ${args.eventId} удалено.`,
            }],
        };
    }, 'delete_event');
}

// ============================================================================
// Start Server
// ============================================================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP-Calendar] ✅ Google Calendar MCP Server запущен (stdio)');

    // Проактивное обновление токена при старте (с retry)
    // Это заменяет health check — если refresh прошёл, значит API доступен
    const refreshed = await withRetry(
        () => forceRefreshToken().then(ok => { if (!ok) throw new Error('refresh failed'); }),
        'startup_refresh'
    ).then(() => true).catch(() => false);

    if (refreshed) {
        console.error('[MCP-Calendar] ✅ Startup: токен обновлён, API готов');
    } else {
        console.error('[MCP-Calendar] ⚠️ Startup: токен не обновлён — lazy refresh при первом вызове');
    }

    // Запускаем периодическое обновление (каждые 50 минут)
    startProactiveRefresh();
}

// Global error handlers — не даём процессу умирать при необработанных ошибках
process.on('uncaughtException', (error) => {
    console.error('[MCP-Calendar] 💥 Uncaught exception (продолжаем работу):', error?.message || error);
    calendarApi = null;
    cachedOAuth2Client = null;
});

process.on('unhandledRejection', (reason) => {
    console.error('[MCP-Calendar] 💥 Unhandled rejection (продолжаем работу):', reason);
    calendarApi = null;
    cachedOAuth2Client = null;
});

main().catch((error) => {
    console.error('[MCP-Calendar] ❌ Ошибка запуска:', error);
    process.exit(1);
});
