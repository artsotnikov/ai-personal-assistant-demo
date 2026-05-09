/**
 * Built-in Tool Hooks — встроенные middleware для tool execution
 * 
 * - loggingHook: логирует все вызовы tools
 * - validationHook: валидирует input по JSON Schema (basic)
 */

import type { ToolHook, ToolCall, HookResult, ToolResult } from './types';
import { toolRegistry } from './toolRegistry';

// ============================================================================
// Logging Hook — логирование всех tool calls
// ============================================================================

export const loggingHook: ToolHook = {
    name: 'logging',
    priority: 100, // выполняется последним из before-hooks

    async beforeExecute(call: ToolCall): Promise<HookResult> {
        console.log(`[ToolHook:logging] 🔧 Tool call: ${call.toolName}`, {
            id: call.id,
            input: call.input,
            timestamp: call.timestamp.toISOString(),
        });
        return { blocked: false };
    },

    async afterExecute(call: ToolCall, result: ToolResult): Promise<void> {
        const status = result.success ? '✅' : '❌';
        console.log(`[ToolHook:logging] ${status} Tool result: ${call.toolName}`, {
            success: result.success,
            error: result.error,
            displayText: result.displayText?.substring(0, 100),
        });
    },
};

// ============================================================================
// Validation Hook — базовая валидация input по schema
// ============================================================================

export const validationHook: ToolHook = {
    name: 'validation',
    priority: 10, // выполняется первым

    async beforeExecute(call: ToolCall): Promise<HookResult> {
        const tool = toolRegistry.get(call.toolName);
        if (!tool) {
            return { blocked: true, reason: `Tool "${call.toolName}" не найден в реестре` };
        }

        const schema = tool.inputSchema;
        if (!schema || !schema.properties) {
            return { blocked: false };
        }

        // Нормализация snake_case → camelCase в input
        // AI-модели часто отправляют goal_id вместо goalId, activity_type вместо activityType и т.д.
        const schemaKeys = Object.keys(schema.properties);
        const inputKeys = Object.keys(call.input);
        for (const inputKey of inputKeys) {
            if (inputKey.includes('_') && !schema.properties[inputKey]) {
                const camelKey = inputKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                if (schema.properties[camelKey] && call.input[camelKey] === undefined) {
                    call.input[camelKey] = call.input[inputKey];
                    delete call.input[inputKey];
                }
            }
        }

        // Проверяем required поля
        if (schema.required) {
            for (const requiredField of schema.required) {
                if (call.input[requiredField] === undefined || call.input[requiredField] === null) {
                    return {
                        blocked: true,
                        reason: `Отсутствует обязательное поле "${requiredField}" для tool "${call.toolName}"`,
                    };
                }
            }
        }

        // Проверяем типы (basic)
        for (const [key, value] of Object.entries(call.input)) {
            const propSchema = schema.properties[key];
            if (!propSchema) continue; // неизвестные поля пропускаем

            if (propSchema.type === 'string' && typeof value !== 'string') {
                return {
                    blocked: true,
                    reason: `Поле "${key}" должно быть строкой, получено ${typeof value}`,
                };
            }
            if (propSchema.type === 'number' && typeof value !== 'number') {
                return {
                    blocked: true,
                    reason: `Поле "${key}" должно быть числом, получено ${typeof value}`,
                };
            }
            if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
                return {
                    blocked: true,
                    reason: `Поле "${key}" должно быть boolean, получено ${typeof value}`,
                };
            }
        }

        return { blocked: false };
    },
};
