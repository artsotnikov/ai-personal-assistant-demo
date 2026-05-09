/**
 * API Health Monitor — Отслеживание здоровья AI-провайдеров
 * 
 * Назначение:
 * - Предотвращение бесконечного спама запросами при устойчивых сбоях (429, 403)
 * - Экспоненциальный backoff: пауза 5 мин → 10 → 20 → 40 → ... до 6 часов
 * - Глобальная блокировка фоновых задач при недоступности провайдера
 * - WebSocket-уведомление пользователя о проблемах с API
 * 
 * Использование:
 *   import { apiHealth } from './apiHealthMonitor';
 *   
 *   if (!apiHealth.isHealthy('antigravity')) { return; }  // early exit в фоновых задачах
 *   apiHealth.recordError('antigravity', 429, 'All accounts exhausted');
 *   apiHealth.recordSuccess('antigravity');
 */

export type AIProviderName = 'antigravity' | 'openai' | 'openrouter' | 'deepseek' | 'custom';

/** Категоризация ошибок API */
export type ErrorSeverity = 'transient' | 'persistent' | 'fatal';

interface ProviderHealthState {
    /** Провайдер */
    provider: AIProviderName;
    /** Количество ошибок подряд (сбрасывается при успехе) */
    consecutiveErrors: number;
    /** Время последней ошибки */
    lastErrorAt: number;
    /** Время до которого провайдер заблокирован (backoff) */
    pausedUntil: number;
    /** Последнее сообщение об ошибке */
    lastErrorMessage: string;
    /** Тяжесть последней ошибки */
    lastErrorSeverity: ErrorSeverity;
    /** HTTP-код последней ошибки */
    lastHttpStatus: number | null;
    /** Время последнего успешного вызова */
    lastSuccessAt: number;
    /** Было ли отправлено уведомление пользователю */
    userNotified: boolean;
    /** Время последнего уведомления (для cooldown) */
    lastNotifiedAt: number;
}

// ── Настройки ──

/** Минимальная пауза при ошибке (5 минут) */
const MIN_PAUSE_MS = 5 * 60 * 1000;

/** Максимальная пауза (6 часов) */
const MAX_PAUSE_MS = 6 * 60 * 60 * 1000;

/** Множитель для экспоненциального backoff */
const BACKOFF_MULTIPLIER = 2;

/** После скольких ошибок подряд начинать паузу */
const PAUSE_AFTER_ERRORS = 2;

/** Cooldown между уведомлениями пользователю (6 часов) */
const NOTIFICATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** HTTP-коды, которые считаются "fatal" (аккаунт заблокирован, нет доступа) */
const FATAL_HTTP_CODES = new Set([403, 401]);

/** HTTP-коды, которые считаются "persistent" (rate limit, все аккаунты исчерпаны) */
const PERSISTENT_HTTP_CODES = new Set([429, 503]);

// ── Внутреннее состояние ──

const healthStates = new Map<AIProviderName, ProviderHealthState>();

/** WebSocket broadcast callback (устанавливается из routes.ts) */
let wsBroadcast: ((event: string, data: any) => void) | null = null;

/**
 * Установить функцию для отправки WebSocket событий
 */
export function setWsBroadcast(fn: (event: string, data: any) => void): void {
    wsBroadcast = fn;
}

/**
 * Получить или создать состояние провайдера
 */
function getState(provider: AIProviderName): ProviderHealthState {
    let state = healthStates.get(provider);
    if (!state) {
        state = {
            provider,
            consecutiveErrors: 0,
            lastErrorAt: 0,
            pausedUntil: 0,
            lastErrorMessage: '',
            lastErrorSeverity: 'transient',
            lastHttpStatus: null,
            lastSuccessAt: 0,
            userNotified: false,
            lastNotifiedAt: 0,
        };
        healthStates.set(provider, state);
    }
    return state;
}

/**
 * Классифицировать ошибку по тяжести
 */
