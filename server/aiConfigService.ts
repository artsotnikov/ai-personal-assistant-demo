/**
 * AI Config Service — Централизованный сервис конфигурации AI-моделей
 * 
 * Функции:
 * - Получение конфига по типу задачи из БД
 * - Создание AI-клиента для задачи
 * - Кэширование конфигов для производительности
 * - Fallback на дефолтные настройки
 * - Поддержка tool calling (OpenAI Function Calling)
 */

import OpenAI from "openai";
import { db } from "./db";
import { aiModelConfigs, llmCallLogs, type AiModelConfig, type AITaskType, type AIProvider, type ReasoningEffort } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { ParsedToolCall } from './tools/types';
import { parseXmlToolCalls } from './tools/llmAdapter';
import { resolveContextWindow, fetchModelContextWindow } from "./modelContextRegistry";
import { estimateMessagesTokenCount } from "./chunkService";
import { apiHealth, type AIProviderName } from "./apiHealthMonitor";
import { modelHealth } from "./modelHealthTracker";

// Кэш конфигов (TTL 5 минут)
const configCache = new Map<string, { config: AiModelConfig; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

// Таймаут для всех AI-запросов (120 секунд)
const AI_TIMEOUT_MS = 120_000;

// Дефолтные настройки, если в БД нет записи
const DEFAULT_CONFIG: Omit<AiModelConfig, 'id' | 'taskType' | 'createdAt' | 'updatedAt'> = {
    provider: 'antigravity',
    model: 'gemini-3-flash',
    systemPrompt: null,
    temperature: '0.3',
    maxTokens: 500,
    contextWindow: null,
    reasoningEffort: null,
    isActive: true,
    description: 'Настройки по умолчанию',
};

/**
 * Создание OpenAI клиента для провайдера
 * Все клиенты создаются с timeout = 120 секунд
 * 
 * Провайдер 'antigravity' теперь использует Antigravity-Manager (lbjlaq/Antigravity-Manager),
 * который предоставляет стандартный OpenAI-совместимый REST API на порту 8045.
 * Кастомный JSON-RPC клиент (AntigravityClient) удалён — больше не нужен.
 */
function createClientForProvider(provider: AIProvider): OpenAI {
    switch (provider) {
        case 'antigravity': {
            const baseURL = process.env.ANTIGRAVITY_URL;
            if (!baseURL) {
                throw new Error('ANTIGRAVITY_URL не настроен. Задайте URL в .env');
            }
            const apiKey = process.env.ANTIGRAVITY_API_KEY || process.env.ANTIGRAVITY_AUTH || 'sk-change-me';
            if (apiKey === 'sk-change-me') {
                console.warn('[AIConfig] ⚠️ ANTIGRAVITY_API_KEY не настроен! Установите ключ из Antigravity-Manager.');
            }
            return new OpenAI({ baseURL, apiKey, timeout: AI_TIMEOUT_MS });
        }

        case 'openrouter': {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                throw new Error("OPENROUTER_API_KEY не настроен. Добавьте ключ в .env");
            }
            return new OpenAI({
                baseURL: 'https://openrouter.ai/api/v1',
                apiKey,
                timeout: AI_TIMEOUT_MS,
                defaultHeaders: {
                    'HTTP-Referer': process.env.APP_URL || 'https://ai-assistant.app',
                    'X-Title': 'AI Personal Assistant',
                },
            });
        }

        case 'deepseek': {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            if (!apiKey) {
                throw new Error("DEEPSEEK_API_KEY не настроен. Добавьте ключ в .env");
            }
            return new OpenAI({
                baseURL: 'https://api.deepseek.com',
                apiKey,
                timeout: AI_TIMEOUT_MS,
            });
        }

        case 'custom': {
            const apiKey = process.env.CUSTOM_API_KEY;
            const baseURL = process.env.CUSTOM_API_URL;
            if (!apiKey || !baseURL) {
                throw new Error("CUSTOM_API_KEY и CUSTOM_API_URL не настроены. Добавьте ключи в .env");
            }
            return new OpenAI({
                baseURL,
                apiKey,
                timeout: AI_TIMEOUT_MS,
            });
        }

        case 'openai':
        default: {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OPENAI_API_KEY не настроен. Добавьте ключ в .env");
            }
            return new OpenAI({ apiKey, timeout: AI_TIMEOUT_MS });
        }
    }
}

/**
 * Логирование вызова LLM в БД
 */
async function logLlmCall(data: {
    taskType: AITaskType;
    provider: string;
    model: string;
    messages: any[];
    response?: string;
    error?: string;
    durationMs: number;
    tokensUsed?: number;
    cachedTokensUsed?: number;
    status: 'success' | 'error' | 'empty';
}) {
    try {
        await db.insert(llmCallLogs).values({
            taskType: data.taskType,
            provider: data.provider,
            model: data.model,
            messages: data.messages,
            response: data.response,
            error: data.error,
            durationMs: data.durationMs,
            tokensUsed: data.tokensUsed || 0,
            cachedTokensUsed: data.cachedTokensUsed || 0,
            status: data.status,
            createdAt: new Date(),
        });
    } catch (e) {
        console.error('[AIConfig] ❌ Ошибка записи LLM лога:', e);
    }
}

/**
 * Получение конфига из БД с кэшированием
 */
export async function getModelConfig(taskType: AITaskType): Promise<AiModelConfig | null> {
    // Проверяем кэш
    const cached = configCache.get(taskType);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.config;
    }

    // Загружаем из БД
    try {
        const result = await db.select()
            .from(aiModelConfigs)
            .where(eq(aiModelConfigs.taskType, taskType))
            .limit(1);

        if (result.length > 0 && result[0].isActive) {
            configCache.set(taskType, { config: result[0], timestamp: Date.now() });
            return result[0];
        }
    } catch (error) {
        console.error(`[AIConfig] Ошибка загрузки конфига для ${taskType}:`, error);
    }

    return null;
}

/**
 * Получение конфига с fallback на default
 */
export async function getModelConfigWithFallback(taskType: AITaskType): Promise<{
    provider: AIProvider;
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string | null;
    reasoningEffort: ReasoningEffort | null;
    contextWindow: number;
}> {
    // Сначала пытаемся получить конфиг для конкретной задачи
    let config = await getModelConfig(taskType);

    // Если нет — пытаемся получить default
    if (!config) {
        config = await getModelConfig('default');
    }


    // Если и default нет — используем hardcoded fallback
    if (!config) {
        console.warn(`[AIConfig] ⚠️ Нет конфига для ${taskType}, используем hardcoded fallback`);
        const contextWindow = await resolveContextWindow(
            DEFAULT_CONFIG.provider as AIProvider,
            DEFAULT_CONFIG.model,
            null,
        );
        return {
            provider: DEFAULT_CONFIG.provider as AIProvider,
            model: DEFAULT_CONFIG.model,
            temperature: parseFloat(DEFAULT_CONFIG.temperature || '0.3'),
            maxTokens: DEFAULT_CONFIG.maxTokens || 500,
            systemPrompt: DEFAULT_CONFIG.systemPrompt,
            reasoningEffort: null,
            contextWindow,
        };
    }

    const contextWindow = await resolveContextWindow(
        config.provider as AIProvider,
        config.model,
        config.contextWindow,
    );

    return {
        provider: config.provider as AIProvider,
        model: config.model,
        temperature: parseFloat(config.temperature || '0.3'),
        maxTokens: config.maxTokens || 500,
        systemPrompt: config.systemPrompt,
        reasoningEffort: (config.reasoningEffort as ReasoningEffort) || null,
        contextWindow,
    };
}

/**
 * Главная функция: получить AI-клиент для задачи
 */
