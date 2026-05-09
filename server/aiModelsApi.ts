/**
 * AI Models API — получение списка моделей от провайдеров
 * 
 * Поддерживаемые провайдеры:
 * - OpenAI: https://api.openai.com/v1/models
 * - OpenRouter: https://openrouter.ai/api/v1/models
 * - DeepSeek: https://api.deepseek.com/v1/models
 * - Custom: OpenAI-совместимый API
 * 
 * При ошибках API используются статические fallback-списки популярных моделей.
 */

const FETCH_TIMEOUT_MS = 15_000; // 15 секунд таймаут для API вызовов

export interface AIModel {
    id: string;
    name: string;
    provider: 'openai' | 'openrouter' | 'deepseek' | 'custom' | 'antigravity';
    contextLength?: number;
    description?: string;
}

// ─── Статические fallback-списки популярных моделей ───

const FALLBACK_OPENAI_MODELS: AIModel[] = [
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', contextLength: 1047576 },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai', contextLength: 1047576 },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'openai', contextLength: 1047576 },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextLength: 128000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextLength: 128000 },
    { id: 'o3-mini', name: 'o3-mini', provider: 'openai', contextLength: 200000 },
    { id: 'o1', name: 'o1', provider: 'openai', contextLength: 200000 },
    { id: 'o1-mini', name: 'o1-mini', provider: 'openai', contextLength: 128000 },
];

const FALLBACK_OPENROUTER_MODELS: AIModel[] = [
    { id: 'openai/gpt-4.1', name: 'OpenAI: GPT-4.1', provider: 'openrouter', contextLength: 1047576 },
    { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1 Mini', provider: 'openrouter', contextLength: 1047576 },
    { id: 'openai/gpt-4.1-nano', name: 'OpenAI: GPT-4.1 Nano', provider: 'openrouter', contextLength: 1047576 },
    { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', provider: 'openrouter', contextLength: 128000 },
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini', provider: 'openrouter', contextLength: 128000 },
    { id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', provider: 'openrouter', contextLength: 200000 },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet', provider: 'openrouter', contextLength: 200000 },
    { id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku', provider: 'openrouter', contextLength: 200000 },
    { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', provider: 'openrouter', contextLength: 1048576 },
    { id: 'google/gemini-2.5-flash-lite', name: 'Google: Gemini 2.5 Flash Lite', provider: 'openrouter', contextLength: 1048576 },
    { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash', provider: 'openrouter', contextLength: 1048576 },
    { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek: Chat V3', provider: 'openrouter', contextLength: 163840 },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek: R1', provider: 'openrouter', contextLength: 163840 },
    { id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick', provider: 'openrouter', contextLength: 1048576 },
    { id: 'meta-llama/llama-4-scout', name: 'Meta: Llama 4 Scout', provider: 'openrouter', contextLength: 512000 },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen: 2.5 72B', provider: 'openrouter', contextLength: 131072 },
];

const FALLBACK_DEEPSEEK_MODELS: AIModel[] = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', provider: 'deepseek' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', provider: 'deepseek' },
];

/**
 * Fetch с таймаутом
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Получение моделей OpenAI
 */
export async function getOpenAIModels(): Promise<AIModel[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.log('⚠️ OPENAI_API_KEY не настроен');
        return FALLBACK_OPENAI_MODELS;
    }

    try {
        const response = await fetchWithTimeout('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!response.ok) {
            console.error(`[AIModels] OpenAI API error: ${response.status} ${response.statusText}`);
            return FALLBACK_OPENAI_MODELS;
        }

        const data = await response.json();
        const models = (data.data || [])
            .filter((m: any) => m.id.startsWith('gpt-') || m.id.includes('o1') || m.id.includes('o3'))
            .map((m: any) => ({
                id: m.id,
                name: m.id,
                provider: 'openai' as const,
            }))
            .sort((a: AIModel, b: AIModel) => a.id.localeCompare(b.id));

        if (models.length === 0) {
            console.warn('[AIModels] OpenAI вернул пустой список моделей, используем fallback');
            return FALLBACK_OPENAI_MODELS;
        }

        console.log(`[AIModels] ✅ OpenAI: ${models.length} моделей загружено`);
        return models;
    } catch (error: any) {
        console.error('[AIModels] ❌ Ошибка получения моделей OpenAI:', error?.message || error);
        return FALLBACK_OPENAI_MODELS;
    }
}

/**
 * Получение моделей OpenRouter
 */
export async function getOpenRouterModels(): Promise<AIModel[]> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.log('⚠️ OPENROUTER_API_KEY не настроен');
        return FALLBACK_OPENROUTER_MODELS;
    }

    try {
        console.log('[AIModels] Запрос моделей OpenRouter...');
        const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': process.env.APP_URL || 'https://ai-assistant.app',
                'X-Title': 'AI Personal Assistant',
            },
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error(`[AIModels] OpenRouter API error: ${response.status} ${response.statusText}`, body.slice(0, 200));
            return FALLBACK_OPENROUTER_MODELS;
        }

        const data = await response.json();
        const models = (data.data || [])
            .map((m: any) => ({
                id: m.id,
                name: m.name || m.id,
                provider: 'openrouter' as const,
                contextLength: m.context_length,
                description: m.description,
            }))
            .sort((a: AIModel, b: AIModel) => {
                // Приоритетные модели поднимаем наверх
                const priorityModels = [
                    'openai/gpt-4.1',
                    'openai/gpt-4o',
                    'openai/gpt-4o-mini',
                    'anthropic/claude-sonnet-4',
                    'anthropic/claude-3.5-sonnet',
                    'anthropic/claude-3.5-haiku',
                    'google/gemini-2.5',
                    'deepseek/deepseek-chat',
                    'deepseek/deepseek-r1',
                ];

                const aPriority = priorityModels.findIndex(p => a.id.includes(p));
                const bPriority = priorityModels.findIndex(p => b.id.includes(p));

                if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
                if (aPriority !== -1) return -1;
                if (bPriority !== -1) return 1;

                return a.id.localeCompare(b.id);
            });

        if (models.length === 0) {
            console.warn('[AIModels] OpenRouter вернул пустой список моделей, используем fallback');
            return FALLBACK_OPENROUTER_MODELS;
        }

        console.log(`[AIModels] ✅ OpenRouter: ${models.length} моделей загружено`);
        return models;
    } catch (error: any) {
        const isTimeout = error?.name === 'AbortError';
        const msg = isTimeout ? 'Таймаут запроса (15с)' : (error?.message || String(error));
        console.error(`[AIModels] ❌ Ошибка получения моделей OpenRouter: ${msg}`);
        if (isTimeout) {
            console.error('[AIModels] 💡 Возможно, сервер не может достучаться до openrouter.ai — проверьте сеть/прокси');
        }
        return FALLBACK_OPENROUTER_MODELS;
    }
}

