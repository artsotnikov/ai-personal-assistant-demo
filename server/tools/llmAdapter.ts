/**
 * LLM Adapter — преобразование ToolDefinition в OpenAI function calling format
 * 
 * Обеспечивает совместимость с OpenAI chat.completions API:
 * - formatToolsForOpenAI: ToolDefinition[] → OpenAI tools format
 * - parseToolCallsFromResponse: ChatCompletion → ParsedToolCall[]
 */

import type { ToolDefinition, OpenAIToolFunction, ParsedToolCall } from './types';

/**
 * Преобразование ToolDefinition[] в формат OpenAI tools
 */
export function formatToolsForOpenAI(tools: ToolDefinition[]): OpenAIToolFunction[] {
    return tools.map(tool => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: 'object',
                properties: tool.inputSchema.properties,
                ...(tool.inputSchema.required && tool.inputSchema.required.length > 0
                    ? { required: tool.inputSchema.required }
                    : {}),
                additionalProperties: tool.inputSchema.additionalProperties ?? false,
            },
        },
    }));
}

/**
 * Парсинг tool_calls из ответа OpenAI chat.completions
 */
export function parseToolCallsFromResponse(
    choices: Array<{
        message?: {
            tool_calls?: Array<{
                id: string;
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
    }>
): ParsedToolCall[] {
    const message = choices[0]?.message;
    if (!message?.tool_calls || message.tool_calls.length === 0) {
        return [];
    }

    return message.tool_calls.map(tc => {
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(tc.function.arguments);
        } catch (e) {
            console.error(`[LLMAdapter] ❌ Ошибка парсинга arguments для ${tc.function.name}:`, e);
        }

        return {
            id: tc.id,
            name: tc.function.name,
            arguments: args,
        };
    });
}

/**
 * Парсинг tool_calls из сырого XML в тексте ответа
 * ( fallback для Anthropic Claude через OpenRouter, когда он возвращает XML вместо встроенных tools)
 */
export function parseXmlToolCalls(content: string, availableTools?: any[]): ParsedToolCall[] {
    const parsed: ParsedToolCall[] = [];
    if (!content) return parsed;

    // Очищаем от HTML-сущностей, если они есть (бывают после БД или прокси)
    let cleanContent = content
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');

    // Вариант 1: Структура Anthropic <function_calls><function_call><invoke name="...">...</invoke></function_call></function_calls>
    // Или просто <invoke name="...">...</invoke>
    const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
    let match;
    while ((match = invokeRegex.exec(cleanContent)) !== null) {
        const name = match[1];
        const argsStr = match[2];
        const args: Record<string, any> = {};
        
        // Парсим дочерние теги как аргументы
        const argRegex = /<([^>]+)>([\s\S]*?)<\/\1>/g;
        let argMatch;
        while ((argMatch = argRegex.exec(argsStr)) !== null) {
            let val = argMatch[2].trim();
            // Пытаемся распарсить как JSON если похоже на объект/массив
            if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
                try {
                    args[argMatch[1]] = JSON.parse(val);
                    continue;
                } catch (e) {}
            }
            
            if (val === 'true') args[argMatch[1]] = true;
            else if (val === 'false') args[argMatch[1]] = false;
            else if (!isNaN(Number(val)) && val !== '') args[argMatch[1]] = Number(val);
            else args[argMatch[1]] = val;
        }
        
        parsed.push({
            id: `call_${Math.random().toString(36).substr(2, 9)}`,
            name,
            arguments: args
        });
    }

    if (parsed.length > 0) return parsed;

    // Вариант 2: Прямые теги <tool_name>...</tool_name>
    if (availableTools && availableTools.length > 0) {
        for (const t of availableTools) {
            const toolName = t.function?.name || t.name;
            if (!toolName) continue;

            const toolTagRegex = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'g');
            let toolMatch;
            while ((toolMatch = toolTagRegex.exec(cleanContent)) !== null) {
                const argsStr = toolMatch[1];
                const args: Record<string, any> = {};
                
                // Пытаемся найти внутренние теги аргументов
                const argRegex = /<([^>]+)>([\s\S]*?)<\/\1>/g;
                let argMatch;
                let hasArgs = false;
                while ((argMatch = argRegex.exec(argsStr)) !== null) {
                    hasArgs = true;
                    let val = argMatch[2].trim();
                    if (val === 'true') args[argMatch[1]] = true;
                    else if (val === 'false') args[argMatch[1]] = false;
                    else if (!isNaN(Number(val)) && val !== '') args[argMatch[1]] = Number(val);
                    else args[argMatch[1]] = val;
                }

                // Если внутри нет тегов, но есть контент — возможно это единственный аргумент или JSON
                if (!hasArgs && argsStr.trim()) {
                    try {
                        const potentialArgs = JSON.parse(argsStr.trim());
                        if (typeof potentialArgs === 'object') {
                            Object.assign(args, potentialArgs);
                        }
                    } catch (e) {
                        // Если не JSON, возможно это упрощенный вызов инструмента с одним аргументом (нетипично, но для гибкости)
                    }
                }

                parsed.push({
                    id: `call_${Math.random().toString(36).substr(2, 9)}`,
                    name: toolName,
                    arguments: args
                });
            }
        }
    }

    return parsed;
}