export async function getAIClientForTask(taskType: AITaskType): Promise<{
    client: OpenAI;
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string | null;
    provider: AIProvider;
    reasoningEffort: ReasoningEffort | null;
    contextWindow: number;
    taskType: AITaskType;
}> {
    const config = await getModelConfigWithFallback(taskType);

    console.log(`[AIConfig] 🔧 ${taskType}: ${config.provider}/${config.model} (temp=${config.temperature}, ctx=${Math.round(config.contextWindow / 1000)}K)`);

    const client = createClientForProvider(config.provider);

    return {
        client,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        systemPrompt: config.systemPrompt,
        provider: config.provider,
        reasoningEffort: config.reasoningEffort,
        contextWindow: config.contextWindow,
        taskType,
    };
}

// ── Глобальная fallback-модель из БД (task_type = 'fallback') ──
// Единая fallback-модель для ВСЕХ задач. Настраивается через UI конфигуратора.
// Дефолт (если в БД нет записи): google/gemini-2.5-flash через OpenRouter.
const HARDCODED_FALLBACK_DEFAULTS = {
    provider: 'deepseek' as AIProvider,
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxTokens: 4000,
};

/** Кэш fallback-конфига (обновляется вместе с основным configCache) */
let globalFallbackConfig: { provider: AIProvider; model: string; temperature: number; maxTokens: number } | null = null;

/**
 * Получить глобальную fallback конфигурацию из БД.
 * Если в БД нет записи task_type='fallback' — использует хардкод-дефолт.
 */
async function getGlobalFallbackConfig(): Promise<{ provider: AIProvider; model: string; temperature: number; maxTokens: number }> {
    if (globalFallbackConfig) return globalFallbackConfig;

    try {
        const [row] = await db
            .select()
            .from(aiModelConfigs)
            .where(eq(aiModelConfigs.taskType, 'fallback'))
            .limit(1);

        if (row && row.isActive) {
            globalFallbackConfig = {
                provider: row.provider as AIProvider,
                model: row.model,
                temperature: parseFloat(row.temperature || '0.7'),
                maxTokens: row.maxTokens || 4000,
            };
            console.log(`[AIConfig] 🔧 Глобальный fallback загружен из БД: ${row.provider}/${row.model}`);
        } else {
            globalFallbackConfig = { ...HARDCODED_FALLBACK_DEFAULTS };
            console.warn(`[AIConfig] ⚠️ Запись fallback не найдена в БД, используем дефолт: ${HARDCODED_FALLBACK_DEFAULTS.provider}/${HARDCODED_FALLBACK_DEFAULTS.model}`);
        }
    } catch (err) {
        console.error('[AIConfig] ❌ Ошибка загрузки fallback из БД:', err);
        globalFallbackConfig = { ...HARDCODED_FALLBACK_DEFAULTS };
    }

    return globalFallbackConfig;
}

// ── Circuit Breaker: автопереключение при устойчивом сбое ──
// Отслеживает последовательные пустые/ошибочные ответы от основной модели.
// После CIRCUIT_BREAKER_THRESHOLD подряд → переключаемся на альтернативную модель.
const CIRCUIT_BREAKER_THRESHOLD = 2;
const CIRCUIT_BREAKER_RESET_MS = 10 * 60 * 1000; // 10 минут — после чего пробуем снова основную модель

interface CircuitBreakerState {
    consecutiveFailures: number;
    lastFailure: number;
    isOpen: boolean;            // true = основная модель отключена, используем альтернативную
    alternativeProvider: AIProvider;
    alternativeModel: string;   // модель, на которую переключились
}

const circuitBreaker: CircuitBreakerState = {
    consecutiveFailures: 0,
    lastFailure: 0,
    isOpen: false,
    alternativeProvider: HARDCODED_FALLBACK_DEFAULTS.provider,
    alternativeModel: HARDCODED_FALLBACK_DEFAULTS.model,
};

function recordCircuitBreakerSuccess(): void {
    if (circuitBreaker.consecutiveFailures > 0 || circuitBreaker.isOpen) {
        console.log(`[CircuitBreaker] ✅ Успешный ответ, сбрасываем счётчик (было: ${circuitBreaker.consecutiveFailures} сбоев)`);
    }
    circuitBreaker.consecutiveFailures = 0;
    circuitBreaker.isOpen = false;
}

function recordCircuitBreakerFailure(model: string): void {
    circuitBreaker.consecutiveFailures++;
    circuitBreaker.lastFailure = Date.now();
    console.warn(`[CircuitBreaker] ⚠️ Сбой ${model}: ${circuitBreaker.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD}`);
    if (circuitBreaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreaker.isOpen = true;
        console.error(`[CircuitBreaker] 🔴 ОТКРЫТ: ${circuitBreaker.consecutiveFailures} сбоев подряд от ${model}. Переключаемся на ${circuitBreaker.alternativeModel} на ${CIRCUIT_BREAKER_RESET_MS / 1000}с`);
    }
}

function shouldUseAlternativeModel(): boolean {
    if (!circuitBreaker.isOpen) return false;
    // Автосброс после таймаута — пробуем основную модель снова
    if (Date.now() - circuitBreaker.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
        console.log(`[CircuitBreaker] 🔄 Автосброс после ${CIRCUIT_BREAKER_RESET_MS / 1000}с. Пробуем основную модель.`);
        circuitBreaker.isOpen = false;
        circuitBreaker.consecutiveFailures = 0;
        return false;
    }
    return true;
}

// ── Retry для AI-запросов: утилиты ──

/** Максимум retry-попыток для основного провайдера */
const RETRY_MAX_ATTEMPTS = 3;
/** Расширенное количество retry для antigravity (Manager может переключить аккаунт) */
const RETRY_MAX_ATTEMPTS_ANTIGRAVITY = 4;
/** Базовая задержка retry (мс) */
const RETRY_BASE_DELAY_MS = 3_000;
/** Максимальная задержка retry (мс) */
const RETRY_MAX_DELAY_MS = 15_000;

/** HTTP-коды, при которых имеет смысл retry */
const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 408]);

/** Сетевые ошибки, при которых имеет смысл retry */
const RETRYABLE_NETWORK_CODES = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** HTTP-коды, при которых retry бесполезен (fatal) — для обычных провайдеров */
const NON_RETRYABLE_HTTP_CODES = new Set([401, 403]);

/**
 * Определить, является ли ошибка AI-запроса транзиентной (имеет смысл retry)
 * 
 * Особенность Antigravity-Manager: 
 * - Возвращает 429 с текстом "All accounts exhausted" — при retry может выбрать другой аккаунт
 * - Может вернуть 400 при проблеме конкретного аккаунта (а не формата запроса) — retryable
 * - Возвращает 503 "All accounts failed" — при retry Manager может восстановить аккаунт
 * 
 * @param provider — текущий провайдер (для provider-specific логики)
 */
