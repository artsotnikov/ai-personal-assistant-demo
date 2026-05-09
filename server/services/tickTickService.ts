/**
 * TickTick API Service — HTTP-клиент для TickTick Open API
 * 
 * Реализует OAuth 2.0 авторизацию и CRUD-операции над задачами и проектами.
 * Base URL: https://api.ticktick.com/open/v1
 * 
 * Документация: https://developer.ticktick.com/docs#/openapi
 */

// ============================================================================
// Типы
// ============================================================================

import { db } from "../db";
import { ticktickTasks } from "@shared/schema";
import { sql, eq, and } from "drizzle-orm";
import * as embeddingService from "../embeddingService";
import { backfillMissingTaskEmbeddings } from "../embeddingService";
import { 
    getActiveGoals, 
    syncGoalWithTickTick 
} from "../goalManager";
import { diagInfo, diagWarn, diagError } from './diagnosticLogger';

export interface TickTickTokens {

    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // Unix timestamp
}

export interface TickTickProject {
    id: string;
    name: string;
    color?: string;
    sortOrder?: number;
    closed?: boolean;
    groupId?: string;
    viewMode?: string;
    permission?: string;
    kind?: string;
}

export interface TickTickTask {
    id: string;
    projectId: string;
    title: string;
    content?: string;
    desc?: string;
    priority: number; // 0=none, 1=low, 3=medium, 5=high
    status: number; // 0=normal, 2=completed
    dueDate?: string;
    startDate?: string;
    isAllDay?: boolean;
    timeZone?: string;
    tags?: string[];
    items?: TickTickChecklistItem[]; // субзадачи
    sortOrder?: number;
    completedTime?: string;
    createdTime?: string;
    modifiedTime?: string;
    parentId?: string; // ID родительской задачи, если это подзадача
    _projectName?: string; // Виртуальное поле, добавляется для удобства отображения агентом
}

export interface TickTickChecklistItem {
    id?: string;
    title: string;
    status: number; // 0=normal, 1=completed
    sortOrder?: number;
}

export interface TickTickProjectData {
    project: TickTickProject;
    tasks: TickTickTask[];
}

export interface CreateTaskInput {
    title: string;
    content?: string;
    projectId?: string;
    priority?: number;
    dueDate?: string;
    startDate?: string;
    isAllDay?: boolean;
    timeZone?: string;
    tags?: string[];
    items?: { title: string; status?: number }[];
}

export interface UpdateTaskInput {
    taskId: string;
    projectId: string;
    title?: string;
    content?: string;
    priority?: number;
    dueDate?: string;
    startDate?: string;
    isAllDay?: boolean;
    tags?: string[];
    /** Checklist items (подзадачи) — полная замена */
    items?: TickTickChecklistItem[];
    /** Новый projectId для перемещения задачи */
    newProjectId?: string;
}

export interface CreateProjectInput {
    name: string;
    color?: string;
    viewMode?: string; // 'list' | 'kanban' | 'timeline'
}

// ── Overview types ──────────────────────────────────────────────

export interface TickTickTaskBrief {
    id: string;
    projectId: string;
    title: string;
    priority: number;
    dueDate?: string;
    projectName?: string;
    tags?: string[];
}

export interface TickTickOverviewProjectStat {
    projectId: string;
    projectName: string;
    taskCount: number;
    isInbox: boolean;
}

export interface TickTickOverview {
    totalActiveTasks: number;
    inboxCount: number;
    projects: TickTickOverviewProjectStat[];
    overdue: TickTickTaskBrief[];
    today: TickTickTaskBrief[];
    thisWeek: TickTickTaskBrief[];
    noDateCount: number;
    highPriority: TickTickTaskBrief[];
    upcoming: TickTickTaskBrief[];
    tags: { tag: string; count: number }[];
}

// ── Filter types ────────────────────────────────────────────────

export type TickTickDateFilter = 'today' | 'tomorrow' | 'thisWeek' | 'overdue' | 'noDate';

export interface TickTickFilterOptions {
    projectId?: string;
    dateFilter?: TickTickDateFilter;
    tags?: string[];
    minPriority?: number;
    search?: string;
    limit?: number;
    showCompleted?: boolean;
}

// ============================================================================
// Константы
// ============================================================================

const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';
const TICKTICK_AUTH_URL = 'https://ticktick.com/oauth/authorize';
const TICKTICK_TOKEN_URL = 'https://ticktick.com/oauth/token';

/** Интервал «ленивой» синхронизации — если прошло больше, перед чтением обновляем кэш БД */
const LAZY_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

const PRIORITY_LABELS: Record<number, string> = {
    0: 'нет',
    1: '🔵 низкий',
    3: '🟡 средний',
    5: '🔴 высокий',
};

// ============================================================================
// Service
// ============================================================================

class TickTickService {
    private tokens: TickTickTokens | null = null;
    /** Кешированный ID проекта Inbox */
    private cachedInboxId: string | null = null;
    /** Флаг, чтобы не запускать discovery параллельно */
    private inboxDiscoveryInProgress: boolean = false;
    private clientId: string = '';
    private clientSecret: string = '';
    private redirectUri: string = '';
    /** Callback для автоматического сохранения токенов после refresh */
    private onTokensRefreshed?: (tokens: TickTickTokens) => Promise<void>;
    /** Callback для персистентного сохранения Inbox ID после обнаружения */
    private onInboxDiscovered?: (inboxId: string) => Promise<void>;
    /** Timestamp последней полной синхронизации (для lazy sync) */
    private lastFullSyncAt: number = 0;
    /** Флаг, чтобы не запускать lazy sync параллельно */
    private lazySyncInProgress: boolean = false;

    // ── Инициализация ──────────────────────────────────────────

