/**
 * Tool Registry — Централизованный реестр tools (Singleton)
 * 
 * Хранит все зарегистрированные ToolDefinition и ToolHook.
 * При старте приложения builtin tools регистрируются через initializeBuiltinTools().
 */

import type { ToolDefinition, ToolCategory, ToolHook } from './types';

class ToolRegistry {
    private tools = new Map<string, ToolDefinition>();
    private hooks: ToolHook[] = [];

    // ── Tool CRUD ──────────────────────────────────────────────

    /** Зарегистрировать tool */
    register(tool: ToolDefinition): void {
        if (this.tools.has(tool.name)) {
            console.warn(`[ToolRegistry] ⚠️ Tool "${tool.name}" уже зарегистрирован, перезаписываю`);
        }
        // Ensure isReadOnly is set (default false)
        const enrichedTool = { ...tool, isReadOnly: tool.isReadOnly ?? false };
        this.tools.set(tool.name, enrichedTool);
    }

    /** Удалить tool из реестра */
    unregister(name: string): void {
        this.tools.delete(name);
    }

    /** Получить tool по имени */
    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    /** Все зарегистрированные tools */
    getAll(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /** Tools по категории */
    getByCategory(category: ToolCategory): ToolDefinition[] {
        return this.getAll().filter(t => t.category === category);
    }

    /** Количество зарегистрированных tools */
    get size(): number {
        return this.tools.size;
    }

    // ── Hooks ──────────────────────────────────────────────────

    /** Зарегистрировать hook (сортируется по priority) */
    registerHook(hook: ToolHook): void {
        this.hooks.push(hook);
        this.hooks.sort((a, b) => a.priority - b.priority);
    }

    /** Получить все hooks (отсортированные по priority) */
    getHooks(): ToolHook[] {
        return this.hooks;
    }
}

/** Глобальный singleton */
export const toolRegistry = new ToolRegistry();