function isRetryableAIError(error: any, provider?: string): boolean {
    const httpStatus = error?.status || error?.statusCode;
    const msg = error?.message || '';

    // Явные non-retryable коды (401, 403 = аутентификация/авторизация)
    if (httpStatus && NON_RETRYABLE_HTTP_CODES.has(httpStatus)) {
        return false;
    }

    // HTTP 400 — retryable ОДИН раз для antigravity (Manager может переключить аккаунт).
    // НО: если тело ошибки содержит маркеры невалидного контента — retry бесполезен.
    // Для остальных провайдеров 400 фатальна (неправильный формат запроса).
    if (httpStatus === 400) {
        if (provider === 'antigravity') {
            const bodyMsg = (error?.error?.message || error?.message || '').toLowerCase();
            // Маркеры контентной/формат ошибки — retry бессмысленен
            const isContentError = [
                'invalid_request', 'context_length_exceeded', 'max_tokens', 'too many tokens',
                'content_filter', 'invalid_messages', 'malformed', 'invalid json',
                'maximum context length', 'input too long',
            ].some(marker => bodyMsg.includes(marker));
            if (isContentError) {
                console.warn(`[Retry] ❌ 400 от Antigravity-Manager — контентная ошибка, retry бесполезен: ${bodyMsg.substring(0, 150)}`);
                return false;
            }
            // Для остальных 400 (проблема аккаунта) — 1 повтор (на attempt 1 isRetryable && attempt < maxRetries)
            console.warn(`[Retry] ⚠️ 400 от Antigravity-Manager — один retry (возможна проблема аккаунта)`);
            return true;
        }
        return false;
    }

    // Retryable по HTTP-коду (429, 500, 502, 503, 408)
    if (httpStatus && RETRYABLE_HTTP_CODES.has(httpStatus)) return true;

    // Таймаут от OpenAI SDK
    if (msg.includes('timed out') || msg.includes('timeout')) return true;
    if (error?.code === 'ETIMEDOUT' || error?.type === 'request-timeout') return true;

    // Сетевые ошибки
    if (error?.code && RETRYABLE_NETWORK_CODES.has(error.code)) return true;
    if (error?.cause?.code && RETRYABLE_NETWORK_CODES.has(error.cause.code)) return true;

    // Antigravity-Manager упаковывает HTTP-код в message ("429 All accounts...", "503 Token error...")
    if (msg.startsWith('429 ')) {
        // Все аккаунты получили 403 PERMISSION_DENIED → retry бесполезен
        if (msg.includes('PERMISSION_DENIED') && msg.includes('disabled')) {
            return false;
        }
        return true; // 429 RATE_LIMIT / All accounts exhausted — retry имеет шанс
    }
    // 400 в message: для Antigravity — один retry (см. логику выше по httpStatus)
    if (msg.startsWith('400 ') && provider === 'antigravity') return true;
    if (msg.startsWith('502 ') || msg.startsWith('503 ') || msg.startsWith('500 ')) return true;

    return false;
}

/**
 * Парсинг retryDelay из ошибки Google API
 * 
 * Google возвращает в деталях ошибки точное время до сброса квоты:
 * { "retryDelay": "3.290171714s" }
 * 
 * @returns задержка в мс, или null если не найдена
 */
function parseRetryDelayFromError(error: any): number | null {
    const msg = error?.message || '';
    
    // Ищем retryDelay в JSON внутри текста ошибки
    const match = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
    if (match) {
        const seconds = parseFloat(match[1]);
        if (!isNaN(seconds) && seconds > 0 && seconds < 60) {
            return Math.ceil(seconds * 1000); // С округлением вверх
        }
    }
    
    // Ищем quotaResetDelay как альтернативу
    const resetMatch = msg.match(/"quotaResetDelay"\s*:\s*"([\d.]+)s"/i);
    if (resetMatch) {
        const seconds = parseFloat(resetMatch[1]);
        if (!isNaN(seconds) && seconds > 0 && seconds < 60) {
            return Math.ceil(seconds * 1000);
        }
    }
    
    return null;
}

/**
 * Рассчитать задержку retry с exponential backoff + jitter
 * 
 * @param attempt - номер попытки (1-based)
 * @param error - ошибка (для парсинга retryDelay от Google)
 * @returns задержка в мс
 */
function calculateRetryDelay(attempt: number, error?: any): number {
    // Если Google указал конкретное время — используем его + небольшой буфер
    if (error) {
        const googleDelay = parseRetryDelayFromError(error);
        if (googleDelay) {
            const withBuffer = googleDelay + 500; // +500ms буфер
            console.log(`[Retry] 📡 Google retryDelay: ${googleDelay}ms, используем ${withBuffer}ms`);
            return Math.min(withBuffer, RETRY_MAX_DELAY_MS);
        }
    }
    
    // Exponential backoff: base * 2^(attempt-1) + jitter
    const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 1000); // 0-1000ms
    return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

/** Промис-пауза */
function retrySleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Прогрессивное сжатие сообщений при превышении контекстного окна.
 * 
 * Стратегия:
 * 1. Сохраняем system prompt (первое сообщение) + последние 2-3 сообщения
 * 2. Убираем самые старые сообщения из середины
 * 3. Повторяем до тех пор, пока не влезем в 90% бюджета
 */
function compressMessagesForContext(
    messages: ChatMessage[],
    contextWindow: number,
): ChatMessage[] {
    const targetBudget = Math.floor(contextWindow * 0.90); // Целевой бюджет = 90%
    const MIN_MESSAGES_KEEP = 3; // Минимум user/assistant сообщений (без system)

    // Разделяем: system-сообщения и диалог
    const systemMessages = messages.filter(m => m.role === 'system');
    const dialogMessages = messages.filter(m => m.role !== 'system');

    let currentDialog = [...dialogMessages];

    // Итеративно убираем самые старые сообщения из диалога
    while (currentDialog.length > MIN_MESSAGES_KEEP) {
        const candidate = [...systemMessages, ...currentDialog];
        const tokens = estimateMessagesTokenCount(candidate);

        if (tokens <= targetBudget) {
            return candidate;
        }

        // Убираем самое старое сообщение из диалога
        currentDialog.shift();
    }

    // Если даже с минимумом не влезаем — возвращаем что есть + warning
    const finalMessages = [...systemMessages, ...currentDialog];
    const finalTokens = estimateMessagesTokenCount(finalMessages);
    if (finalTokens > contextWindow) {
        console.error(`[ContextGuard] ⛔️ Даже после сжатия ~${finalTokens.toLocaleString()} > ${contextWindow.toLocaleString()}! System prompt слишком большой.`);
    }

    return finalMessages;
}

/**
 * Часть multimodal контента (OpenAI Vision API формат)
 */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/**
 * Тип сообщения для AI запроса
 * content может быть строкой (обычное сообщение) или массивом ContentPart (multimodal)
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ContentPart[];
}

/**
 * Результат вызова AI с поддержкой fallback
 */
export interface AICallResult {
    content: string;
    /** Parsed tool calls from LLM (если модель вызвала tools) */
    toolCalls?: ParsedToolCall[];
    usedFallback: boolean;
    tokensUsed: number;
    provider: string;
    model: string;
    /** Количество токенов, взятых из кеша (если поддерживается провайдером) */
    cachedTokensUsed?: number;
    /** true если это ошибка-заглушка, а не реальный ответ модели */
    _isError?: boolean;
    /**
     * reasoning_content от DeepSeek thinking-моделей (deepseek-v4-flash).
     * DeepSeek ТРЕБУЕТ передавать его обратно при следующем вызове,
     * иначе вернёт 400: "reasoning_content must be passed back to the API".
     */
    reasoningContent?: string;
}

/**
 * Вызов AI с автоматическим fallback на резервную модель
 * 
 * При пустом ответе или ошибке от основной модели — 
 * автоматически переключается на gemini-3-flash через custom провайдер
 */

/**
 * Санирует строку для безопасной JSON-сериализации.
 * 
 * Проблема: Antigravity Manager (Rust-парсер) возвращает 400 с ошибкой
 * "unexpected end of hex escape at line 1 column XXXXXX" когда JSON body содержит
 * невалидные Unicode escape-последовательности.
 * 
 * Основные причины:
 * 1. Lone surrogates (U+D800-U+DFFF без пары) — Node.js допускает их в строках,
 *    но JSON.stringify сериализует как \uDXXX, что строгие парсеры отклоняют.
 * 2. Невалидные \uXXXX literal escapes в тексте (из LLM-ответов, БД, OCR).
 * 3. Управляющие символы (0x00-0x1F) кроме \n \r \t.
 */
