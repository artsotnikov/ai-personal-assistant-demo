/**
 * Tool Resolver — определяет какие tools доступны для конкретного запроса
 * 
 * v2: фильтрация по agent profile (категории tools для каждого агента).
 * Каждый агент получает ТОЛЬКО релевантные для него tools,
 * что уменьшает токены промпта и снижает вероятность ненужных tool calls.
 */

import type { ToolDefinition, ToolCategory } from './types';
import { toolRegistry } from './toolRegistry';
import { getAlwaysIncludePacks } from './toolPackMeta';

export interface ResolveParams {
    agentSlug: string;
    /** Необязательно: дополнительные категории сверх профиля агента */
    extraCategories?: ToolCategory[];
    /** Необязательно: конкретные tools, которые нужно включить/исключить */
    include?: string[];
    exclude?: string[];
}

// ============================================================================
// Agent Tool Profiles — какие категории tools доступны каждому агенту
// ============================================================================

/**
 * Профиль агента — определяет доступные категории tools.
 * 'all' — доступны все tools (для универсальных агентов).
 */
type AgentToolProfile = ToolCategory[] | 'all';

const AGENT_TOOL_PROFILES: Record<string, AgentToolProfile> = {
    // Бизнес-агент: полный доступ ко всем tools
    business: 'all',

    // Финансовый агент: память, планирование, документы, аналитика
    finance: ['memory', 'planning', 'documents', 'analytics'],

    // Психологический агент: память, планирование и документы
    // Получает remember_fact, update_profile, get_recent_messages (memory),
    // get_goals, update_goal (planning), search_notes (notes/documents)
    psychology: ['memory', 'planning', 'documents'],

    // Проактивный агент: память, планирование, документы, аналитика (без system — не спавнит суб-агенты)
    proactive: ['memory', 'planning', 'analytics', 'documents'],

    // Event handler: память, планирование, документы, аналитика (без system — не спавнит суб-агенты)
    event_handler: ['memory', 'planning', 'documents', 'analytics'],

    // Стратегический советник: чтение данных для анализа (без записи)
    advisor: ['memory', 'planning', 'analytics', 'documents'],

    // Веб-агент (browser): все tools, delegate_task исключается через Nesting Guard
    browser: 'all',

    // Дефолтный профиль для неизвестных агентов — все tools
    _default: 'all',
};

// ============================================================================
// Resolver
// ============================================================================

/**
 * Получить список tools, доступных для данного запроса.
 * 
 * Логика:
 * 1. Берём профиль агента (доступные категории)
 * 2. Фильтруем tools по категориям
 * 3. Применяем include/exclude overrides
 * 4. Логируем результат
 */
export function resolveToolsForRequest(params: ResolveParams): ToolDefinition[] {
    const allTools = toolRegistry.getAll();
    const profile = AGENT_TOOL_PROFILES[params.agentSlug] ?? AGENT_TOOL_PROFILES._default;

    // Если профиль 'all' и нет фильтров — быстрый путь
    if (profile === 'all' && !params.exclude?.length && !params.include?.length && !params.extraCategories?.length) {
        return allTools;
    }

    // Собираем разрешённые категории
    const allowedCategories = new Set<ToolCategory>(
        profile === 'all'
            ? (['memory', 'planning', 'documents', 'analytics', 'system'] as ToolCategory[])
            : profile
    );

    // Добавляем extra categories
    if (params.extraCategories) {
        for (const cat of params.extraCategories) {
            allowedCategories.add(cat);
        }
    }

    let filtered = allTools.filter(t => allowedCategories.has(t.category));

    // Include override: добавить конкретные tools даже если их категория не в профиле
    if (params.include?.length) {
        const includeSet = new Set(params.include);
        const alreadyNames = new Set(filtered.map(t => t.name));
        for (const tool of allTools) {
            if (includeSet.has(tool.name) && !alreadyNames.has(tool.name)) {
                filtered.push(tool);
            }
        }
    }

    // Exclude override: убрать конкретные tools
    if (params.exclude?.length) {
        const excludeSet = new Set(params.exclude);
        filtered = filtered.filter(t => !excludeSet.has(t.name));
    }

    return filtered;
}

/**
 * Получить или зарегистрировать профиль агента
 */
export function setAgentToolProfile(agentSlug: string, categories: ToolCategory[]): void {
    AGENT_TOOL_PROFILES[agentSlug] = categories;
}

/**
 * Получить информацию о профиле агента (для отладки/логирования)
 */
export function getAgentToolProfile(agentSlug: string): { categories: string[]; toolCount: number } {
    const profile = AGENT_TOOL_PROFILES[agentSlug] ?? AGENT_TOOL_PROFILES._default;
    const tools = resolveToolsForRequest({ agentSlug });

    return {
        categories: profile === 'all' ? ['all'] : profile,
        toolCount: tools.length,
    };
}

// ============================================================================
// Tool Pack Resolver (Universal Agent)
// ============================================================================

/**
 * Получить tools по списку tool packs.
 * 
 * Используется Universal Agent — Intent Classifier определяет нужные packs,
 * и мы включаем ТОЛЬКО tools из этих packs (вместо all).
 * 
 * @param packs — массив pack имён, напр. ["core", "business_metrics", "web_access"]
 * @returns ToolDefinition[] — отфильтрованный список tools
 */
export function resolveToolsByPacks(packs: string[]): ToolDefinition[] {
    // Автоматически добавляем обязательные паки (alwaysInclude: true)
    const alwaysPacks = getAlwaysIncludePacks();
    const enrichedPacks = Array.from(new Set([...alwaysPacks, ...packs]));

    const packSet = new Set(enrichedPacks);
    const allTools = toolRegistry.getAll();
    const filtered = allTools.filter(t => packSet.has(t.toolPack));

    const added = alwaysPacks.filter(p => !packs.includes(p));
    if (added.length > 0) {
        console.log(`[ToolPacks] 🔒 Auto-included packs: [${added.join(', ')}]`);
    }
    console.log(`[ToolPacks] 📦 Packs: [${enrichedPacks.join(', ')}] → ${filtered.length}/${allTools.length} tools: [${filtered.map(t => t.name).join(', ')}]`);

    return filtered;
}