/**
 * Получение моделей DeepSeek
 */
export async function getDeepSeekModels(): Promise<AIModel[]> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        console.log('⚠️ DEEPSEEK_API_KEY не настроен');
        return FALLBACK_DEEPSEEK_MODELS;
    }

    try {
        const response = await fetchWithTimeout('https://api.deepseek.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!response.ok) {
            console.error(`[AIModels] DeepSeek API error: ${response.status} ${response.statusText}`);
            return FALLBACK_DEEPSEEK_MODELS;
        }

        const data = await response.json();
        const models = (data.data || [])
            .map((m: any) => ({
                id: m.id,
                name: m.id,
                provider: 'deepseek' as const,
            }))
            .sort((a: AIModel, b: AIModel) => a.id.localeCompare(b.id));

        if (models.length === 0) {
            console.warn('[AIModels] DeepSeek вернул пустой список моделей, используем fallback');
            return FALLBACK_DEEPSEEK_MODELS;
        }

        console.log(`[AIModels] ✅ DeepSeek: ${models.length} моделей загружено`);
        return models;
    } catch (error: any) {
        console.error('[AIModels] ❌ Ошибка получения моделей DeepSeek:', error?.message || error);
        return FALLBACK_DEEPSEEK_MODELS;
    }
}

/**
 * Получение моделей с кастомного API (OpenAI-совместимый эндпоинт)
 */