function sanitizeStringContent(str: string): string {
    return str
        // 1. Удалить lone surrogates: \uD800-\uDBFF без trailing \uDC00-\uDFFF, или \uDC00-\uDFFF без leading
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')  // High surrogate без low
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')  // Low surrogate без high
        // 2. Удалить невалидные literal \uXXXX (менее 4 hex-цифр или non-hex) 
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
        // 3. Удалить управляющие символы (0x00-0x1F, кроме \n=0x0A, \r=0x0D, \t=0x09)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** Применяет санирование ко всем message content в массиве */
function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        if (typeof (msg as any).content === 'string') {
            return { ...msg, content: sanitizeStringContent((msg as any).content) };
        }
        // Для content: Array<{type, text}> (multipart)
        if (Array.isArray((msg as any).content)) {
            return {
                ...msg,
                content: (msg as any).content.map((part: any) =>
                    part?.text ? { ...part, text: sanitizeStringContent(part.text) } : part
                ),
            };
        }
        return msg;
    });
}

/**
 * Провайдеры, которые НЕ поддерживают image_url в messages.
 * DeepSeek (все модели) и большинство не-multimodal провайдеров.
 */
const NON_VISION_PROVIDERS = new Set<string>(['deepseek', 'custom']);

/**
 * Удаляет image_url части из messages для провайдеров без vision.
 *
 * Проблема: пользователь отправил изображение → оно сохраняется в историю
 * как ContentPart[] с image_url. При следующем обращении это сообщение
 * попадает в контекст deepseek → 400 "unknown variant image_url".
 *
 * Решение: заменяем image_url на текстовую пометку "[изображение]",
 * оставляя только text parts.
 */
function stripImagePartsForProvider(messages: ChatMessage[], provider: string): ChatMessage[] {
    if (!NON_VISION_PROVIDERS.has(provider)) return messages;

    return messages.map(msg => {
        const content = (msg as any).content;
        if (!Array.isArray(content)) return msg;

        const hasImageParts = content.some((p: any) => p?.type === 'image_url');
        if (!hasImageParts) return msg;

        // Оставляем text parts, заменяем image_url на текстовую пометку
        const stripped = content
            .filter((p: any) => p?.type !== 'image_url')
        ;
        const imageCount = content.filter((p: any) => p?.type === 'image_url').length;

        // Добавляем текстовое замещение к последнему text part или создаём новый
        const textParts = stripped.filter((p: any) => p?.type === 'text');
        const imagePlaceholder = `[${imageCount} изображени${imageCount === 1 ? 'е' : 'я'} — не поддерживается данной моделью]`;

        if (textParts.length > 0) {
            // Append к тексту последнего text part
            return {
                ...msg,
                content: stripped.map((p: any, i: number) =>
                    i === stripped.length - 1 && p?.type === 'text'
                        ? { ...p, text: p.text + '\n' + imagePlaceholder }
                        : p
                ),
            };
        } else {
            // Все части были image_url — заменяем весь content на строку
            return { ...msg, content: imagePlaceholder };
        }
    });
}

