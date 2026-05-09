/**
 * Tool System — Типы и интерфейсы
 * 
 * Единая система определений для Tool Registry, Execution Engine и Hooks.
 */

// ============================================================================
// Tool Definition
// ============================================================================

/** Категория tool (для группировки и UI) */
export type ToolCategory = 'memory' | 'planning' | 'documents' | 'analytics' | 'system';

/** Tool Pack — логическая группа tools, подключаемая по потребности */
export type ToolPack = 'core' | 'goals' | 'business_metrics' | 'web_access' | 'web_browser' | 'scheduling' | 'delegation' | 'calendar' | 'ticktick' | 'skill_management';

/** Уровень доступа */
export type ToolPermission = 'read' | 'write';

/** JSON Schema property */
export interface JSONSchemaProperty {
    type: string;
    description?: string;
    enum?: (string | number)[];
    items?: JSONSchemaProperty;
    default?: unknown;
    format?: string;
}

/** JSON Schema для параметров tool (subset для OpenAI) */
export interface JSONSchema {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
}

/** Контекст выполнения tool */
export interface ToolExecutionContext {
    sessionId: string;
    messageId: number;
    userId?: number;
    /** true если tool вызывается из суб-агента (Nesting Guard) */
    isSubagent?: boolean;
    agentSlug?: string;
    /** true если активирован режим быстрого выполнения (Fast Path) */
    _isFastPath?: boolean;
    /** Callback для отправки processing_step событий в UI (проброс из ReAct Loop) */
    broadcastStep?: (step: any) => void;
}

/** Результат выполнения tool */
export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
    /** Текст для отображения AI (передаётся как tool result content) */
    displayText: string;
    /** Опционально: скриншот/изображение в base64 (PNG). При наличии — передаётся как multipart content для vision model */
    imageBase64?: string;
}

/** Обработчик tool */
export type ToolHandler<TInput = Record<string, unknown>> = (
    input: TInput,
    context: ToolExecutionContext
) => Promise<ToolResult>;

/** Определение одного tool */
export interface ToolDefinition<TInput = any> {
    /** Уникальное имя (snake_case), напр. "create_reminder" */
    name: string;
    /** Описание для LLM — когда вызывать этот tool */
    description: string;
    /** Категория для группировки */
    category: ToolCategory;
    /** Tool Pack — к какому пакету относится */
    toolPack: ToolPack;
    /** JSON Schema параметров */
    inputSchema: JSONSchema;
    /** read = безопасный, write = мутирующий */
    permission: ToolPermission;
    /** Функция-обработчик */
    handler: ToolHandler<TInput>;
    /** Таймаут в ms (default 30_000) */
    timeout?: number;
    /** Можно ли вызывать в read-only режиме (Reflective Loop) */
    isReadOnly?: boolean;
}

// ============================================================================
// Hook / Middleware
// ============================================================================

/** Информация о вызове tool */
export interface ToolCall {
    id: string;
    toolName: string;
    input: Record<string, unknown>;
    timestamp: Date;
}

/** Результат hook-проверки */
export interface HookResult {
    blocked: boolean;
    reason?: string;
    modifiedInput?: Record<string, unknown>;
}

/** Middleware hook */
export interface ToolHook {
    name: string;
    /** Меньше = выполняется раньше */
    priority: number;
    beforeExecute?: (call: ToolCall) => Promise<HookResult>;
    afterExecute?: (call: ToolCall, result: ToolResult) => Promise<void>;
}

// ============================================================================
// Execution Engine
// ============================================================================

/** Лог одного вызова tool */
export interface ToolCallLog {
    toolName: string;
    input: Record<string, unknown>;
    result: ToolResult;
    durationMs: number;
    iteration: number;
    /** ID вызова для связки с message (OpenAI tool_call_id) */
    toolCallId?: string;
}

/** Результат ReAct Loop */
export interface ReActResult {
    /** Финальный текст ответа AI */
    content: string;
    /** Суммарные токены по всем итерациям */
    tokensUsed: number;
    /** Лог всех tool calls */
    toolCalls: ToolCallLog[];
    /** Количество итераций цикла */
    iterations: number;
    /** Slug агента */
    agentSlug: string;
    /** Использовался ли fallback */
    usedFallback: boolean;
    /** Model Cascade: использовалась ли финальная (дорогая) модель */
    usedFinalModel?: boolean;
}

// ============================================================================
// OpenAI-compatible types (tool calling)
// ============================================================================

/** OpenAI function definition format */
export interface OpenAIToolFunction {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: JSONSchema;
    };
}

/** Parsed tool call from LLM response */
export interface ParsedToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