export async function getCustomModels(): Promise<AIModel[]> {
    const apiKey = process.env.CUSTOM_API_KEY;
    const baseURL = process.env.CUSTOM_API_URL;
    if (!apiKey || !baseURL) {
        console.log('⚠️ CUSTOM_API_KEY или CUSTOM_API_URL не настроены');
        return [];
    }

    try {
        const modelsUrl = baseURL.endsWith('/') ? `${baseURL}models` : `${baseURL}/models`;
        const response = await fetchWithTimeout(modelsUrl, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!response.ok) {
            console.error(`[AIModels] Custom API error: ${response.status} ${response.statusText}`);
            // Для custom провайдера нет статического fallback — возвращаем подсказку
            return [{ id: process.env.CUSTOM_DEFAULT_MODEL || 'custom-model', name: process.env.CUSTOM_DEFAULT_MODEL || 'Custom Model', provider: 'custom' }];
        }

        const data = await response.json();
        const models = (data.data || [])
            .map((m: any) => ({
                id: m.id,
                name: m.name || m.id,
                provider: 'custom' as const,
                contextLength: m.context_length,
            }))
            .sort((a: AIModel, b: AIModel) => a.id.localeCompare(b.id));

        if (models.length === 0) {
            console.warn('[AIModels] Custom API вернул пустой список, добавляем модель из CUSTOM_DEFAULT_MODEL');
            return [{ id: process.env.CUSTOM_DEFAULT_MODEL || 'custom-model', name: process.env.CUSTOM_DEFAULT_MODEL || 'Custom Model', provider: 'custom' }];
        }

        console.log(`[AIModels] ✅ Custom API: ${models.length} моделей загружено`);
        return models;
    } catch (error: any) {
        console.error('[AIModels] ❌ Ошибка получения моделей Custom API:', error?.message || error);
        // Возвращаем хотя бы дефолтную модель из env
        return [{ id: process.env.CUSTOM_DEFAULT_MODEL || 'custom-model', name: process.env.CUSTOM_DEFAULT_MODEL || 'Custom Model', provider: 'custom' }];
    }
}

/**
 * Получение моделей Anti-Gravity (специальный JSON-RPC прокси)
 */
export async function getAntigravityModels(): Promise<AIModel[]> {
    // В будущем здесь может быть реальный запрос к прокси для списка моделей,
    // пока отдаем список поддерживаемых моделей из спецификации.
    return [
        { 
            id: 'gemini-3.1-pro-high', 
            name: 'Anti-Gravity: Gemini 3.1 Pro (High)', 
            provider: 'antigravity', 
            contextLength: 2000000,
            description: 'Флагманская модель с огромным контекстом'
        },
        { 
            id: 'gemini-3.1-pro-low', 
            name: 'Anti-Gravity: Gemini 3.1 Pro (Low)', 
            provider: 'antigravity', 
            contextLength: 1000000,
            description: 'Оптимизированная версия Pro'
        },
        { 
            id: 'gemini-3.1-flash', 
            name: 'Anti-Gravity: Gemini 3.1 Flash', 
            provider: 'antigravity', 
            contextLength: 1000000,
            description: 'Быстрая и легкая модель'
        },
    ];
}

/**
 * Получение моделей по провайдеру
 */
export async function getModelsByProvider(provider: string): Promise<AIModel[]> {
    console.log(`[AIModels] Запрос моделей для провайдера: ${provider}`);
    switch (provider) {
        case 'openai':
            return getOpenAIModels();
        case 'openrouter':
            return getOpenRouterModels();
        case 'deepseek':
            return getDeepSeekModels();
        case 'custom':
            return getCustomModels();
        case 'antigravity':
            return getAntigravityModels();
        default:
            console.warn(`[AIModels] Неизвестный провайдер: ${provider}`);
            return [];
    }
}

/**
 * Получение всех моделей от всех провайдеров
 */
export async function getAllModels(): Promise<AIModel[]> {
    const [openai, openrouter, deepseek, custom, antigravity] = await Promise.all([
        getOpenAIModels(),
        getOpenRouterModels(),
        getDeepSeekModels(),
        getCustomModels(),
        getAntigravityModels(),
    ]);

    return [...openai, ...openrouter, ...deepseek, ...custom, ...antigravity];
}

/**
 * Получение списка доступных провайдеров
 */
export function getAvailableProviders(): { id: string; name: string; available: boolean }[] {
    return [
        { id: 'openai', name: 'OpenAI', available: !!process.env.OPENAI_API_KEY },
        { id: 'openrouter', name: 'OpenRouter', available: !!process.env.OPENROUTER_API_KEY },
        { id: 'deepseek', name: 'DeepSeek', available: !!process.env.DEEPSEEK_API_KEY },
        { id: 'custom', name: 'Custom API', available: !!(process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_URL) },
        { id: 'antigravity', name: 'Anti-Gravity', available: true }, // Всегда доступен, т.к. есть дефолтные URL/Auth
    ];
}