function classifyError(httpStatus: number | null, errorMessage: string): ErrorSeverity {
    // Fatal: аккаунт заблокирован, нет авторизации
    if (httpStatus && FATAL_HTTP_CODES.has(httpStatus)) return 'fatal';
    
    // Persistent: rate limit, сервис перегружен
    if (httpStatus && PERSISTENT_HTTP_CODES.has(httpStatus)) return 'persistent';
    
    // Парсим текст ошибки: Antigravity-Manager возвращает 429 с текстом о 403
    const msg = errorMessage.toLowerCase();
    if (msg.includes('permission_denied') || msg.includes('disabled') || msg.includes('violation')) {
        return 'fatal';
    }
    if (msg.includes('all accounts exhausted')) {
        return 'fatal'; // Все аккаунты выбиты — повторять бесполезно
    }
    if (msg.includes('rate limit') || msg.includes('too many requests')) {
        return 'persistent';
    }
    
    return 'transient';
}

/**
 * Рассчитать время паузы на основе количества ошибок и тяжести
 */
function calculatePauseDuration(consecutiveErrors: number, severity: ErrorSeverity): number {
    if (consecutiveErrors < PAUSE_AFTER_ERRORS) return 0;
    
    const errorIndex = consecutiveErrors - PAUSE_AFTER_ERRORS;
    let basePause = MIN_PAUSE_MS;
    
    // Fatal ошибки — сразу длинная пауза
    if (severity === 'fatal') {
        basePause = 30 * 60 * 1000; // 30 минут минимум для fatal
    }
    
    // Экспоненциальный backoff: base * 2^index, но не больше MAX
    const pause = Math.min(
        basePause * Math.pow(BACKOFF_MULTIPLIER, errorIndex),
        MAX_PAUSE_MS
    );
    
    return pause;
}

/**
 * Форматировать длительность паузы для логов
 */
function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}с`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}мин`;
    return `${(ms / 3600_000).toFixed(1)}ч`;
}

// ── Публичный API ──

