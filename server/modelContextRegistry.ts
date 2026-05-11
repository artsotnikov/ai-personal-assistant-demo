/**
 * Model Context Registry — Автоопределение размера контекстного окна AI-моделей
 * 
 * Стратегия (приоритет):
 * 1. БД (поле contextWindow в aiModelConfigs) — пользователь может переопределить
 * 2. OpenRouter API (GET /api/v1/models) — автоматический fetch при сохранении конфига
 * 3. Fallback для прямых провайдеров (DeepSeek API, OpenAI) — минимальный маппинг
 * 4. Безопасный дефолт: 32K
 */

import type { AIProvider } from "@shared/schema";

// Безопасный дефолт, если ничего не определилось.
// 128K = DeepSeek V3.2 (минимальная модель в рабочем workflow).
const SAFE_DEFAULT_CONTEXT = 128_000;

// RAM-кеш данных OpenRouter (TTL 24 часа)
let openRouterModelsCache: Map<string, number> | null = null;
let openRouterCacheTimestamp = 0;
const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

/**
 * Минимальный fallback для прямых API провайдеров.
 * Используется ТОЛЬКО если нет данных из БД и OpenRouter.
 * Ключ — точное имя модели в API провайдера.
 */
const DIRECT_PROVIDER_FALLBACK: Record<string, number> = {
    // DeepSeek прямой API (V4 — модели обновлены в 2026)
    'deepseek-v4-flash': 128_000,
    'deepseek-v4-pro': 128_000,
    // OpenAI прямой API
    'gpt-4.1-mini': 128_000,
    'gpt-4.1': 128_000,
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'o3-mini': 128_000,
    'o4-mini': 128_000,
};

/**
 * Определить размер контекстного окна для модели.
 * 
 * @param provider - Провайдер ('openrouter', 'deepseek', 'openai', 'custom')
 * @param model - Название модели (как в API)
 * @param dbContextWindow - Значение из БД (если уже сохранено)
 * @returns Размер контекстного окна в токенах
 */
export async function resolveContextWindow(
    provider: AIProvider,
    model: string,
    dbContextWindow?: number | null,
): Promise<number> {
    // 1. БД — приоритет (пользователь мог задать вручную или уже закешировано)
    if (dbContextWindow && dbContextWindow > 0) {
        return dbContextWindow;
    }

    // 2. OpenRouter API — для провайдера openrouter
    if (provider === 'openrouter') {
        const fromApi = await getOpenRouterContextLength(model);
        if (fromApi) {
            return fromApi;
        }
    }

    // 3. Fallback для прямых провайдеров
    if (provider === 'deepseek' || provider === 'openai') {
        const fallback = DIRECT_PROVIDER_FALLBACK[model];
        if (fallback) {
            return fallback;
        }
    }

    // 4. Безопасный дефолт
    console.warn(`[ContextRegistry] ⚠️ Неизвестная модель ${provider}/${model}, используем дефолт ${SAFE_DEFAULT_CONTEXT}`);
    return SAFE_DEFAULT_CONTEXT;
}

/**
 * Получить context_length из OpenRouter API (с RAM-кешем).
 * 
 * Загружает весь список моделей OpenRouter, кеширует в RAM на 24 часа.
 * При следующем вызове — берёт из кеша.
 */
async function getOpenRouterContextLength(modelId: string): Promise<number | null> {
    try {
        // Проверяем кеш
        if (openRouterModelsCache && Date.now() - openRouterCacheTimestamp < OPENROUTER_CACHE_TTL_MS) {
            return openRouterModelsCache.get(modelId) || null;
        }

        // Загружаем список моделей
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            console.warn('[ContextRegistry] OPENROUTER_API_KEY не настроен, пропускаем API lookup');
            return null;
        }

        console.log('[ContextRegistry] 🔄 Загрузка списка моделей OpenRouter...');
        
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': process.env.APP_URL || 'https://ai-assistant.app',
            },
            signal: AbortSignal.timeout(10_000), // 10с таймаут
        });

        if (!response.ok) {
            console.error(`[ContextRegistry] ❌ OpenRouter API вернул ${response.status}`);
            return null;
        }

        const data = await response.json() as { data?: Array<{ id: string; context_length?: number }> };
        
        if (!data.data || !Array.isArray(data.data)) {
            console.error('[ContextRegistry] ❌ Неожиданный формат ответа OpenRouter');
            return null;
        }

        // Строим кеш
        openRouterModelsCache = new Map();
        for (const model of data.data) {
            if (model.id && model.context_length) {
                openRouterModelsCache.set(model.id, model.context_length);
            }
        }
        openRouterCacheTimestamp = Date.now();

        console.log(`[ContextRegistry] ✅ Загружено ${openRouterModelsCache.size} моделей из OpenRouter`);

        return openRouterModelsCache.get(modelId) || null;
    } catch (error: any) {
        console.error('[ContextRegistry] ❌ Ошибка загрузки моделей OpenRouter:', error?.message || error);
        return null;
    }
}

/**
 * Получить context_length для конкретной модели через OpenRouter API
 * (отдельный запрос, когда полный список не нужен).
 * 
 * Используется при создании/обновлении конфига для точного определения.
 */
export async function fetchModelContextWindow(
    provider: AIProvider,
    model: string,
): Promise<number | null> {
    if (provider === 'openrouter') {
        return getOpenRouterContextLength(model);
    }

    // Для прямых провайдеров — fallback маппинг
    if (provider === 'deepseek' || provider === 'openai') {
        return DIRECT_PROVIDER_FALLBACK[model] || null;
    }

    return null;
}

/**
 * Сбросить кеш OpenRouter (при необходимости)
 */
export function clearContextRegistryCache(): void {
    openRouterModelsCache = null;
    openRouterCacheTimestamp = 0;
    console.log('[ContextRegistry] Кеш сброшен');
}

/**
 * Получить безопасный дефолт
 */
export function getSafeDefaultContextWindow(): number {
    return SAFE_DEFAULT_CONTEXT;
}