export async function callWithFallback(
    primaryConfig: {
        client: OpenAI;
        model: string;
        temperature: number;
        maxTokens: number;
        provider: AIProvider;
        reasoningEffort?: ReasoningEffort | null;
        contextWindow?: number;
        taskType?: AITaskType;
    },
    messages: ChatMessage[],
    options?: {
        /** OpenAI tools (function calling) */
        tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }>;
        /** tool_choice: 'auto' | 'required' | 'none' — контролирует обязательность вызова tools */
        tool_choice?: 'auto' | 'required' | 'none';
    },
): Promise<AICallResult> {
    // taskType дефолт — для вызовов из ReAct Loop, где aiConfig может не содержать taskType
    const taskType: AITaskType = primaryConfig.taskType || 'agent_core';
    // Переопределяем primaryConfig с гарантированным taskType для logLlmCall
    const primaryConfigWithTask = { ...primaryConfig, taskType };

    // ── MessageSanitizer: чистим невалидные Unicode escape ПЕРЕД любой обработкой ──
    // Причина: невалидные \uXXXX в preferences/skills вызывают "unexpected end of hex escape"
    // при сериализации JSON → Antigravity Manager возвращает 400 (Model: -, 0ms)
    messages = sanitizeMessages(messages);

    // ── VisionStrip: удаляем image_url parts для провайдеров без vision-поддержки ──
    // DeepSeek возвращает 400 "unknown variant image_url" если в истории есть изображения
    messages = stripImagePartsForProvider(messages, primaryConfig.provider);

    // ── ContextGuard: Pre-send validation ──
    const contextWindow = primaryConfig.contextWindow || 128_000;
    const totalTokens = estimateMessagesTokenCount(messages);
    const usagePercent = Math.round((totalTokens / contextWindow) * 100);

    if (totalTokens > contextWindow * 0.95) {
        console.error(`[ContextGuard] 🔴 КРИТИЧНО: ~${totalTokens.toLocaleString()}/${contextWindow.toLocaleString()} токенов (${usagePercent}%) — превышение лимита ${primaryConfig.provider}/${primaryConfig.model}!`);
        // Автоматическое сжатие: убираем старые сообщения из истории
        messages = compressMessagesForContext(messages, contextWindow);
        const newTotal = estimateMessagesTokenCount(messages);
        const newPercent = Math.round((newTotal / contextWindow) * 100);
        console.log(`[ContextGuard] ✂️ Сжато до ~${newTotal.toLocaleString()}/${contextWindow.toLocaleString()} (${newPercent}%)`);
    } else if (totalTokens > contextWindow * 0.80) {
        console.warn(`[ContextGuard] 🟡 Высокое использование: ~${totalTokens.toLocaleString()}/${contextWindow.toLocaleString()} (${usagePercent}%) — ${primaryConfig.provider}/${primaryConfig.model}`);
    } else {
        console.log(`[ContextGuard] 🟢 ~${totalTokens.toLocaleString()}/${contextWindow.toLocaleString()} (${usagePercent}%) — ${primaryConfig.provider}/${primaryConfig.model}`);
    }

    // ── Circuit Breaker: если основная модель устойчиво сбоит — переключаемся ──
    if (shouldUseAlternativeModel()) {
        console.warn(`[CircuitBreaker] 🔄 Основная модель ${primaryConfig.model} отключена, используем ${circuitBreaker.alternativeProvider}/${circuitBreaker.alternativeModel}`);
        try {
            const cbClient = createClientForProvider(circuitBreaker.alternativeProvider);
            const cbMessages = stripImagePartsForProvider(messages, circuitBreaker.alternativeProvider);
            const cbResult = await cbClient.chat.completions.create({
                model: circuitBreaker.alternativeModel,
                messages: cbMessages as any[],
                temperature: primaryConfig.temperature,
                max_tokens: primaryConfig.maxTokens,
                ...(options?.tools && options.tools.length > 0 ? {
                    tools: options.tools,
                    ...(options.tool_choice ? { tool_choice: options.tool_choice } : {}),
                } : {}),
            });

            const cbMessage = cbResult.choices[0]?.message;
            const cbContent = cbMessage?.content;
            const cbToolCalls = (cbMessage as any)?.tool_calls as Array<{
                id: string;
                function: { name: string; arguments: string };
            }> | undefined;

            // Если есть tool_calls
            if (cbToolCalls && cbToolCalls.length > 0) {
                const parsed: ParsedToolCall[] = cbToolCalls.map((tc: any) => {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(tc.function.arguments); } catch (e) { /* ignore */ }
                    return { id: tc.id, name: tc.function.name, arguments: args };
                });
                return {
                    content: cbContent || '',
                    toolCalls: parsed,
                    usedFallback: true,
                    tokensUsed: cbResult.usage?.total_tokens || 0,
                    cachedTokensUsed: (cbResult.usage as any)?.prompt_tokens_details?.cached_tokens || 0,
                    provider: circuitBreaker.alternativeProvider,
                    model: circuitBreaker.alternativeModel,
                };
            }

            if (cbContent && cbContent.trim()) {
                return {
                    content: cbContent,
                    usedFallback: true,
                    tokensUsed: cbResult.usage?.total_tokens || 0,
                    cachedTokensUsed: (cbResult.usage as any)?.prompt_tokens_details?.cached_tokens || 0,
                    provider: circuitBreaker.alternativeProvider,
                    model: circuitBreaker.alternativeModel,
                };
            }
        } catch (cbError: any) {
            console.error(`[CircuitBreaker] ❌ Альтернативная модель тоже сбоила:`, cbError?.message);
        }
    }

    // 1. Попытка с основным провайдером (с retry loop)
    // Retry: до RETRY_MAX_ATTEMPTS попыток при транзиентных ошибках (429, 502, timeout и т.д.)
    // Для Antigravity: расширенный retry (4 попытки), т.к. Manager может переключить аккаунт
    let lastRetryError: any = null;
    const maxRetries = primaryConfig.provider === 'antigravity' ? RETRY_MAX_ATTEMPTS_ANTIGRAVITY : RETRY_MAX_ATTEMPTS;

    // ── API Health: если провайдер на паузе (backoff) — сразу идём в fallback ──
    // isBackground=true: для целей retry мы считаем провайдер недоступным, если он на паузе,
    // чтобы не тратить retry-попытки (и 120с таймаута каждая) на заведомо нерабочий провайдер.
    const providerOnPause = !apiHealth.isHealthy(primaryConfig.provider as AIProviderName, true);
    if (providerOnPause) {
        const healthStatus = apiHealth.getStatus()[primaryConfig.provider as AIProviderName];
        console.warn(`[AIFallback] ⏸️ Провайдер ${primaryConfig.provider} на паузе (backoff${healthStatus?.pauseRemaining ? `, осталось ${healthStatus.pauseRemaining}` : ''}), пропускаем retry → fallback`);
    }

    // ── Model Health: если конкретная модель на cooldown — сразу идём в fallback ──
    const primaryModelId = `${primaryConfig.provider}/${primaryConfig.model}`;
    const modelOnCooldown = !modelHealth.isHealthy(primaryModelId);
    if (modelOnCooldown && !providerOnPause) {
        console.warn(`[AIFallback] ⏸️ Модель ${primaryModelId} на cooldown (Model Health), пропускаем retry → fallback`);
    }

    for (let attempt = 1; attempt <= maxRetries && !providerOnPause && !modelOnCooldown; attempt++) {
        try {
            const requestParams: any = {
                model: primaryConfig.model,
                messages: messages as any[],
                temperature: primaryConfig.temperature,
                max_tokens: primaryConfig.maxTokens,
            };

            // Reasoning tokens (для моделей с thinking: o3, o4-mini и т.д.)
            if (primaryConfig.reasoningEffort) {
                requestParams.reasoning = { effort: primaryConfig.reasoningEffort };
                if (attempt === 1) {
                    console.log(`[AIConfig] 🧠 Reasoning effort: ${primaryConfig.reasoningEffort}`);
                }
            }

            // Добавляем tools если переданы
            if (options?.tools && options.tools.length > 0) {
                requestParams.tools = options.tools;
                // tool_choice: принуждает модель к вызову инструментов
                if (options.tool_choice) {
                    requestParams.tool_choice = options.tool_choice;
                }
            }

            const startTime = Date.now();

            // 📊 Диагностика + Pre-flight JSON validation
            if (attempt === 1) {
                try {
                    const serialized = JSON.stringify(requestParams);
                    const approxBodySize = serialized.length;
                    const msgCount = requestParams.messages?.length || 0;
                    const toolMsgCount = requestParams.messages?.filter((m: any) => m.role === 'tool').length || 0;
                    const toolsCount = requestParams.tools?.length || 0;

                    if (approxBodySize > 500_000) {
                        console.warn(`[AIConfig] ⚠️ LARGE REQUEST: ~${Math.round(approxBodySize / 1024)}KB, ${msgCount} msgs (${toolMsgCount} tool), ${toolsCount} tools → ${primaryConfig.model}`);
                    }

                    // Проверяем, что JSON парсится обратно без ошибок (ловит lone surrogates и пр.)
                    JSON.parse(serialized);
                } catch (jsonError: any) {
                    console.error(`[AIConfig] 🔴 PRE-FLIGHT JSON ERROR: ${jsonError.message} — фиксируем через roundtrip`);
                    // Фиксируем: round-trip через JSON.parse/stringify с заменой проблемных символов
                    try {
                        requestParams.messages = requestParams.messages.map((msg: any) => {
                            if (typeof msg.content === 'string') {
                                // Удаляем все символы, которые вызывают проблемы при JSON сериализации
                                msg = { ...msg, content: msg.content.replace(/[\uD800-\uDFFF]/g, '') };
                            }
                            return msg;
                        });
                    } catch (fixError) {
                        console.error(`[AIConfig] 🔴 Не удалось исправить JSON:`, fixError);
                    }
                }
            }

            const response = await primaryConfig.client.chat.completions.create(requestParams);
            const durationMs = Date.now() - startTime;

            const message = response.choices[0]?.message;
            const content = message?.content;
            const rawToolCalls = (message as any)?.tool_calls as Array<{
                id: string;
                function: { name: string; arguments: string };
            }> | undefined;

            // DeepSeek thinking-модели возвращают reasoning_content в message.
            // Его НЕОБХОДИМО передавать обратно при следующем вызове, иначе 400.
            const reasoningContent = (message as any)?.reasoning_content as string | undefined;
            if (reasoningContent) {
                console.log(`[AIConfig] 🧠 reasoning_content получен (${reasoningContent.length} символов), сохраняем для передачи обратно`);
            }

            // 🔍 Диагностика: тип ответа модели
            console.log(`[AIConfig] 📊 Response: finish_reason=${response.choices[0]?.finish_reason}, toolCalls=${rawToolCalls?.length ?? 'undef'}, content=${content?.length ?? 0}ch, hasXml=${!!(content && (content.includes('<invoke') || content.includes('<function_calls')))}${attempt > 1 ? `, attempt=${attempt}` : ''}`);

            // Если есть tool_calls — возвращаем их (даже без content)
            if (rawToolCalls && rawToolCalls.length > 0) {
                const parsedToolCalls: ParsedToolCall[] = rawToolCalls.map((tc: any) => {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(tc.function.arguments);
                    } catch (e) {
                        console.error(`[AIFallback] ❌ Ошибка парсинга tool args для ${tc.function.name}:`, e);
                    }
                    return {
                        id: tc.id,
                        name: tc.function.name,
                        arguments: args,
                    };
                });

                const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0;
                if (cachedTokens > 0) {
                    console.log(`[AIConfig] ⚡ Prompt Cache HIT: ${cachedTokens.toLocaleString()} токенов (${Math.round((cachedTokens / (response.usage?.prompt_tokens || 1)) * 100)}%)`);
                }

                // Логируем успешный вызов с инструментами
                await logLlmCall({
                    taskType: taskType,
                    provider: primaryConfig.provider,
                    model: primaryConfig.model,
                    messages,
                    response: content || `[TOOL CALLS: ${parsedToolCalls.length}]`,
                    durationMs,
                    tokensUsed: response.usage?.total_tokens,
                    cachedTokensUsed: cachedTokens,
                    status: 'success',
                });

                recordCircuitBreakerSuccess();
                apiHealth.recordSuccess(primaryConfig.provider as AIProviderName);
                modelHealth.recordSuccess(primaryConfig.provider, durationMs, primaryConfig.model);
                return {
                    content: content || '',
                    toolCalls: parsedToolCalls,
                    usedFallback: false,
                    tokensUsed: response.usage?.total_tokens || 0,
                    cachedTokensUsed: cachedTokens,
                    provider: primaryConfig.provider,
                    model: primaryConfig.model,
                    ...(reasoningContent ? { reasoningContent } : {}),
                };
            }

            // Если нет tool_calls, проверяем, не вернула ли модель XML
            if (content && content.trim() && options?.tools) {
                const xmlToolCalls = parseXmlToolCalls(content, options.tools);
                if (xmlToolCalls.length > 0) {
                    console.log(`[AIConfig] 🔧 Извлечено ${xmlToolCalls.length} tool_calls из XML от ${primaryConfig.model}`);
                    const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0;

                    await logLlmCall({
                        taskType: taskType,
                        provider: primaryConfig.provider,
                        model: primaryConfig.model,
                        messages,
                        response: content,
                        durationMs,
                        tokensUsed: response.usage?.total_tokens,
                        cachedTokensUsed: cachedTokens,
                        status: 'success',
                    });

                    return {
                        content: content || '',
                        toolCalls: xmlToolCalls,
                        usedFallback: false,
                        tokensUsed: response.usage?.total_tokens || 0,
                        cachedTokensUsed: cachedTokens,
                        provider: primaryConfig.provider,
                        model: primaryConfig.model,
                    };
                }
            }

            // Если контент пустой — это тоже сбой
            if (content && content.trim()) {
                const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens || 0;
                if (cachedTokens > 0) {
                    console.log(`[AIConfig] ⚡ Prompt Cache HIT: ${cachedTokens.toLocaleString()} токенов (${Math.round((cachedTokens / (response.usage?.prompt_tokens || 1)) * 100)}%)`);
                }

                await logLlmCall({
                    taskType: taskType,
                    provider: primaryConfig.provider,
                    model: primaryConfig.model,
                    messages,
                    response: content,
                    durationMs,
                    tokensUsed: response.usage?.total_tokens,
                    cachedTokensUsed: cachedTokens,
                    status: 'success',
                });

                recordCircuitBreakerSuccess();
                apiHealth.recordSuccess(primaryConfig.provider as AIProviderName);
                modelHealth.recordSuccess(primaryConfig.provider, durationMs, primaryConfig.model);
                return {
                    content,
                    usedFallback: false,
                    tokensUsed: response.usage?.total_tokens || 0,
                    cachedTokensUsed: cachedTokens,
                    provider: primaryConfig.provider,
                    model: primaryConfig.model,
                    ...(reasoningContent ? { reasoningContent } : {}),
                };
            }

            // Пустой ответ — retry 1 раз, потом fallback
            console.warn(`[AIFallback] ⚠️ Пустой ответ от ${primaryConfig.provider}/${primaryConfig.model} (attempt ${attempt}/${maxRetries})`);
            await logLlmCall({
                taskType: taskType,
                provider: primaryConfig.provider,
                model: primaryConfig.model,
                messages,
                response: '',
                durationMs: Date.now() - startTime,
                status: 'empty',
            });

            // Пустой ответ ретраим максимум 1 раз (не 3)
            if (attempt < Math.min(2, maxRetries)) {
                const delay = calculateRetryDelay(attempt);
                console.log(`[Retry] 🔄 Пустой ответ — retry ${attempt}/${maxRetries} через ${delay}ms`);
                await retrySleep(delay);
                continue;
            }

            // Исчерпали retry для пустых ответов
            recordCircuitBreakerFailure(primaryConfig.model);
            modelHealth.recordError(primaryConfig.provider, 'Empty response after retries', primaryConfig.model);
            break; // Выходим из retry loop → идём в fallback

        } catch (error: any) {
            lastRetryError = error;

            // Извлекаем дополнительную диагностику из response body (если есть)
            const errorBody = error?.error?.message || error?.response?.body || '';
            const errorHttpStatus = error?.status || error?.statusCode || null;
            const errorDiag = errorBody ? ` | body: ${String(errorBody).substring(0, 200)}` : '';
            const errorMsg = error?.message || '';

            // ── 413 Body Too Large: лимит nginx/прокси на размер HTTP body ──
            // Это НЕ лимит контекстного окна модели (1M токенов), а лимит nginx
            // `client_max_body_size`. Корневая причина — base64 image_url в истории
            // (1 картинка = 1-5MB в JSON body). stripImagePartsForProvider (вызван выше)
            // уже должен был убрать image_url, но если 413 всё равно возник:
            // 1. Попробуем compressMessagesForContext с уменьшенным виртуальным бюджетом
            // 2. Один retry — если не поможет → fallback chain (другой провайдер)
            const is413 = errorHttpStatus === 413 ||
                errorMsg.startsWith('413 ') ||
                errorMsg.includes('Request Entity Too Large');

            if (is413) {
                // Повторно strip images — на случай если messages мутировались после первого strip
                messages = stripImagePartsForProvider(messages, primaryConfig.provider);

                const beforeTokens = estimateMessagesTokenCount(messages);
                console.error(
                    `[ContextGuard] 🔴 413 от ${primaryConfig.provider}/${primaryConfig.model} ` +
                    `(~${beforeTokens.toLocaleString()} токенов, attempt ${attempt}/${maxRetries})`
                );

                // Используем существующий compressMessagesForContext с виртуальным окном = 50%
                // от текущего объёма. Это сохраняет system prompts, tool results и самые
                // свежие сообщения, убирая только старую историю из середины.
                const virtualWindow = Math.floor(beforeTokens * 0.5);
                if (virtualWindow > 5000 && attempt < maxRetries) {
                    messages = compressMessagesForContext(messages, virtualWindow);
                    const afterTokens = estimateMessagesTokenCount(messages);
                    console.log(
                        `[ContextGuard] ✂️ 413-сжатие: ${beforeTokens.toLocaleString()} → ` +
                        `${afterTokens.toLocaleString()} токенов (${messages.length} сообщений)`
                    );
                    await retrySleep(1000);
                    continue; // Один retry со сжатым контекстом
                }

                // Если уже пробовали сжатие или messages слишком малы — идём в fallback chain
                // (другой провайдер может иметь другой nginx/body limit)
                console.warn(`[ContextGuard] ⚠️ 413 после сжатия — переключаемся на fallback chain`);
                break;
            }

            // Проверяем: retryable ли ошибка? (provider-aware)
            // Для HTTP 400: максимум 1 retry (attempt 1 → retry, attempt ≥ 2 → fallback)
            const isRetryable = isRetryableAIError(error, primaryConfig.provider);
            const maxRetryForThisError = (errorHttpStatus === 400) ? 2 : maxRetries; // 400: retry только attempt 1→2
            if (isRetryable && attempt < maxRetryForThisError) {
                const delay = calculateRetryDelay(attempt, error);
                console.warn(
                    `[Retry] 🔄 ${primaryConfig.provider}/${primaryConfig.model}: ` +
                    `транзиентная ошибка (HTTP ${errorHttpStatus || error?.code || 'unknown'}), ` +
                    `retry ${attempt}/${maxRetries} через ${delay}ms${errorDiag}`,
                    { message: error?.message?.substring(0, 200) }
                );

                try {
                    await logLlmCall({
                        taskType: taskType,
                        provider: primaryConfig.provider,
                        model: primaryConfig.model,
                        messages,
                        error: `[RETRY ${attempt}/${maxRetries}] ${error?.message || String(error)}`,
                        durationMs: 0,
                        status: 'error',
                    });
                } catch (logErr) {
                    console.error(`[AIConfig] ⚠️ logLlmCall failed (retry):`, (logErr as Error)?.message?.substring(0, 100));
                }

                await retrySleep(delay);
                continue; // Следующая попытка
            }

            // Non-retryable ошибка или последняя попытка — логируем с полной диагностикой
            console.error(`[AIFallback] ❌ Ошибка ${primaryConfig.provider}/${primaryConfig.model}${attempt > 1 ? ` (после ${attempt} попыток)` : ''}:`, {
                message: error?.message,
                status: errorHttpStatus,
                code: error?.code,
                type: error?.type,
                body: errorBody ? String(errorBody).substring(0, 300) : undefined,
            });

            try {
                await logLlmCall({
                    taskType: taskType,
                    provider: primaryConfig.provider,
                    model: primaryConfig.model,
                    messages,
                    error: `${error?.message || String(error)}${errorDiag}`,
                    durationMs: 0,
                    status: 'error',
                });
            } catch (logErr) {
                console.error(`[AIConfig] ⚠️ logLlmCall failed (final):`, (logErr as Error)?.message?.substring(0, 100));
            }

            recordCircuitBreakerFailure(primaryConfig.model);

            // API Health Monitor: записываем ошибку с HTTP-кодом для расчёта backoff
            apiHealth.recordError(
                primaryConfig.provider as AIProviderName,
                errorHttpStatus,
                error?.message || String(error)
            );

            // Model Health: записываем ошибку конкретной модели
            modelHealth.recordError(primaryConfig.provider, error?.message || String(error), primaryConfig.model);

            break; // Выходим из retry loop → идём в fallback
        }
    }

    // 2. Fallback chain: Antigravity (другая модель) → Глобальный fallback из БД
    const fallbackChain = [] as Array<{ provider: AIProvider; model: string; temperature: number; maxTokens: number }>;

    // 2a. Модельный fallback ВНУТРИ Antigravity-Manager
    // Если основная модель (gemini-3.1-pro-high/low) не работает — пробуем gemini-3-flash
    // через тот же Antigravity endpoint (Manager может выбрать другой аккаунт)
    if (primaryConfig.provider === 'antigravity' && primaryConfig.model !== 'gemini-3-flash') {
        fallbackChain.push({
            provider: 'antigravity' as AIProvider,
            model: 'gemini-3-flash',
            temperature: primaryConfig.temperature,
            maxTokens: primaryConfig.maxTokens,
        });
    }

    // 2b. Глобальный fallback из БД (task_type='fallback')
    // Одна модель для всех задач, настраивается через UI конфигуратора
    const globalFallback = await getGlobalFallbackConfig();
    if (primaryConfig.model !== globalFallback.model || primaryConfig.provider !== globalFallback.provider) {
        fallbackChain.push(globalFallback);
    }

    // 2c. Обновляем CircuitBreaker fallback из БД (чтобы он тоже использовал актуальную модель)
    circuitBreaker.alternativeProvider = globalFallback.provider;
    circuitBreaker.alternativeModel = globalFallback.model;

    if (fallbackChain.length === 0) {
        console.error('[AIFallback] ❌ Нет доступных fallback моделей');
        return {
            content: 'Извини, произошла ошибка при генерации ответа. Попробуй ещё раз.',
            usedFallback: true,
            tokensUsed: 0,
            provider: 'none',
            model: 'none',
            _isError: true,
        } as AICallResult;
    }

    for (const fallbackConfig of fallbackChain) {
        // ── Model Health: пропускаем fallback-модель, если она на cooldown ──
        const fallbackModelId = `${fallbackConfig.provider}/${fallbackConfig.model}`;
        if (!modelHealth.isHealthy(fallbackModelId)) {
            console.warn(`[AIFallback] ⏸️ Fallback ${fallbackModelId} на cooldown (Model Health), пропускаем`);
            continue;
        }

        try {
            console.log(`[AIFallback] 🔄 Переключаюсь на fallback: ${fallbackConfig.provider}/${fallbackConfig.model}`);

            const fallbackClient = createClientForProvider(fallbackConfig.provider);
            // Стрипаем image_url и санируем для fallback-провайдера (может отличаться от primary)
            const fallbackMessages = stripImagePartsForProvider(
                sanitizeMessages(messages),
                fallbackConfig.provider,
            );
            const fallbackRequestParams: any = {
                model: fallbackConfig.model,
                messages: fallbackMessages as any[],
                temperature: fallbackConfig.temperature,
                max_tokens: fallbackConfig.maxTokens,
            };

            // Передаём tools и tool_choice в fallback, чтобы AI мог собирать контекст
            // tool_choice важен для Fast Path: без него принудительный режим теряется
            if (options?.tools && options.tools.length > 0) {
                fallbackRequestParams.tools = options.tools;
                if (options.tool_choice) {
                    fallbackRequestParams.tool_choice = options.tool_choice;
                }
            }

            const fallbackStartTime = Date.now();
            const fallbackResponse = await fallbackClient.chat.completions.create(fallbackRequestParams);
            const fallbackDurationMs = Date.now() - fallbackStartTime;

            const fallbackMessage = fallbackResponse.choices[0]?.message;
            const fallbackContent = fallbackMessage?.content;
            const fallbackRawToolCalls = (fallbackMessage as any)?.tool_calls as Array<{
                id: string;
                function: { name: string; arguments: string };
            }> | undefined;

            // Если есть tool_calls — возвращаем их (приоритет над content)
            if (fallbackRawToolCalls && fallbackRawToolCalls.length > 0) {
                const parsedToolCalls: ParsedToolCall[] = fallbackRawToolCalls.map((tc: any) => {
                    let args: Record<string, unknown> = {};
                    try {
                        args = JSON.parse(tc.function.arguments);
                    } catch (e) {
                        console.error(`[AIFallback] ❌ Ошибка парсинга tool args (fallback) для ${tc.function.name}:`, e);
                    }
                    return { id: tc.id, name: tc.function.name, arguments: args };
                });
                console.log(`[AIFallback] ✅ Fallback вернул ${parsedToolCalls.length} tool_calls (${fallbackConfig.provider}/${fallbackConfig.model})`);

                await logLlmCall({
                    taskType: taskType,
                    provider: fallbackConfig.provider,
                    model: fallbackConfig.model,
                    messages,
                    response: fallbackContent || `[TOOL CALLS: ${parsedToolCalls.length}]`,
                    durationMs: fallbackDurationMs,
                    tokensUsed: fallbackResponse.usage?.total_tokens,
                    status: 'success',
                });

                recordCircuitBreakerSuccess();
                apiHealth.recordSuccess(fallbackConfig.provider as AIProviderName);
                modelHealth.recordSuccess(fallbackConfig.provider, fallbackDurationMs, fallbackConfig.model);
                return {
                    content: fallbackContent || '',
                    toolCalls: parsedToolCalls,
                    usedFallback: true,
                    tokensUsed: fallbackResponse.usage?.total_tokens || 0,
                    provider: fallbackConfig.provider,
                    model: fallbackConfig.model,
                };
            }

            if (fallbackContent && fallbackContent.trim()) {
                console.log(`[AIFallback] ✅ Fallback успешен: ${fallbackConfig.provider}/${fallbackConfig.model}`);

                await logLlmCall({
                    taskType: taskType,
                    provider: fallbackConfig.provider,
                    model: fallbackConfig.model,
                    messages,
                    response: fallbackContent,
                    durationMs: fallbackDurationMs,
                    tokensUsed: fallbackResponse.usage?.total_tokens,
                    status: 'success',
                });

                recordCircuitBreakerSuccess();
                apiHealth.recordSuccess(fallbackConfig.provider as AIProviderName);
                modelHealth.recordSuccess(fallbackConfig.provider, fallbackDurationMs, fallbackConfig.model);
                return {
                    content: fallbackContent,
                    usedFallback: true,
                    tokensUsed: fallbackResponse.usage?.total_tokens || 0,
                    provider: fallbackConfig.provider,
                    model: fallbackConfig.model,
                };
            }

            console.warn(`[AIFallback] ⚠️ Fallback ${fallbackConfig.provider}/${fallbackConfig.model} вернул пустой ответ, пробуем следующий`);
            await logLlmCall({
                taskType: taskType,
                provider: fallbackConfig.provider,
                model: fallbackConfig.model,
                messages,
                response: '',
                durationMs: fallbackDurationMs,
                status: 'empty',
            });
        } catch (fallbackError: any) {
            console.error(`[AIFallback] ❌ Ошибка fallback ${fallbackConfig.provider}/${fallbackConfig.model}:`, {
                message: fallbackError?.message,
                status: fallbackError?.status,
                code: fallbackError?.code,
            });

            await logLlmCall({
                taskType: taskType,
                provider: fallbackConfig.provider,
                model: fallbackConfig.model,
                messages,
                error: fallbackError?.message || String(fallbackError),
                durationMs: 0,
                status: 'error',
            });

            // API Health Monitor: записываем ошибку fallback-провайдера
            apiHealth.recordError(
                fallbackConfig.provider as AIProviderName,
                fallbackError?.status || null,
                fallbackError?.message || String(fallbackError)
            );

            // Model Health: записываем ошибку конкретной fallback-модели
            modelHealth.recordError(fallbackConfig.provider, fallbackError?.message || String(fallbackError), fallbackConfig.model);
        }
    }

    // 3. Если все fallback провалились — возвращаем ошибку
    console.error(`[AIFallback] ❌ ВСЕ ${fallbackChain.length + 1} модели вернули ошибку/пустой ответ`);
    return {
        content: 'Извини, произошла ошибка при генерации ответа. Попробуй ещё раз.',
        usedFallback: true,
        tokensUsed: 0,
        provider: 'none',
        model: 'none',
        _isError: true,
    } as AICallResult;
}