export const apiHealth = {
    /**
     * Проверить, здоров ли провайдер (можно ли отправлять запросы)
     * 
     * Для пользовательских запросов (interactive) — всегда возвращает true
     * (пусть пользователь видит ошибку). Для фоновых — блокирует.
     */
    isHealthy(provider: AIProviderName, isBackground = true): boolean {
        const state = getState(provider);
        
        // Если пауза не истекла — провайдер unhealthy
        if (state.pausedUntil > Date.now()) {
            if (isBackground) {
                return false;
            }
            // Для пользовательских запросов — пропускаем, но предупреждаем
            console.warn(`[APIHealth] ⚠️ ${provider} на паузе, но пропускаем пользовательский запрос`);
            return true;
        }
        
        // Пауза истекла — провайдер доступен (пробуем)
        return true;
    },
    
    /**
     * Записать успешный вызов — сбросить счётчик ошибок
     */
    recordSuccess(provider: AIProviderName): void {
        const state = getState(provider);
        
        if (state.consecutiveErrors > 0 || state.pausedUntil > Date.now()) {
            console.log(
                `[APIHealth] ✅ ${provider} восстановлен: было ${state.consecutiveErrors} ошибок подряд`
            );
            
            // Уведомляем фронтенд о восстановлении
            if (state.userNotified && wsBroadcast) {
                wsBroadcast('api_health_changed', {
                    provider,
                    status: 'healthy',
                    message: `Провайдер ${provider} восстановил работу`,
                });
                state.userNotified = false;
            }
        }
        
        state.consecutiveErrors = 0;
        state.lastSuccessAt = Date.now();
        state.pausedUntil = 0;
        state.lastErrorSeverity = 'transient';
    },
    
    /**
     * Записать ошибку — обновить состояние, рассчитать backoff
     * 
     * @param provider - имя провайдера
     * @param httpStatus - HTTP-код ответа (429, 403, 500, null = неизвестно)
     * @param errorMessage - текст ошибки
     * @returns severity — тяжесть ошибки
     */
    recordError(provider: AIProviderName, httpStatus: number | null, errorMessage: string): ErrorSeverity {
        const state = getState(provider);
        
        state.consecutiveErrors++;
        state.lastErrorAt = Date.now();
        state.lastErrorMessage = errorMessage;
        state.lastHttpStatus = httpStatus;
        
        const severity = classifyError(httpStatus, errorMessage);
        state.lastErrorSeverity = severity;
        
        // Рассчитываем паузу
        const pauseMs = calculatePauseDuration(state.consecutiveErrors, severity);
        
        if (pauseMs > 0) {
            state.pausedUntil = Date.now() + pauseMs;
            const pauseStr = formatDuration(pauseMs);
            
            console.error(
                `[APIHealth] 🔴 ${provider} PAUSED ${pauseStr}:`,
                `${state.consecutiveErrors} ошибок подряд,`,
                `severity=${severity},`,
                `httpStatus=${httpStatus},`,
                `error="${errorMessage.substring(0, 100)}"`
            );
            
            // Уведомляем пользователя (с cooldown)
            if (
                wsBroadcast &&
                !state.userNotified &&
                (Date.now() - state.lastNotifiedAt > NOTIFICATION_COOLDOWN_MS)
            ) {
                const userMessage = severity === 'fatal'
                    ? `⛔ Провайдер ${provider} заблокирован. Фоновые AI-задачи приостановлены на ${pauseStr}. Причина: ${errorMessage.substring(0, 200)}`
                    : `⚠️ Провайдер ${provider} временно недоступен. Фоновые задачи приостановлены на ${pauseStr}.`;
                
                wsBroadcast('api_health_changed', {
                    provider,
                    status: severity === 'fatal' ? 'blocked' : 'degraded',
                    message: userMessage,
                    pausedUntil: state.pausedUntil,
                    consecutiveErrors: state.consecutiveErrors,
                    severity,
                });
                
                state.userNotified = true;
                state.lastNotifiedAt = Date.now();
            }
        } else {
            console.warn(
                `[APIHealth] ⚠️ ${provider}: ошибка ${state.consecutiveErrors}/${PAUSE_AFTER_ERRORS}`,
                `(severity=${severity}, httpStatus=${httpStatus})`
            );
        }
        
        return severity;
    },
    
    /**
     * Получить состояние здоровья всех провайдеров (для API/UI)
     */
    getStatus(): Record<AIProviderName, {
        healthy: boolean;
        consecutiveErrors: number;
        pausedUntil: number;
        pauseRemaining: string | null;
        lastError: string;
        lastErrorSeverity: ErrorSeverity;
        lastSuccessAt: number;
    }> {
        const result: any = {};
        const providers: AIProviderName[] = ['antigravity', 'openai', 'openrouter', 'deepseek', 'custom'];
        
        for (const provider of providers) {
            const state = getState(provider);
            const now = Date.now();
            const isPaused = state.pausedUntil > now;
            
            result[provider] = {
                healthy: !isPaused,
                consecutiveErrors: state.consecutiveErrors,
                pausedUntil: state.pausedUntil,
                pauseRemaining: isPaused ? formatDuration(state.pausedUntil - now) : null,
                lastError: state.lastErrorMessage,
                lastErrorSeverity: state.lastErrorSeverity,
                lastSuccessAt: state.lastSuccessAt,
            };
        }
        
        return result;
    },
    
    /**
     * Проверить, доступен ли хотя бы один AI-провайдер для фоновых задач
     */
    isAnyProviderHealthy(): boolean {
        const providers: AIProviderName[] = ['antigravity', 'openai', 'openrouter', 'deepseek', 'custom'];
        return providers.some(p => this.isHealthy(p, true));
    },
    
    /**
     * Принудительно разблокировать провайдер (manual override)
     */
    reset(provider: AIProviderName): void {
        const state = getState(provider);
        state.consecutiveErrors = 0;
        state.pausedUntil = 0;
        state.userNotified = false;
        state.lastErrorSeverity = 'transient';
        console.log(`[APIHealth] 🔄 ${provider} принудительно разблокирован`);
    },
    
    /**
     * Сбросить все состояния (при рестарте сервера)
     */
    resetAll(): void {
        healthStates.clear();
        console.log('[APIHealth] 🔄 Все состояния сброшены');
    },
};