    initialize(config: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        onTokensRefreshed?: (tokens: TickTickTokens) => Promise<void>;
        onInboxDiscovered?: (inboxId: string) => Promise<void>;
    }): void {
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.redirectUri = config.redirectUri;
        this.onTokensRefreshed = config.onTokensRefreshed;
        this.onInboxDiscovered = config.onInboxDiscovered;
        console.log('[TickTick] ✅ Service initialized');
        diagInfo('ticktick', 'init', 'Service initialized', {
            clientIdPrefix: config.clientId.substring(0, 6),
            redirectUri: config.redirectUri,
        });
    }

    isConfigured(): boolean {
        return !!(this.clientId && this.clientSecret);
    }

    isAuthenticated(): boolean {
        return !!this.tokens?.accessToken;
    }

    // ── OAuth 2.0 ──────────────────────────────────────────────

    /**
     * Получить URL для авторизации пользователя
     */
    getAuthorizationUrl(state?: string): string {
        const params = new URLSearchParams({
            client_id: this.clientId,
            scope: 'tasks:read tasks:write',
            redirect_uri: this.redirectUri,
            response_type: 'code',
            state: state || 'ticktick_oauth',
        });
        return `${TICKTICK_AUTH_URL}?${params.toString()}`;
    }

    /**
     * Обмен authorization code на access token
     */
    async exchangeCodeForToken(code: string): Promise<TickTickTokens> {
        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: this.redirectUri,
            scope: 'tasks:read tasks:write',
        });

        const response = await fetch(TICKTICK_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
            },
            body: body.toString(),
        });

        if (!response.ok) {
            const errorText = await response.text();
            diagError('ticktick', 'oauth_error', `OAuth token exchange failed: ${response.status}`, {
                status: response.status,
                responseBody: errorText.substring(0, 500),
            });
            throw new Error(`TickTick OAuth error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        this.tokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        };

        console.log('[TickTick] ✅ OAuth tokens obtained');
        return this.tokens;
    }

    /**
     * Обновление access token через refresh token
     */
    async refreshAccessToken(): Promise<void> {
        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        const body = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.tokens.refreshToken,
            grant_type: 'refresh_token',
        });

        const response = await fetch(TICKTICK_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
            },
            body: body.toString(),
        });

        if (!response.ok) {
            const errorText = await response.text();
            diagError('ticktick', 'token_refresh_error', `Token refresh failed: ${response.status}`, {
                status: response.status,
                responseBody: errorText.substring(0, 500),
            });
            this.tokens = null;
            throw new Error(`TickTick token refresh failed (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        this.tokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || this.tokens.refreshToken,
            expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        };

        console.log('[TickTick] 🔄 Access token refreshed');

        // Автосохранение токенов в БД после refresh
        if (this.onTokensRefreshed) {
            try {
                await this.onTokensRefreshed(this.tokens);
                console.log('[TickTick] 💾 Tokens auto-saved after refresh');
            } catch (err) {
                console.error('[TickTick] ⚠️ Failed to auto-save tokens:', err);
            }
        }
    }

    /**
     * Установить токены напрямую (восстановление из БД)
     */
    setTokens(tokens: TickTickTokens): void {
        this.tokens = tokens;
        console.log('[TickTick] 🔑 Tokens loaded from storage');
        const isExpired = tokens.expiresAt ? Date.now() > tokens.expiresAt : false;
        diagInfo('ticktick', 'token_load', 'Tokens loaded from storage', {
            hasAccessToken: !!tokens.accessToken,
            hasRefreshToken: !!tokens.refreshToken,
            expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
            isExpired,
        });
    }

    /**
     * Получить текущие токены (для сохранения в БД)
     */
    getTokens(): TickTickTokens | null {
        return this.tokens;
    }

    // ── HTTP helper ────────────────────────────────────────────

    private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (!this.tokens?.accessToken) {
            throw new Error('TickTick не подключён. Пройдите авторизацию через /api/ticktick/auth');
        }

        // Проверяем истечение токена
        if (this.tokens.expiresAt && Date.now() > this.tokens.expiresAt - 60_000) {
            try {
                await this.refreshAccessToken();
            } catch (err) {
                console.error('[TickTick] ⚠️ Token refresh failed:', err);
            }
        }

        const url = `${TICKTICK_API_BASE}${path}`;
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.tokens.accessToken}`,
            'Content-Type': 'application/json',
        };

        const options: RequestInit = { method, headers };
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            options.body = JSON.stringify(body);
        }

        const apiStart = Date.now();
        let response: Response;
        try {
            response = await fetch(url, options);
        } catch (networkErr: any) {
            const durationMs = Date.now() - apiStart;
            diagError('ticktick', 'network_error', `Network error: ${method} ${path}`, {
                method, path, durationMs,
                error: networkErr?.message || String(networkErr),
                code: networkErr?.code,
                cause: networkErr?.cause?.message,
            });
            throw networkErr;
        }
        const durationMs = Date.now() - apiStart;

        // Retry с refresh при 401
        if (response.status === 401 && this.tokens.refreshToken) {
            console.log('[TickTick] 🔄 Got 401, trying token refresh...');
            diagWarn('ticktick', 'api_401', `Got 401, refreshing token: ${method} ${path}`, {
                method, path, durationMs,
            });
            await this.refreshAccessToken();
            headers['Authorization'] = `Bearer ${this.tokens!.accessToken}`;
            const retryResponse = await fetch(url, { method, headers, body: options.body });
            if (!retryResponse.ok) {
                const errText = await retryResponse.text();
                diagError('ticktick', 'api_error', `API error after retry: ${method} ${path}`, {
                    method, path, status: retryResponse.status,
                    responseBody: errText.substring(0, 500),
                });
                throw new Error(`TickTick API error (${retryResponse.status}): ${errText}`);
            }
            // Безопасный парсинг: пустое тело (204 или пустой 200) → {} вместо crash
            if (retryResponse.status === 204) return {} as T;
            const retryText = await retryResponse.text();
            if (!retryText || retryText.trim().length === 0) return {} as T;
            return JSON.parse(retryText) as T;
        }

        if (!response.ok) {
            const errText = await response.text();
            diagError('ticktick', 'api_error', `API error: ${method} ${path} → ${response.status}`, {
                method, path, status: response.status, durationMs,
                responseBody: errText.substring(0, 500),
            });
            throw new Error(`TickTick API error (${response.status}): ${errText}`);
        }

        if (response.status === 204) return {} as T;
        // Безопасный парсинг: пустое тело (напр. /complete возвращает 200 с пустым body)
        const responseText = await response.text();
        if (!responseText || responseText.trim().length === 0) return {} as T;
        return JSON.parse(responseText) as T;
    }

    /**
     * Форматирует дату в формат, который понимает TickTick Open API:
     * "yyyy-MM-dd'T'HH:mm:ss+0000" (обязательно UTC с таким офсетом)
     */
    private formatTickTickDate(dateStr: string | undefined): string | undefined {
        if (!dateStr) return undefined;
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return dateStr;
            // toISOString() возвращает "YYYY-MM-DDTHH:mm:ss.sssZ"
            // Заменяем Z на +0000 для совместимости с TickTick API
            return date.toISOString().replace('Z', '+0000');
        } catch {
            return dateStr;
        }
    }

    // ── Кэширование и синхронизация ────────────────────────────

    /**
     * Безопасное сравнение дат (с учётом null).
     * Считает даты равными, если разница меньше 1 секунды.
     */
    private static datesEqual(a: Date | null, b: Date | null): boolean {
        if (a === null && b === null) return true;
        if (a === null || b === null) return false;
        return Math.abs(a.getTime() - b.getTime()) < 1000;
    }

    /**
     * Синхронизировать одну задачу с локальным кэшем в БД.
     * Обновляет аттрибуты и вызывает пересчёт эмбеддинга, если текст изменился.
     * 
     * Сравнивает ВСЕ ключевые поля (title, content, priority, status, dueDate, tags, items, projectId, parentId),
     * а не только modifiedTime — TickTick API может не обновлять modifiedTime при drag-and-drop
     * изменении даты, что приводило к рассинхронизации dueDate в нашей БД.
     */
    async syncLocalTaskCache(apiTask: TickTickTask): Promise<void> {
        try {
            // Ищем задачу в локальной БД
            const [existing] = await db.select()
                .from(ticktickTasks)
                .where(eq(ticktickTasks.taskId, apiTask.id))
                .limit(1);

            const modifiedDate = apiTask.modifiedTime ? new Date(apiTask.modifiedTime) : null;
            
            // dueDate: используем dueDate из API, fallback на startDate если dueDate отсутствует
            const dueDate = apiTask.dueDate 
                ? new Date(apiTask.dueDate) 
                : apiTask.startDate 
                    ? new Date(apiTask.startDate) 
                    : null;
            
            const newContent = apiTask.content || apiTask.desc || null;
            const newTags = apiTask.tags || [];
            const newItems = apiTask.items || [];
            const newParentId = apiTask.parentId || null;

            // Проверяем, изменились ли ключевые поля
            // (не полагаемся только на modifiedTime — TickTick может не обновлять его при некоторых действиях)
            if (existing) {
                const fieldsUnchanged = 
                    existing.title === apiTask.title
                    && existing.content === newContent
                    && existing.priority === apiTask.priority
                    && existing.status === apiTask.status
                    && existing.projectId === apiTask.projectId
                    && existing.parentId === newParentId
                    && TickTickService.datesEqual(existing.dueDate, dueDate)
                    && JSON.stringify(existing.tags) === JSON.stringify(newTags)
                    && JSON.stringify(existing.items) === JSON.stringify(newItems);

                if (fieldsUnchanged) {
                    // Данные не изменились — обновляем syncedAt, чтобы подтвердить актуальность задачи
                    // (без этого stale-очистка в syncAllProjects удалит задачу как "пропавшую")
                    await db.update(ticktickTasks)
                        .set({ syncedAt: new Date() })
                        .where(eq(ticktickTasks.taskId, apiTask.id));
                    
                    // Проверяем наличие embedding
                    if (!existing.embedding) {
                        await embeddingService.createTickTickTaskEmbedding(
                            existing.id, existing.title, existing.content, existing.items
                        );
                    }
                    return;
                }
            }
            
            const taskRecord: any = {
                taskId: apiTask.id,
                projectId: apiTask.projectId,
                parentId: newParentId,
                title: apiTask.title,
                content: newContent,
                priority: apiTask.priority,
                status: apiTask.status,
                dueDate,
                tags: newTags,
                items: newItems,
                lastModified: modifiedDate,
                syncedAt: new Date(),
            };

            if (existing) {
                // Обновляем
                await db.update(ticktickTasks)
                    .set(taskRecord)
                    .where(eq(ticktickTasks.taskId, apiTask.id));
                
                // Если текст или пункты изменились — пересчитываем эмбеддинг
                const existingItemsStr = JSON.stringify(existing.items);
                const apiItemsStr = JSON.stringify(newItems);
                if (existing.title !== apiTask.title || existing.content !== newContent || existingItemsStr !== apiItemsStr) {
                    await embeddingService.createTickTickTaskEmbedding(existing.id, apiTask.title, newContent, apiTask.items);
                }
                
                // Логируем изменение dueDate для отладки
                if (!TickTickService.datesEqual(existing.dueDate, dueDate)) {
                    console.log(`[TickTick] 📅 dueDate обновлена для "${apiTask.title.slice(0, 50)}": ${existing.dueDate?.toISOString() || 'null'} → ${dueDate?.toISOString() || 'null'}`);
                }
            } else {
                // Создаем новую запись
                const [inserted] = await db.insert(ticktickTasks)
                    .values(taskRecord)
                    .returning({ id: ticktickTasks.id });
                
                // Создаем эмбеддинг для новой задачи
                await embeddingService.createTickTickTaskEmbedding(inserted.id, apiTask.title, newContent, apiTask.items);
            }
        } catch (err) {
            console.error(`[TickTick] ❌ Ошибка синхронизации задачи ${apiTask.id} с БД:`, err);
        }
    }

    /**
     * Синхронизировать массив задач с БД в фоновом режиме.
     * Вызывается из getOverview/getTasksFiltered после получения свежих данных из API,
     * чтобы кэш БД всегда содержал актуальные данные (даты, приоритеты и т.д.).
     * 
     * Не бросает исключений — ошибки логируются и игнорируются.
     */
    private async syncTasksBatch(tasks: TickTickTask[]): Promise<void> {
        if (tasks.length === 0) return;
        let synced = 0;
        for (const task of tasks) {
            try {
                await this.syncLocalTaskCache(task);
                synced++;
            } catch {
                // syncLocalTaskCache уже логирует ошибки — не прерываем batch
            }
        }
        console.log(`[TickTick] 🔄 Batch sync: ${synced}/${tasks.length} задач синхронизировано с БД`);
    }

    /**
     * Синхронизировать все активные задачи проекта с локальной БД (включая удаление удаленных).
     */
    async syncProjectTasks(projectId: string): Promise<void> {
        try {
            console.log(`[TickTick] 🔄 Синхронизация проекта: ${projectId}`);
            const data = await this.getProjectData(projectId);
            const apiTasks = data.tasks || [];

            // 1. Синхронизируем все задачи из API в БД
            for (const task of apiTasks) {
                await this.syncLocalTaskCache(task);
            }

            // 2. Ищем те, что есть в БД, но пропали из API (считаем их удаленными или завершенными в TickTick)
            const apiIds = new Set(apiTasks.map(t => t.id));
            const localTasks = await db.select({ taskId: ticktickTasks.taskId })
                .from(ticktickTasks)
                .where(eq(ticktickTasks.projectId, projectId));
            
            const removedIds = localTasks
                .map(lt => lt.taskId)
                .filter(id => !apiIds.has(id));

            if (removedIds.length > 0) {
                console.log(`[TickTick] 🗑️ Удаление ${removedIds.length} задач из кэша (удалены/завершены в API)`);
                await db.delete(ticktickTasks)
                    .where(and(
                        eq(ticktickTasks.projectId, projectId),
                        sql`task_id IN (${sql.join(removedIds, sql`, `)})`
                    ));
            }
        } catch (err) {
            console.error(`[TickTick] ⚠️ Не удалось синхронизировать проект ${projectId}:`, err);
        }
    }

    /**
     * Глобальная синхронизация всех проектов.
     */
    async syncAllProjects(): Promise<void> {
        const syncStartedAt = new Date();
        try {
            console.log('[TickTick] 🌍 Глобальная синхронизация...');
            const projects = await this.getProjects();
            
            // Собираем все ID проектов, включая Inbox
            const projectIds = projects.map(p => p.id);
            const inboxId = await this.getInboxId();
            if (inboxId && !projectIds.includes(inboxId)) {
                projectIds.push(inboxId);
            }

            // Синхронизируем каждый проект
            for (const id of projectIds) {
                await this.syncProjectTasks(id);
            }
            console.log('[TickTick] ✅ Глобальная синхронизация завершена');

            // Stale-очистка: удаляем задачи, которые не были подтверждены в этом цикле синхронизации.
            // Если задача есть в API — syncLocalTaskCache обновил ей syncedAt.
            // Если задачи нет в API (завершена/удалена в TickTick) — syncedAt остался старым.
            // Используем syncStartedAt минус безопасный буфер (2 минуты) для защиты от гонок.
            try {
                const staleThreshold = new Date(syncStartedAt.getTime() - 2 * 60 * 1000);
                const staleDeleted = await db.delete(ticktickTasks)
                    .where(sql`synced_at < ${staleThreshold}`)
                    .returning({ taskId: ticktickTasks.taskId, title: ticktickTasks.title });
                if (staleDeleted.length > 0) {
                    console.log(`[TickTick] 🗑️ Stale-очистка: удалено ${staleDeleted.length} задач из кэша (не найдены в API):`);
                    for (const s of staleDeleted.slice(0, 5)) {
                        console.log(`  - "${s.title?.slice(0, 60)}" (${s.taskId})`);
                    }
                    if (staleDeleted.length > 5) {
                        console.log(`  ... и ещё ${staleDeleted.length - 5}`);
                    }
                }
            } catch (staleErr) {
                console.error('[TickTick] ⚠️ Stale-очистка не удалась:', staleErr);
            }

            // Обновляем timestamp последней синхронизации
            this.lastFullSyncAt = Date.now();

            // Backfill: создаём эмбеддинги для задач, у которых их нет
            try {
                const backfillResult = await backfillMissingTaskEmbeddings();
                if (backfillResult.total > 0) {
                    console.log(`[TickTick] 🔄 Backfill: создано ${backfillResult.created}/${backfillResult.total} эмбеддингов`);
                }
            } catch (backfillErr) {
                console.error('[TickTick] ⚠️ Backfill эмбеддингов не удался:', backfillErr);
            }

            // После синхронизации задач TickTick — обновляем прогресс активных целей
            const activeGoals = await getActiveGoals();
            if (activeGoals.length > 0) {
                console.log(`[TickTick] 🎯 Запущена синхронизация ${activeGoals.length} активных целей...`);
                for (const goal of activeGoals) {
                    try {
                        await syncGoalWithTickTick(goal.id);
                    } catch (goalSyncErr) {
                        console.error(`[TickTick] ⚠️ Ошибка синхронизации цели #${goal.id}:`, goalSyncErr);
                    }
                }
                console.log('[TickTick] 🎯 Синхронизация целей завершена');
            }
        } catch (err) {
            console.error('[TickTick] ⚠️ Глобальная синхронизация прервана:', err);
        }
    }

    /**
     * Ленивая синхронизация — обновляет кэш БД перед чтением,
     * если с последней полной синхронизации прошло больше LAZY_SYNC_INTERVAL_MS.
     * 
     * Защита от параллельных вызовов: если sync уже идёт, ждём его завершения.
     * Не бросает исключений — при ошибке данные берутся из кэша.
     */
    async ensureFreshCache(): Promise<void> {
        if (!this.isAuthenticated()) return;

        const age = Date.now() - this.lastFullSyncAt;
        if (age < LAZY_SYNC_INTERVAL_MS) return;

        // Если sync уже запущен — ждём его завершения (до 15 сек)
        if (this.lazySyncInProgress) {
            console.log('[TickTick] ⏳ Lazy sync уже выполняется, ожидаем...');
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (!this.lazySyncInProgress) return;
            }
            return;
        }

        this.lazySyncInProgress = true;
        try {
            const ageMin = Math.round(age / 60_000);
            console.log(`[TickTick] 🔄 Lazy sync: кэш устарел (${ageMin} мин), обновляем...`);
            await this.syncAllProjects();
            console.log('[TickTick] ✅ Lazy sync завершён');
        } catch (err) {
            console.error('[TickTick] ⚠️ Lazy sync не удался, используем кэш:', err);
        } finally {
            this.lazySyncInProgress = false;
        }
    }

    // ── Проекты (списки) ───────────────────────────────────────

    /**
     * Получить все проекты (списки), включая Inbox.
     * 
     * ⚠️ TickTick API может вернуть пустой массив при протухшем токене
     * (вместо 401). Поэтому при пустом ответе делаем retry с token refresh.
     */
    async getProjects(): Promise<TickTickProject[]> {
        const projects = await this.apiRequest<TickTickProject[]>('GET', '/project');

        // Guard: TickTick иногда возвращает [] при невалидном токене (без 401)
        if (Array.isArray(projects) && projects.length === 0 && this.tokens?.refreshToken) {
            console.log('[TickTick] ⚠️ getProjects вернул пустой массив — пробуем refresh token...');
            try {
                await this.refreshAccessToken();
                const retryProjects = await this.apiRequest<TickTickProject[]>('GET', '/project');
                console.log(`[TickTick] 🔄 После refresh: ${retryProjects.length} проектов`);
                return retryProjects;
            } catch (err) {
                console.error('[TickTick] ⚠️ Retry после refresh не помог:', err);
            }
        }

        return projects;
    }

    /**
     * Найти ID проекта Inbox.
     * 
     * Стратегия (3 уровня):
     * 1. Кеш — если ID уже был найден ранее (RAM или восстановлен из БД)
     * 2. getProjects() — ищем id.startsWith('inbox') (редко работает: API обычно не возвращает Inbox)
     * 3. Auto-discovery — создаём временную задачу без projectId, берём inboxId из ответа, удаляем задачу
     */
    async getInboxId(): Promise<string | null> {
        // 1. Кеш (RAM)
        if (this.cachedInboxId) return this.cachedInboxId;

        // 2. Поиск в getProjects() — API иногда возвращает Inbox, чаще нет
        try {
            const projects = await this.getProjects();
            const inbox = projects.find(p => p.id.startsWith('inbox') || p.id.toLowerCase().includes('inbox'));
            if (inbox) {
                console.log(`[TickTick] 📥 Inbox найден в getProjects(): ${inbox.id}`);
                await this.persistInboxId(inbox.id);
                return inbox.id;
            }
        } catch (err) {
            console.error('[TickTick] ⚠️ Ошибка getProjects() при поиске Inbox:', err);
        }

        // 3. Auto-discovery — создаём пробную задачу и получаем inboxId из ответа
        console.log('[TickTick] 🔍 Inbox не найден в getProjects(), запускаем auto-discovery...');
        try {
            const discoveredId = await this.discoverInboxId();
            if (discoveredId) return discoveredId;
        } catch (err) {
            console.error('[TickTick] ⚠️ Auto-discovery Inbox не удался:', err);
        }

        console.warn('[TickTick] ❌ Inbox ID не удалось определить ни одним способом');
        return null;
    }

    /**
     * Auto-discovery Inbox ID.
     * 
     * TickTick Open API не возвращает Inbox в GET /project.
     * Единственный надёжный способ: создать задачу без projectId → 
     * TickTick поместит её в Inbox → из ответа берём projectId → удаляем задачу.
     */
    private async discoverInboxId(): Promise<string | null> {
        // Защита от параллельных вызовов
        if (this.inboxDiscoveryInProgress) {
            console.log('[TickTick] ⏳ Discovery уже запущен, ожидаем...');
            // Ждём до 5 секунд, проверяя кеш
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (this.cachedInboxId) return this.cachedInboxId;
            }
            return null;
        }

        this.inboxDiscoveryInProgress = true;
        try {
            // Создаём временную задачу-маркер без projectId
            const probeTask = await this.apiRequest<TickTickTask>('POST', '/task', {
                title: '🔍 _inbox_probe_ (auto-delete)',
                priority: 0,
            });

            if (!probeTask?.projectId) {
                console.error('[TickTick] ⚠️ Пробная задача не вернула projectId');
                return null;
            }

            const inboxId = probeTask.projectId;
            console.log(`[TickTick] ✅ Inbox ID обнаружен через auto-discovery: ${inboxId}`);

            // Удаляем пробную задачу
            try {
                await this.apiRequest<void>('DELETE', `/project/${inboxId}/task/${probeTask.id}`);
                console.log('[TickTick] 🗑️ Пробная задача удалена');
            } catch (deleteErr) {
                console.warn('[TickTick] ⚠️ Не удалось удалить пробную задачу:', deleteErr);
                // Не критично — задача с названием _inbox_probe_ может быть удалена вручную
            }

            // Сохраняем в кеш и персистентно
            await this.persistInboxId(inboxId);
            return inboxId;
        } finally {
            this.inboxDiscoveryInProgress = false;
        }
    }

    /**
     * Сохранить Inbox ID в кеш (RAM) и вызвать callback для сохранения в БД.
     */
    private async persistInboxId(inboxId: string): Promise<void> {
        this.cachedInboxId = inboxId;
        console.log(`[TickTick] 📥 Inbox ID сохранён в кеш: ${inboxId}`);

        if (this.onInboxDiscovered) {
            try {
                await this.onInboxDiscovered(inboxId);
                console.log('[TickTick] 💾 Inbox ID сохранён в БД');
            } catch (err) {
                console.error('[TickTick] ⚠️ Не удалось сохранить Inbox ID в БД:', err);
            }
        }
    }

    /**
     * Установить Inbox ID напрямую (из ответа createTask или из БД при инициализации)
     */
    setInboxId(inboxId: string): void {
        this.cachedInboxId = inboxId;
        console.log(`[TickTick] 📥 Inbox ID загружен: ${inboxId}`);
    }

    /**
     * Получить задачи из Inbox напрямую.
     * Если Inbox ID закеширован — использует его.
     * Если нет — запускает auto-discovery.
     */
    async getInboxTasks(): Promise<{ tasks: TickTickTask[]; inboxId: string | null }> {
        const inboxId = await this.getInboxId();
        if (!inboxId) {
            console.warn('[TickTick] ❌ Inbox ID не найден — невозможно получить задачи. Убедитесь, что TickTick авторизован.');
            return { tasks: [], inboxId: null };
        }

        try {
            const data = await this.getProjectData(inboxId);
            const tasks = data.tasks || [];
            console.log(`[TickTick] 📥 Inbox (${inboxId}): ${tasks.length} задач`);
            return { tasks, inboxId };
        } catch (err) {
            console.error(`[TickTick] ⚠️ Ошибка получения Inbox (${inboxId}):`, err);
            // Может быть inboxId устарел — сбрасываем кеш для повторного discovery
            if (this.cachedInboxId === inboxId) {
                this.cachedInboxId = null;
                console.log('[TickTick] 🔄 Сброс кеша Inbox ID для повторного discovery');
            }
            return { tasks: [], inboxId };
        }
    }

    /**
     * Проверка работоспособности подключения к TickTick API.
     * Возвращает true, если API отвечает и возвращает данные.
     */
    async validateConnection(): Promise<{ ok: boolean; projectCount: number; error?: string }> {
        if (!this.isAuthenticated()) {
            return { ok: false, projectCount: 0, error: 'Не авторизован' };
        }
        try {
            const projects = await this.getProjects();
            return { ok: projects.length > 0, projectCount: projects.length };
        } catch (err: any) {
            return { ok: false, projectCount: 0, error: err?.message || String(err) };
        }
    }

    /**
     * Создать новый проект (список)
     */
    async createProject(input: CreateProjectInput): Promise<TickTickProject> {
        return this.apiRequest<TickTickProject>('POST', '/project', {
            name: input.name,
            color: input.color,
            viewMode: input.viewMode || 'list',
        });
    }

    // ── Задачи ─────────────────────────────────────────────────

    /**
     * Получить все задачи из проекта
     */
    async getProjectData(projectId: string): Promise<TickTickProjectData> {
        return this.apiRequest<TickTickProjectData>('GET', `/project/${projectId}/data`);
    }

    /**
     * Получить задачу по ID
     */
    async getTask(projectId: string, taskId: string): Promise<TickTickTask> {
        return this.apiRequest<TickTickTask>('GET', `/project/${projectId}/task/${taskId}`);
    }

    /**
     * Создать задачу
     */
    async createTask(input: CreateTaskInput): Promise<TickTickTask> {
        const result = await this.apiRequest<TickTickTask>('POST', '/task', {
            title: input.title,
            content: input.content,
            projectId: input.projectId,
            priority: input.priority ?? 0,
            dueDate: this.formatTickTickDate(input.dueDate),
            startDate: this.formatTickTickDate(input.startDate),
            isAllDay: input.isAllDay,
            timeZone: input.timeZone || 'Europe/Moscow',
            tags: input.tags,
            items: input.items?.map((item, idx) => ({
                title: item.title,
                status: item.status ?? 0,
                sortOrder: idx,
            })),
        });

        // Кешируем Inbox ID если задача создана без projectId
        if (!input.projectId && result.projectId?.startsWith('inbox')) {
            await this.persistInboxId(result.projectId);
        }

        // Синхронизируем новую задачу с БД
        await this.syncLocalTaskCache(result);

        return result;
    }

    /**
     * Получить отфильтрованный список задач из одного проекта или всех-всех.
     */
    async getTasksFiltered(options: TickTickFilterOptions): Promise<TickTickTask[]> {
        // Ленивая синхронизация — обновляем кэш БД перед фильтрацией
        await this.ensureFreshCache();

        let tasks: TickTickTask[] = [];

        // 1. Собираем базу задач
        if (options.projectId && options.projectId !== 'all') {
            // Конкретный проект (ID или "inbox" или Название)
            let finalProjectId = options.projectId;
            if (options.projectId.toLowerCase() === 'inbox' || options.projectId.toLowerCase() === 'входящие') {
                const inboxId = await this.getInboxId();
                if (inboxId) finalProjectId = inboxId;
            } else if (!options.projectId.includes('-') && options.projectId.length < 20) {
                // Если projectId похоже на название, а не на ID, попробуем найти ID по названию
                const projects = await this.getProjects();
                const found = projects.find(p => 
                    p.name.toLowerCase() === options.projectId?.toLowerCase() || 
                    p.id === options.projectId
                );
                if (found) finalProjectId = found.id;
            }

            const data = await this.getProjectData(finalProjectId);
            tasks = data.tasks || [];
        } else {
            // ВСЕ задачи (включая Inbox)
            const projects = await this.getProjects();
            const projectLoads: Promise<{ tasks?: TickTickTask[] }>[] = projects.map(p => 
                this.getProjectData(p.id).catch(() => ({ tasks: [] as TickTickTask[] }))
            );
            
            // Плюс явно Inbox (на случай если его нет в списке проектов)
            projectLoads.push(
                this.getInboxTasks()
                    .then(res => ({ tasks: res.tasks || [] as TickTickTask[] }))
                    .catch(() => ({ tasks: [] as TickTickTask[] }))
            );
            
            const results = await Promise.all(projectLoads);
            const seenIds = new Set<string>();
            for (const res of results) {
                if (res.tasks) {
                    for (const t of res.tasks) {
                        if (!seenIds.has(t.id)) {
                            tasks.push(t);
                            seenIds.add(t.id);
                        }
                    }
                }
            }
        }

        // Фоновая синхронизация: обновляем кэш БД свежими данными из API
        // (fire-and-forget — не задерживаем ответ пользователю)
        this.syncTasksBatch(tasks).catch(err =>
            console.error('[TickTick] ⚠️ Batch sync (getTasksFiltered) не удался:', err)
        );

        // 2. ФИЛЬТРАЦИЯ
        
        // Статус (по умолчанию только активные)
        if (!options.showCompleted) {
            tasks = tasks.filter(t => t.status === 0);
        }

        // Дата
        if (options.dateFilter) {
            // Учитываем временную зону пользователя (Москва +3)
            // Эти расчеты помогают правильно сопоставить TickTick dueDate (который часто Z) с локальной датой
            const OFFSET_MS = 3 * 60 * 60 * 1000;
            const nowInMoscow = new Date(Date.now() + OFFSET_MS);
            
            const moscowTodayStart = new Date(nowInMoscow.getFullYear(), nowInMoscow.getMonth(), nowInMoscow.getDate());
            const moscowTodayEnd = new Date(moscowTodayStart.getTime() + 24 * 60 * 60 * 1000);
            const moscowTomorrowEnd = new Date(moscowTodayEnd.getTime() + 24 * 60 * 60 * 1000);
            const moscowWeekEnd = new Date(moscowTodayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

            // Переводим границы обратно в UTC для корректного сравнения с Date (который Z)
            const todayStart = new Date(moscowTodayStart.getTime() - OFFSET_MS);
            const todayEnd = new Date(moscowTodayEnd.getTime() - OFFSET_MS);
            const tomorrowEnd = new Date(moscowTomorrowEnd.getTime() - OFFSET_MS);
            const weekEnd = new Date(moscowWeekEnd.getTime() - OFFSET_MS);

            tasks = tasks.filter(t => {
                if (options.dateFilter === 'noDate') return !t.dueDate;
                if (!t.dueDate) return false;
                
                const due = new Date(t.dueDate);
                switch (options.dateFilter) {
                    case 'today': return due >= todayStart && due < todayEnd;
                    case 'tomorrow': return due >= todayEnd && due < tomorrowEnd;
                    case 'overdue': return due < todayStart;
                    case 'thisWeek': return due >= todayStart && due < weekEnd;
                    default: return true;
                }
            });
        }

        // Теги
        if (options.tags && options.tags.length > 0) {
            const searchTags = options.tags.map(tag => tag.toLowerCase().replace('#', ''));
            tasks = tasks.filter(t => 
                t.tags?.some(tt => searchTags.includes(tt.toLowerCase()))
            );
        }

        // Приоритет
        if (options.minPriority !== undefined) {
          tasks = tasks.filter(t => t.priority >= options.minPriority!);
        }

        // Текст
        if (options.search) {
            const q = options.search.toLowerCase();
            tasks = tasks.filter(t => 
                t.title.toLowerCase().includes(q) || 
                (t.content && t.content.toLowerCase().includes(q))
            );
        }

        // 3. СОРТИРОВКА (ближайшие/важные выше)
        tasks.sort((a, b) => {
            // Приоритет (сначала 5, потом 3...)
            if (b.priority !== a.priority) return b.priority - a.priority;
            // Дата
            if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
            if (a.dueDate) return -1;
            if (b.dueDate) return 1;
            return 0;
        });

        // Лимит
        if (options.limit) {
            tasks = tasks.slice(0, options.limit);
        }

        return tasks;
    }

    /**
     * Обновить задачу (включая перемещение между проектами через newProjectId)
     */
    async updateTask(input: UpdateTaskInput): Promise<TickTickTask> {
        const updateBody: Record<string, unknown> = {
            projectId: input.newProjectId || input.projectId,
        };
        if (input.title !== undefined) updateBody.title = input.title;
        if (input.content !== undefined) updateBody.content = input.content;
        if (input.priority !== undefined) updateBody.priority = input.priority;
        if (input.dueDate !== undefined) updateBody.dueDate = this.formatTickTickDate(input.dueDate);
        if (input.startDate !== undefined) updateBody.startDate = this.formatTickTickDate(input.startDate);
        if (input.isAllDay !== undefined) updateBody.isAllDay = input.isAllDay;
        if (input.tags !== undefined) updateBody.tags = input.tags;
        if (input.items !== undefined) updateBody.items = input.items;

        const result = await this.apiRequest<TickTickTask>('POST', `/task/${input.taskId}`, updateBody);
        
        // Синхронизируем изменения с БД
        await this.syncLocalTaskCache(result);

        return result;
    }

    /**
     * Переместить задачу в другой проект
     */
    async moveTask(taskId: string, fromProjectId: string, toProjectId: string): Promise<TickTickTask> {
        return this.updateTask({ taskId, projectId: fromProjectId, newProjectId: toProjectId });
    }

    /**
     * Завершить задачу
     */
    async completeTask(projectId: string, taskId: string): Promise<void> {
        await this.apiRequest<void>('POST', `/project/${projectId}/task/${taskId}/complete`);
        // Удаляем из кэша активных задач (или обновляем статус)
        await db.delete(ticktickTasks).where(eq(ticktickTasks.taskId, taskId));
    }

    /**
     * Удалить задачу
     */
    async deleteTask(projectId: string, taskId: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `/project/${projectId}/task/${taskId}`);
        // Удаляем из кэша
        await db.delete(ticktickTasks).where(eq(ticktickTasks.taskId, taskId));
    }

    // ── Поиск и подзадачи ──────────────────────────────────────

    async searchTasks(query: string, showCompleted: boolean = false): Promise<TickTickTask[]> {
        const searchTerm = query.toLowerCase().trim();
        if (!searchTerm) return [];

        console.log(`[TickTick] 🔍 Поиск задач: "${query}" (completed=${showCompleted})`);
        
        // 1. Ленивая синхронизация перед поиском (обновляет кэш если устарел)
        await this.ensureFreshCache();

        const taskIdSet = new Set<string>();

        // 2. ILIKE поиск — надёжный, не зависит от embeddings
        try {
            const textSearchQuery = `%${searchTerm}%`;
            const likeResults = await db.select({ taskId: ticktickTasks.taskId })
                .from(ticktickTasks)
                .where(and(
                    sql`(title ILIKE ${textSearchQuery} OR content ILIKE ${textSearchQuery})`,
                    !showCompleted ? eq(ticktickTasks.status, 0) : sql`1=1`
                ))
                .limit(20);
            
            for (const r of likeResults) taskIdSet.add(r.taskId);
            console.log(`[TickTick] 🔍 ILIKE (полная фраза): ${likeResults.length} результатов`);
        } catch (err) {
            console.error('[TickTick] ⚠️ ILIKE search error:', err);
        }

        // 3. Если полная фраза не дала результатов — ищем по отдельным ключевым словам
        if (taskIdSet.size === 0) {
            try {
                const words = searchTerm.split(/\s+/).filter(w => w.length >= 3);
                if (words.length > 1) {
                    // Ищем задачи, содержащие ВСЕ ключевые слова
                    const wordConditions = words.map(w => {
                        const pattern = `%${w}%`;
                        return sql`(title ILIKE ${pattern} OR content ILIKE ${pattern})`;
                    });
                    const keywordResults = await db.select({ taskId: ticktickTasks.taskId })
                        .from(ticktickTasks)
                        .where(and(
                            ...wordConditions,
                            !showCompleted ? eq(ticktickTasks.status, 0) : sql`1=1`
                        ))
                        .limit(20);
                    
                    for (const r of keywordResults) taskIdSet.add(r.taskId);
                    console.log(`[TickTick] 🔍 ILIKE (по словам: ${words.join(', ')}): ${keywordResults.length} результатов`);
                }
            } catch (err) {
                console.error('[TickTick] ⚠️ Keyword search error:', err);
            }
        }

        // 4. Семантический (vector) поиск — дополнительный, если embeddings есть
        if (taskIdSet.size < 5) {
            try {
                const vectorResults = await embeddingService.searchTickTickTasksByQuery(query, 20, 0.35, showCompleted);
                for (const r of vectorResults) {
                    const externalId = (r as any).externalId;
                    if (externalId) taskIdSet.add(externalId);
                }
                console.log(`[TickTick] 🔍 Vector search: ${vectorResults.length} результатов`);
            } catch (err) {
                // Не ломаем поиск, если embeddings недоступны
                console.warn('[TickTick] ⚠️ Vector search unavailable:', (err as any)?.message || err);
            }
        }

        // 5. Получаем полные данные найденных задач из БД
        // Фильтрем по свежести syncedAt — задачи, которые давно не были подтверждены,
        // скорее всего уже завершены/удалены в TickTick, но stale-очистка ещё не прошла
        const freshThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 минут
        const taskIds = Array.from(taskIdSet);
        if (taskIds.length > 0) {
            const dbTasks = await db.select().from(ticktickTasks)
                .where(and(
                    sql`task_id IN (${sql.join(taskIds, sql`, `)})`,
                    sql`synced_at > ${freshThreshold}`
                ));
            
            const staleCount = taskIds.length - dbTasks.length;
            if (staleCount > 0) {
                console.log(`[TickTick] 🔍 searchTasks: отфильтровано ${staleCount} устаревших задач (syncedAt > 30 мин)`);
            }
            
            // Превращаем записи БД обратно в объекты TickTickTask
            return dbTasks.map(record => ({
                id: record.taskId,
                projectId: record.projectId,
                parentId: record.parentId || undefined,
                title: record.title,
                content: record.content || undefined,
                priority: record.priority,
                status: record.status,
                dueDate: record.dueDate?.toISOString(),
                tags: record.tags as string[],
                items: record.items as any[],
                modifiedTime: record.lastModified?.toISOString(),
            }));
        }

        return [];
    }

    /**
     * Добавить элемент чеклиста (подзадачу) к существующей задаче.
     * Получает текущую задачу, добавляет item в массив items, обновляет.
     */
    async addChecklistItem(
        projectId: string, 
        taskId: string, 
        itemTitle: string
    ): Promise<TickTickTask> {
        // Получаем текущую задачу
        const task = await this.getTask(projectId, taskId);
        
        // Формируем новый item
        const existingItems: TickTickChecklistItem[] = task.items || [];
        const newItem: TickTickChecklistItem = {
            title: itemTitle,
            status: 0,
            sortOrder: existingItems.length,
        };

        const updatedItems = [...existingItems, newItem];

        // Обновляем задачу с новым чеклистом
        const updated = await this.updateTask({
            taskId,
            projectId,
            items: updatedItems,
        });

        console.log(`[TickTick] ✅ Подзадача "${itemTitle}" добавлена к "${task.title}" (${updatedItems.length} items)`);
        return updated;
    }

    // ── Обзор (Overview) ───────────────────────────────────────

    /**
     * Получить сводку (overview) по всем задачам TickTick.
     * 
     * Возвращает агрегированную информацию без полного дампа задач:
     * - Количество задач по проектам
     * - Просроченные, на сегодня, на эту неделю, без даты
     * - Топ ближайших задач по дедлайну
     * - Все используемые теги с количеством
     * - Задачи высокого приоритета
     */
    async getOverview(): Promise<TickTickOverview> {
        // Ленивая синхронизация — обновляем кэш БД перед построением overview
        await this.ensureFreshCache();

        // Используем московское время (UTC+3) для корректного определения "сегодня"
        // (аналогично getTasksFiltered)
        const OFFSET_MS = 3 * 60 * 60 * 1000;
        const nowInMoscow = new Date(Date.now() + OFFSET_MS);

        const moscowTodayStart = new Date(nowInMoscow.getFullYear(), nowInMoscow.getMonth(), nowInMoscow.getDate());
        const moscowTodayEnd = new Date(moscowTodayStart.getTime() + 24 * 60 * 60 * 1000);
        const moscowWeekEnd = new Date(moscowTodayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Переводим границы обратно в UTC для корректного сравнения с dueDate (ISO/Z)
        const todayStart = new Date(moscowTodayStart.getTime() - OFFSET_MS);
        const todayEnd = new Date(moscowTodayEnd.getTime() - OFFSET_MS);
        const weekEnd = new Date(moscowWeekEnd.getTime() - OFFSET_MS);

        const allTasks: TickTickTask[] = [];
        const projectStats: TickTickOverviewProjectStat[] = [];

        // 1. Собираем задачи из всех проектов
        const projects = await this.getProjects();
        for (const project of projects) {
            try {
                const data = await this.getProjectData(project.id);
                const tasks = (data.tasks || []).filter(t => t.status !== 2); // только активные
                tasks.forEach(t => t._projectName = project.name);
                allTasks.push(...tasks);
                projectStats.push({
                    projectId: project.id,
                    projectName: project.name,
                    taskCount: tasks.length,
                    isInbox: project.id.startsWith('inbox'),
                });
            } catch {
                // Пропускаем проекты с ошибками
            }
        }

        // 2. Inbox
        let inboxTaskCount = 0;
        try {
            const inbox = await this.getInboxTasks();
            if (inbox.tasks?.length) {
                const inboxActiveTasks = inbox.tasks.filter(t => t.status !== 2);
                inboxActiveTasks.forEach(t => t._projectName = 'Входящие (Inbox)');
                // Добавляем только если задач ещё нет (могли попасть из getProjects)
                const existingIds = new Set(allTasks.map(t => t.id));
                const newInboxTasks = inboxActiveTasks.filter(t => !existingIds.has(t.id));
                allTasks.push(...newInboxTasks);
                inboxTaskCount = inboxActiveTasks.length;

                // Добавляем Inbox в статистику если его там нет
                if (!projectStats.some(p => p.isInbox)) {
                    projectStats.unshift({
                        projectId: inbox.inboxId || 'inbox',
                        projectName: 'Входящие (Inbox)',
                        taskCount: inboxActiveTasks.length,
                        isInbox: true,
                    });
                }
            }
        } catch {
            // Продолжаем
        }

        // Фоновая синхронизация: обновляем кэш БД свежими данными из API
        // (fire-and-forget — не задерживаем ответ пользователю)
        this.syncTasksBatch(allTasks).catch(err =>
            console.error('[TickTick] ⚠️ Batch sync (getOverview) не удался:', err)
        );

        // 3. Анализ задач
        const overdue: TickTickTask[] = [];
        const today: TickTickTask[] = [];
        const thisWeek: TickTickTask[] = [];
        const noDate: TickTickTask[] = [];
        const highPriority: TickTickTask[] = [];
        const tagCounts = new Map<string, number>();

        for (const task of allTasks) {
            // Приоритет
            if (task.priority >= 5) highPriority.push(task);

            // Теги
            if (task.tags?.length) {
                for (const tag of task.tags) {
                    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
                }
            }

            // Даты
            if (!task.dueDate) {
                noDate.push(task);
                continue;
            }

            const due = new Date(task.dueDate);
            if (due < todayStart) {
                overdue.push(task);
            } else if (due < todayEnd) {
                today.push(task);
            } else if (due < weekEnd) {
                thisWeek.push(task);
            }
        }

        // 4. Топ ближайших по дедлайну (из непросроченных)
        const upcoming = allTasks
            .filter(t => t.dueDate && new Date(t.dueDate) >= todayStart)
            .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
            .slice(0, 7);

        // 5. Теги в отсортированном виде
        const tags = Array.from(tagCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));

        const overview: TickTickOverview = {
            totalActiveTasks: allTasks.length,
            inboxCount: inboxTaskCount,
            projects: projectStats.sort((a, b) => b.taskCount - a.taskCount),
            overdue: overdue.map(t => this.taskBrief(t)),
            today: today.map(t => this.taskBrief(t)),
            thisWeek: thisWeek.map(t => this.taskBrief(t)),
            noDateCount: noDate.length,
            highPriority: highPriority.map(t => this.taskBrief(t)),
            upcoming: upcoming.map(t => this.taskBrief(t)),
            tags,
        };

        console.log(`[TickTick] 📊 Overview: ${allTasks.length} задач, ${overdue.length} просрочено, ${today.length} на сегодня`);
        return overview;
    }

    /**
     * Краткая сводка задачи (для overview — без полного дампа)
     */
    private taskBrief(task: TickTickTask): TickTickTaskBrief {
        return {
            id: task.id,
            projectId: task.projectId,
            title: task.title,
            priority: task.priority,
            dueDate: task.dueDate,
            projectName: task._projectName,
            tags: task.tags,
        };
    }

    /**
     * Форматировать overview для отображения агентом
     */
    formatOverview(ov: TickTickOverview): string {
        const lines: string[] = [];

        lines.push(`📊 **Обзор задач TickTick** (${ov.totalActiveTasks} активных)\n`);

        // Срочные секции
        if (ov.overdue.length > 0) {
            lines.push(`🔴 **Просрочено (${ov.overdue.length}):**`);
            ov.overdue.forEach(t => lines.push(`  - ${this.briefLine(t)}`));
            lines.push('');
        }

        if (ov.today.length > 0) {
            lines.push(`📅 **На сегодня (${ov.today.length}):**`);
            ov.today.forEach(t => lines.push(`  - ${this.briefLine(t)}`));
            lines.push('');
        }

        if (ov.highPriority.length > 0) {
            lines.push(`🔴 **Высокий приоритет (${ov.highPriority.length}):**`);
            ov.highPriority.forEach(t => lines.push(`  - ${this.briefLine(t)}`));
            lines.push('');
        }

        // Проекты
        lines.push(`📂 **Проекты:**`);
        ov.projects.forEach(p => {
            const icon = p.isInbox ? '📥' : '📁';
            lines.push(`  ${icon} ${p.projectName}: ${p.taskCount} задач`);
        });
        lines.push('');

        // На неделю
        if (ov.thisWeek.length > 0) {
            lines.push(`📆 **На этой неделе (${ov.thisWeek.length}):**`);
            ov.thisWeek.forEach(t => lines.push(`  - ${this.briefLine(t)}`));
            lines.push('');
        }

        // Ближайшие
        if (ov.upcoming.length > 0) {
            lines.push(`⏰ **Ближайшие по дедлайну:**`);
            ov.upcoming.forEach(t => lines.push(`  - ${this.briefLine(t)}`));
            lines.push('');
        }

        // Без даты
        if (ov.noDateCount > 0) {
            lines.push(`📌 Без установленного срока: ${ov.noDateCount} задач`);
        }

        // Теги
        if (ov.tags.length > 0) {
            lines.push(`\n🏷️ **Теги:** ${ov.tags.map(t => `${t.tag} (${t.count})`).join(', ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Краткая строка задачи для overview
     */
    private briefLine(t: TickTickTaskBrief): string {
        const prio = t.priority >= 5 ? '🔴 ' : t.priority >= 3 ? '🟡 ' : '';
        const date = t.dueDate ? ` → ${new Date(t.dueDate).toLocaleDateString('ru-RU')}` : '';
        const proj = t.projectName ? ` [${t.projectName}]` : '';
        const idTag = ` <!-- id: ${t.id} | proj: ${t.projectId} -->`;
        return `${prio}**${t.title}**${date}${proj}${idTag}`;
    }

    /**
     * Форматировать задачу для отображения в ассистенте
     */
    formatTask(task: TickTickTask): string {
        const priorityLabel = PRIORITY_LABELS[task.priority] || `p${task.priority}`;
        const status = task.status === 2 ? '✅' : '⬜';
        const projectTag = task._projectName ? ` [📂 ${task._projectName}]` : '';
        // Добавляем скрытый блок с ID для агента (пользователь его скорее всего не заметит или он сольется с форматированием)
        const idTag = ` <!-- id: ${task.id} | proj: ${task.projectId} -->`;
        
        const parts = [`${status} **${task.title}**${projectTag}${idTag}`];
        if (task.priority > 0) parts.push(`  Приоритет: ${priorityLabel}`);
        if (task.dueDate) {
            const date = new Date(task.dueDate);
            parts.push(`  Срок: ${date.toLocaleDateString('ru-RU')} ${task.isAllDay ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
        }
        if (task.content) parts.push(`  📝 ${task.content}`);
        if (task.tags?.length) parts.push(`  🏷️ ${task.tags.join(', ')}`);
        if (task.items?.length) {
            const done = task.items.filter(i => i.status === 1).length;
            parts.push(`  📋 Подзадачи (${done}/${task.items.length}):`);
            task.items.forEach(item => {
                const itemStatus = item.status === 1 ? '✅' : '⬜';
                parts.push(`    ${itemStatus} ${item.title}`);
            });
        }

        return parts.join('\n');
    }

    /**
     * Форматировать список задач с учетом иерархии (parentId)
     */
    formatTaskList(tasks: TickTickTask[], projectName?: string): string {
        if (tasks.length === 0) {
            return projectName
                ? `В проекте «${projectName}» нет задач.`
                : 'Задач не найдено.';
        }

        const header = projectName
            ? `📋 **Задачи в «${projectName}»** (${tasks.length}):\n\n`
            : `📋 **Задачи** (${tasks.length}):\n\n`;

        // Строим дерево
        const taskMap = new Map<string, TickTickTask>();
        const roots: TickTickTask[] = [];
        const children = new Map<string, TickTickTask[]>();

        tasks.forEach(t => taskMap.set(t.id, t));
        
        tasks.forEach(task => {
            if (task.parentId && taskMap.has(task.parentId)) {
                const list = children.get(task.parentId) || [];
                list.push(task);
                children.set(task.parentId, list);
            } else {
                roots.push(task);
            }
        });

        // Рекурсивный вывод дерева
        const renderTree = (task: TickTickTask, level: number = 0, index?: number): string => {
            const indent = '  '.repeat(level);
            const prefix = index !== undefined ? `${index + 1}. ` : '';
            
            // Если это дочерняя задача, мы форматируем её упрощенно или через базовый formatTask
            const taskStr = this.formatTask(task);
            const taskLines = taskStr.split('\n');
            
            // Добавляем отступ ко всем строкам задачи
            const formattedTask = taskLines.map((line, i) => {
                if (i === 0) return `${indent}${prefix}${line}`;
                return `${indent}   ${line}`;
            }).join('\n');

            const subTasks = children.get(task.id) || [];
            if (subTasks.length === 0) return formattedTask;

            const renderedChildren = subTasks
                .map(child => renderTree(child, level + 1))
                .join('\n\n');

            return `${formattedTask}\n${renderedChildren}`;
        };

        return header + roots.map((task, i) => renderTree(task, 0, i)).join('\n\n');
    }

    /**
     * Форматировать список проектов
     */
    formatProjectList(projects: TickTickProject[]): string {
        if (projects.length === 0) return 'Проектов не найдено.';

        const lines = projects.map((p, i) => {
            const isInbox = p.id.startsWith('inbox');
            const icon = isInbox ? '📥' : '📁';
            const label = isInbox ? `${p.name} (Входящие)` : p.name;
            const closed = p.closed ? ' [архив]' : '';
            return `${i + 1}. ${icon} **${label}**${closed} (id: \`${p.id}\`)`;
        });

        return `📂 **Проекты TickTick** (${projects.length}):\n\n${lines.join('\n')}`;
    }
}

// Singleton
export const tickTickService = new TickTickService();