/**
 * Очистить кэш (для тестов или после изменения настроек)
 */
export function clearConfigCache(): void {
    configCache.clear();
    globalFallbackConfig = null; // Сбрасываем кэш fallback-модели — перечитается из БД при следующем вызове
    console.log('[AIConfig] Кэш очищен (включая fallback)');
}

/**
 * Получить все конфиги (для UI)
 */
export async function getAllConfigs(): Promise<AiModelConfig[]> {
    return db.select().from(aiModelConfigs).orderBy(aiModelConfigs.taskType);
}

/**
 * Обновить конфиг (для UI)
 * 
 * Если модель изменилась и contextWindow не передан явно —
 * автоматически определяет contextWindow через API провайдера.
 */
export async function updateConfig(
    taskType: AITaskType,
    updates: Partial<Omit<AiModelConfig, 'id' | 'taskType' | 'createdAt' | 'updatedAt'>>
): Promise<AiModelConfig | null> {
    // Авто-определение contextWindow при смене модели
    if (updates.model && !updates.contextWindow) {
        const provider = updates.provider as AIProvider | undefined;
        if (provider) {
            const resolved = await fetchModelContextWindow(provider, updates.model);
            if (resolved) {
                updates.contextWindow = resolved;
                console.log(`[AIConfig] 📏 Авто-определён contextWindow для ${provider}/${updates.model}: ${Math.round(resolved / 1000)}K`);
            }
        }
    }

    const result = await db.update(aiModelConfigs)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(aiModelConfigs.taskType, taskType))
        .returning();

    // Очищаем кэш для этой задачи
    configCache.delete(taskType);

    return result[0] || null;
}

