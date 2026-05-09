/**
 * Model Health Tracker — In-memory трекинг здоровья AI-моделей
 * 
 * Отслеживает здоровье каждой конкретной модели (не провайдера!).
 * При ошибках ставит модель на cooldown с экспоненциальным backoff,
 * позволяя cascade пропускать unhealthy модели.
 * 
 * Особенности:
 * - In-memory: при рестарте сервера всё сбрасывается (это ОК)
 * - Cooldown: min(30s * 2^errors, 10min); при ≥5 ошибок → 30 мин
 * - Периодическое восстановление: cooldown'ы автоматически истекают
 * - Не конфликтует с apiHealthMonitor (тот работает на уровне провайдера)
 * 
 * Использование:
 *   import { modelHealth } from './modelHealthTracker';
 *   
 *   if (!modelHealth.isHealthy('gemini-3-flash')) { skip... }
 *   modelHealth.recordSuccess('gemini-3-flash', 1500);
 *   modelHealth.recordError('gemini-3-flash', new Error('500'));
 *   const best = modelHealth.getBestModel(['gemini-3-flash', 'deepseek-chat']);
 */

// ── Типы ──

interface ModelHealthState {
    /** ID модели (provider/model или просто model) */
    modelId: string;
    /** Время последнего успешного вызова */
    lastSuccessAt: number;
    /** Время последней ошибки */
    lastErrorAt: number;
    /** Количество ошибок подряд (сбрасывается при успехе) */
    consecutiveErrors: number;
    /** Скользящая средняя latency (мс) */
    avgLatencyMs: number;
    /** Количество замеров latency (для расчёта скользящей средней) */
    latencySamples: number;
    /** Время, до которого модель на cooldown */
    cooldownUntil: number;
    /** Описание последней ошибки */
    lastErrorMessage: string;
}

// ── Настройки ──

/** Базовая задержка cooldown (30 секунд) */
const BASE_COOLDOWN_MS = 30_000;

/** Максимальный cooldown для < 5 ошибок (10 минут) */
const MAX_COOLDOWN_MS = 10 * 60 * 1000;

/** Расширенный cooldown при >= 5 ошибок подряд (30 минут) */
const EXTENDED_COOLDOWN_MS = 30 * 60 * 1000;

/** Порог ошибок для расширенного cooldown */
const EXTENDED_COOLDOWN_THRESHOLD = 5;

/** Максимальное количество замеров для скользящей средней latency */
const MAX_LATENCY_SAMPLES = 20;

/** Интервал периодической проверки cooldown'ов (5 минут) */
const RECOVERY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ── Внутреннее состояние ──

const healthStates = new Map<string, ModelHealthState>();

/** Таймер периодической проверки */
let recoveryInterval: ReturnType<typeof setInterval> | null = null;

// ── Вспомогательные функции ──

/**
 * Получить или создать состояние модели
 */
function getState(modelId: string): ModelHealthState {
    let state = healthStates.get(modelId);
    if (!state) {
        state = {
            modelId,
            lastSuccessAt: 0,
            lastErrorAt: 0,
            consecutiveErrors: 0,
            avgLatencyMs: 0,
            latencySamples: 0,
            cooldownUntil: 0,
            lastErrorMessage: '',
        };
        healthStates.set(modelId, state);
    }
    return state;
}

/**
 * Рассчитать cooldown на основе количества ошибок подряд
 * 
 * Формула: min(30s * 2^errors, 10min)
 * При >= 5 ошибок: 30 мин
 */
function calculateCooldown(consecutiveErrors: number): number {
    if (consecutiveErrors <= 0) return 0;
    
    if (consecutiveErrors >= EXTENDED_COOLDOWN_THRESHOLD) {
        return EXTENDED_COOLDOWN_MS;
    }
    
    // Экспоненциальный backoff: 30s * 2^(errors-1)
    // 1 ошибка: 30s, 2: 60s, 3: 120s, 4: 240s (4 мин)
    const cooldown = BASE_COOLDOWN_MS * Math.pow(2, consecutiveErrors - 1);
    return Math.min(cooldown, MAX_COOLDOWN_MS);
}

