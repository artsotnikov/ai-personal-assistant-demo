/**
 * Tool: delegate_task — Делегировать задачу суб-агенту
 * 
 * Запускает фоновую AI-задачу, результат доставляется через WebSocket.
 * AI может продолжить разговор, не дожидаясь завершения.
 * 
 * Вдохновлено OpenClaw sessions-spawn-tool.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { spawnSubagent, getAvailableSubagentTypes } from '../../subagentRegistry';

interface DelegateTaskInput {
    taskType: string;
    prompt: string;
    context?: string;
    entityIds?: number[];
    structuredContext?: Record<string, any>;
    model?: string;
    agentSlug?: string;
}

export const delegateTaskTool: ToolDefinition<DelegateTaskInput> = {
    name: 'delegate_task',
    description: `Делегировать задачу фоновому суб-агенту для асинхронного выполнения. Результат будет доставлен пользователю автоматически через WebSocket — ожидать не нужно.

Используй когда:
- Задача требует глубокого анализа, который займёт время
- Нужно создать объёмный контент (статья, план, исследование)
- Пользователь просит что-то проанализировать "подробно" или "детально"
- Можно делать задачу в фоне, пока продолжается разговор
- Нужна работа с браузером (регистрация, заполнение форм, скрапинг) → используй taskType: "browser_task" + agentSlug: "browser"

ВАЖНО ПРО КОНТЕКСТ:
Вместо того чтобы передавать длинные неструктурированные тексты в поле "context" (что сжигает токены и размывает фокус), старайся использовать:
1. entityIds — массив ID сущностей (например, из памяти, целей, задач), если агенту нужно с ними работать. Суб-агент получит строгую инструкцию выгрузить свежие данные сам.
2. structuredContext — JSON-объект с извлеченными конкретными данными (тема, имена, ключевые факты). Это дешевле и понятнее для суб-агента.
Текстовый context используй только для небольших пояснений или кусков чата, длинные тексты в нём будут пропущены через AI-суммаризатор.

Типы суб-агентов:
- "deep_analysis" — углублённый анализ данных, метрик, конкурентов
- "research" — исследование темы со всех сторон
- "content_creation" — написание текстов, постов, описаний
- "planning" — составление планов, стратегий, roadmap
- "browser_task" — работа с браузером (скрапинг, навигация, заполнение форм, регистрация). ОБЯЗАТЕЛЬНО УКАЗЫВАЙ agentSlug: "browser"!
- "custom" — произвольная задача

Дополнительно можно указать agentSlug для использования специализированного агента с доступом к tools (memory, documents, analytics):
- "business" — бизнес-анализ с полным доступом к tools
- "finance" — финансовый анализ с аналитикой
- "psychology" — психологический анализ
- "browser" — веб-агент с browser tools (для taskType: "browser_task")

НЕ используй для:
- Простых коротких ответов (ответь сам)
- Вопросов, требующих немедленного ответа
- Задач, где нужна интерактивность`,
    category: 'system',
    toolPack: 'delegation',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            taskType: {
                type: 'string',
                description: 'Тип суб-агента: deep_analysis, research, content_creation, planning, browser_task, custom',
                enum: ['deep_analysis', 'research', 'content_creation', 'planning', 'browser_task', 'custom'],
            },
            prompt: {
                type: 'string',
                description: 'Полный промпт — что именно суб-агент должен сделать. Будь конкретен и детален.',
            },
            context: {
                type: 'string',
                description: 'ОПЦИОНАЛЬНО: Строковый контекст. ВНИМАНИЕ: Избегай передачи огромных текстов (сотни строк). Если возможно, используй entityIds или structuredContext. Большие тексты будут автоматически сжаты суммаризатором.',
            },
            entityIds: {
                type: 'array',
                items: { type: 'number' },
                description: 'ОПЦИОНАЛЬНО: Массив ID сущностей, с которыми должен работать суб-агенту. Если передано, он получит строгую инструкцию выгрузить эти данные первой задачей. Предпочтительнее огромного текстового context.',
            },
            structuredContext: {
                type: 'object',
                description: 'ОПЦИОНАЛЬНО: Извлеченные конкретные данные (JSON-объект) вместо неструктурированного текста. Например {"userId": 1, "topic": "React"}. Предпочтительнее огромного текста.'
            },
            model: {
                type: 'string',
                description: 'Опциональная модель для суб-агента (например "openai/gpt-4o-mini" для быстрых задач). Если не указано — используется модель по умолчанию.',
            },
            agentSlug: {
                type: 'string',
                description: 'Опционально: использовать специализированного агента. "business" — бизнес-анализ с полным доступом к tools, "finance" — финансовый анализ с аналитикой, "psychology" — психологический анализ, "browser" — веб-агент с browser tools.',
                enum: ['business', 'finance', 'psychology', 'browser'],
            },
        },
        required: ['taskType', 'prompt'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        // Nesting Guard: суб-агенты не могут создавать суб-суб-агентов
        if (ctx.isSubagent) {
            return {
                success: false,
                error: 'Суб-агенты не могут создавать вложенные суб-агенты',
                displayText: '⛔ Делегирование задач из суб-агентов запрещено',
            };
        }

        try {
            const result = await spawnSubagent({
                parentMessageId: ctx.messageId,
                taskType: input.taskType,
                taskPrompt: input.prompt,
                context: input.context,
                entityIds: input.entityIds,
                structuredContext: input.structuredContext,
                modelOverride: input.model,
                agentSlug: input.agentSlug,
                broadcastStep: ctx.broadcastStep,
            });

            const spec = getAvailableSubagentTypes().find(s => s.type === input.taskType);

            return {
                success: true,
                data: result,
                displayText: `${spec?.icon || '🤖'} Задача делегирована суб-агенту "${spec?.name || input.taskType}" (run #${result.runId}). Результат будет доставлен автоматически.`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка делегирования задачи: ${error?.message || error}`,
            };
        }
    },
};