/**
 * Создать конфиг (для инициализации)
 */
export async function createConfig(config: {
    taskType: AITaskType;
    provider: AIProvider;
    model: string;
    temperature?: string;
    maxTokens?: number;
    contextWindow?: number | null;
    systemPrompt?: string;
    description?: string;
}): Promise<AiModelConfig> {
    // Автоопределение contextWindow через API провайдера
    let contextWindow = config.contextWindow || null;
    if (!contextWindow) {
        const resolved = await fetchModelContextWindow(config.provider, config.model);
        if (resolved) {
            contextWindow = resolved;
            console.log(`[AIConfig] 📏 Авто-определён contextWindow для ${config.provider}/${config.model}: ${Math.round(resolved / 1000)}K`);
        }
    }

    const result = await db.insert(aiModelConfigs)
        .values({
            taskType: config.taskType,
            provider: config.provider,
            model: config.model,
            temperature: config.temperature || '0.3',
            maxTokens: config.maxTokens || 500,
            contextWindow,
            systemPrompt: config.systemPrompt || null,
            description: config.description || null,
            isActive: true,
        })
        .returning();

    return result[0];
}

/**
 * Массовая замена провайдера/модели во всех конфигурациях.
 *
 * Режимы работы:
 * - fromProvider → toProvider + toModel: меняет провайдера И модель у всех конфигов, у которых provider = fromProvider
 * - fromProvider → toProvider (без toModel): меняет только провайдера, модель на toModel по умолчанию не задаётся
 *   (в этом случае toModel является обязательным)
 *
 * Опционально можно указать taskTypes[] для фильтрации — тогда обновляются только они.
 */