/**
 * Форматировать длительность для логов
 */
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}мс`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}с`;
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}мин`;
    return `${(ms / 3600_000).toFixed(1)}ч`;
}

/**
 * Нормализовать ID модели: объединяет provider/model для уникальности
 */
function normalizeModelId(providerOrModelId: string, model?: string): string {
    if (model) {
        return `${providerOrModelId}/${model}`;
    }
    return providerOrModelId;
}

// ── Публичный API ──

export const modelHealth = {
    /**
     * Записать успешный вызов — сбросить ошибки, обновить latency
     * 
     * @param modelId - ID модели (или provider)
     * @param latencyMs - время ответа в мс
     * @param model - если передан, формирует составной ID: provider/model
     */
    recordSuccess(modelId: string, latencyMs: number, model?: string): void {
        const id = normalizeModelId(modelId, model);
        const state = getState(id);
        
        const wasCooldown = state.cooldownUntil > Date.now();
        const previousErrors = state.consecutiveErrors;
        
        // Обновляем скользящую среднюю latency
        if (state.latencySamples < MAX_LATENCY_SAMPLES) {
            state.latencySamples++;
            state.avgLatencyMs = 
                state.avgLatencyMs + (latencyMs - state.avgLatencyMs) / state.latencySamples;
        } else {
            // Exponential moving average для стабильных замеров
            const alpha = 0.1;
            state.avgLatencyMs = state.avgLatencyMs * (1 - alpha) + latencyMs * alpha;
        }
        
        // Сбрасываем ошибки
        state.consecutiveErrors = 0;
        state.cooldownUntil = 0;
        state.lastSuccessAt = Date.now();
        
        if (wasCooldown || previousErrors > 0) {
            console.log(
                `⚡ [ModelHealth] ${id} восстановлена` +
                `${previousErrors > 0 ? ` (было ${previousErrors} ошибок)` : ''}` +
                `, latency=${latencyMs}мс, avg=${Math.round(state.avgLatencyMs)}мс`
            );
        }
    },
    
    /**
     * Записать ошибку — инкремент ошибок, установить cooldown
     * 
     * @param modelId - ID модели (или provider)
     * @param error - объект ошибки
     * @param model - если передан, формирует составной ID: provider/model
     */
    recordError(modelId: string, error: Error | string, model?: string): void {
        const id = normalizeModelId(modelId, model);
        const state = getState(id);
        
        state.consecutiveErrors++;
        state.lastErrorAt = Date.now();
        state.lastErrorMessage = typeof error === 'string' ? error : (error?.message || String(error));
        
        const cooldownMs = calculateCooldown(state.consecutiveErrors);
        state.cooldownUntil = Date.now() + cooldownMs;
        
        const cooldownStr = formatDuration(cooldownMs);
        const isExtended = state.consecutiveErrors >= EXTENDED_COOLDOWN_THRESHOLD;
        
        console.warn(
            `⚡ [ModelHealth] ${id} помечена unhealthy` +
            ` (ошибок: ${state.consecutiveErrors}, cooldown до: ${new Date(state.cooldownUntil).toLocaleTimeString('ru-RU')},` +
            ` ${cooldownStr}${isExtended ? ' [EXTENDED]' : ''})` +
            ` | ${state.lastErrorMessage.substring(0, 150)}`
        );
    },
    
    /**
     * Проверить, здорова ли модель (нет cooldown, ошибки < порога)
     * 
     * @param modelId - ID модели (или provider)
     * @param model - если передан, формирует составной ID: provider/model
     */
    isHealthy(modelId: string, model?: string): boolean {
        const id = normalizeModelId(modelId, model);
        const state = healthStates.get(id);
        
        // Неизвестная модель — считаем healthy
        if (!state) return true;
        
        // Cooldown ещё не истёк
        if (state.cooldownUntil > Date.now()) {
            return false;
        }
        
        // Cooldown истёк — модель может быть повторно использована
        return true;
    },
    
    /**
     * Выбрать лучшую модель из списка кандидатов
     * 
     * Приоритеты:
     * 1. Только healthy модели
     * 2. Среди healthy — с меньшим количеством ошибок
     * 3. При прочих равных — с меньшей latency
     * 
     * Если все модели unhealthy — возвращает ту, чей cooldown истечёт раньше
     * 
     * @param candidates - массив ID моделей (в формате "provider/model" или просто modelId)
     * @returns ID лучшей модели или первый кандидат, если все unhealthy
     */
    getBestModel(candidates: string[]): string | null {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];
        
        const now = Date.now();
        const healthy: Array<{ id: string; state: ModelHealthState }> = [];
        const unhealthy: Array<{ id: string; state: ModelHealthState }> = [];
        
        for (const id of candidates) {
            const state = healthStates.get(id);
            if (!state || state.cooldownUntil <= now) {
                healthy.push({ id, state: state || getState(id) });
            } else {
                unhealthy.push({ id, state });
            }
        }
        
        // Есть healthy модели — выбираем лучшую
        if (healthy.length > 0) {
            // Сортируем: меньше ошибок → меньше latency
            healthy.sort((a, b) => {
                // Приоритет: 0 ошибок лучше любого количества
                if (a.state.consecutiveErrors !== b.state.consecutiveErrors) {
                    return a.state.consecutiveErrors - b.state.consecutiveErrors;
                }
                // При равных ошибках — меньшая latency
                if (a.state.avgLatencyMs && b.state.avgLatencyMs) {
                    return a.state.avgLatencyMs - b.state.avgLatencyMs;
                }
                return 0;
            });
            return healthy[0].id;
        }
        
        // Все unhealthy — возвращаем ту, чей cooldown истечёт раньше
        unhealthy.sort((a, b) => a.state.cooldownUntil - b.state.cooldownUntil);
        
        const soonest = unhealthy[0];
        console.warn(
            `⚡ [ModelHealth] Все ${candidates.length} кандидатов unhealthy,` +
            ` выбрана ${soonest.id} (cooldown до ${new Date(soonest.state.cooldownUntil).toLocaleTimeString('ru-RU')})`
        );
        return soonest.id;
    },
    
    /**
     * Получить статистику по всем моделям (для API/логов)
     */
    getStatus(): Record<string, {
        healthy: boolean;
        consecutiveErrors: number;
        cooldownUntil: number;
        cooldownRemaining: string | null;
        avgLatencyMs: number;
        lastSuccessAt: number;
        lastErrorAt: number;
        lastErrorMessage: string;
    }> {
        const result: Record<string, any> = {};
        const now = Date.now();
        
        healthStates.forEach((state, id) => {
            const isCooldown = state.cooldownUntil > now;
            result[id] = {
                healthy: !isCooldown,
                consecutiveErrors: state.consecutiveErrors,
                cooldownUntil: state.cooldownUntil,
                cooldownRemaining: isCooldown ? formatDuration(state.cooldownUntil - now) : null,
                avgLatencyMs: Math.round(state.avgLatencyMs),
                lastSuccessAt: state.lastSuccessAt,
                lastErrorAt: state.lastErrorAt,
                lastErrorMessage: state.lastErrorMessage,
            };
        });
        
        return result;
    },
    
    /**
     * Принудительно сбросить состояние модели
     */
    reset(modelId: string, model?: string): void {
        const id = normalizeModelId(modelId, model);
        healthStates.delete(id);
        console.log(`⚡ [ModelHealth] ${id} — состояние сброшено`);
    },
    
    /**
     * Сбросить все состояния
     */
    resetAll(): void {
        healthStates.clear();
        console.log('⚡ [ModelHealth] Все состояния моделей сброшены');
    },
    
    /**
     * Запустить периодическую проверку cooldown'ов
     * Вызывается при старте сервера
     */
    startRecoveryCheck(): void {
        if (recoveryInterval) return;
        
        recoveryInterval = setInterval(() => {
            const now = Date.now();
            let recoveredCount = 0;
            
            healthStates.forEach((state, id) => {
                if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
                    // Cooldown истёк — модель доступна для повторного использования
                    // Не сбрасываем consecutiveErrors — они сбросятся при успешном вызове
                    state.cooldownUntil = 0;
                    recoveredCount++;
                }
            });
            
            if (recoveredCount > 0) {
                console.log(`⚡ [ModelHealth] Периодическая проверка: ${recoveredCount} моделей восстановлены из cooldown`);
            }
        }, RECOVERY_CHECK_INTERVAL_MS);
        
        // Не мешаем процессу завершиться
        if (recoveryInterval.unref) {
            recoveryInterval.unref();
        }
        
        console.log(`⚡ [ModelHealth] Периодическая проверка запущена (каждые ${formatDuration(RECOVERY_CHECK_INTERVAL_MS)})`);
    },
    
    /**
     * Остановить периодическую проверку
     */
    stopRecoveryCheck(): void {
        if (recoveryInterval) {
            clearInterval(recoveryInterval);
            recoveryInterval = null;
            console.log('⚡ [ModelHealth] Периодическая проверка остановлена');
        }
    },
};