export async function bulkUpdateProvider(options: {
    fromProvider: string;
    toProvider: string;
    toModel: string;
    taskTypes?: string[]; // если задано — только эти taskType
}): Promise<{ updated: number; taskTypes: string[] }> {
    const { fromProvider, toProvider, toModel, taskTypes } = options;

    const { inArray } = await import('drizzle-orm');

    // Получаем все конфиги с нужным провайдером
    const allConfigs = await db.select().from(aiModelConfigs);

    const toUpdate = allConfigs.filter(c => {
        const matchesProvider = c.provider === fromProvider;
        const matchesTaskTypes = !taskTypes || taskTypes.length === 0 || taskTypes.includes(c.taskType);
        return matchesProvider && matchesTaskTypes;
    });

    if (toUpdate.length === 0) {
        return { updated: 0, taskTypes: [] };
    }

    const taskTypesToUpdate = toUpdate.map(c => c.taskType);

    // Авто-определение contextWindow для новой модели
    let newContextWindow: number | null = null;
    try {
        const resolved = await fetchModelContextWindow(toProvider as AIProvider, toModel);
        if (resolved) {
            newContextWindow = resolved;
            console.log(`[AIConfig] 📏 Bulk update: определён contextWindow для ${toProvider}/${toModel}: ${Math.round(resolved / 1000)}K`);
        }
    } catch (e) {
        console.warn(`[AIConfig] ⚠️ Bulk update: не удалось определить contextWindow для ${toProvider}/${toModel}`);
    }

    const updateData: any = {
        provider: toProvider,
        model: toModel,
        updatedAt: new Date(),
    };
    if (newContextWindow) {
        updateData.contextWindow = newContextWindow;
    }

    await db.update(aiModelConfigs)
        .set(updateData)
        .where(inArray(aiModelConfigs.taskType, taskTypesToUpdate));

    // Очищаем кэш для всех обновлённых задач
    for (const taskType of taskTypesToUpdate) {
        configCache.delete(taskType as AITaskType);
    }

    console.log(`[AIConfig] ✅ Bulk update: обновлено ${taskTypesToUpdate.length} конфигов: ${fromProvider} → ${toProvider}/${toModel}`);

    return { updated: toUpdate.length, taskTypes: taskTypesToUpdate };
}

/**
 * Проверить, настроены ли провайдеры
 */
export function checkProviderConfiguration(): {
    openai: boolean;
    deepseek: boolean;
    openrouter: boolean;
    custom: boolean;
    antigravity: boolean;
    defaultProvider: AIProvider | null;
} {
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasCustom = !!(process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_URL);
    const hasAntigravity = !!process.env.ANTIGRAVITY_URL;

    let defaultProvider: AIProvider | null = null;
    if (hasAntigravity) defaultProvider = 'antigravity';
    else if (hasCustom) defaultProvider = 'custom';
    else if (hasOpenRouter) defaultProvider = 'openrouter';
    else if (hasDeepSeek) defaultProvider = 'deepseek';
    else if (hasOpenAI) defaultProvider = 'openai';

    return {
        openai: hasOpenAI,
        deepseek: hasDeepSeek,
        openrouter: hasOpenRouter,
        custom: hasCustom,
        antigravity: hasAntigravity,
        defaultProvider,
    };
}
