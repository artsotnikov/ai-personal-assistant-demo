/**
 * Context Reflector — Рефлексивный цикл обогащения контекста
 * 
 * "Подумай перед тем, как отвечать"
 * 
 * Этот модуль запускается ПЕРЕД финальным агентом.
 * Цель: проактивно найти недостающие данные, чтобы агент мог дать 
 * полный ответ без уточняющих вопросов пользователю.
 */

import { formatContextForPrompt, formatMessagesForPrompt, type RelevantContext } from "./contextBuilder";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { toolRegistry } from "./tools/toolRegistry";
import { executeReActLoop } from "./tools/executionEngine";
import type { ToolDefinition } from "./tools/types";
import { BroadcastStepFn } from "./agentOrchestrator";

// ============================================================================
// Константы
// ============================================================================

const MAX_REFLECTION_ITERATIONS = 3; // Максимум 3 круга "подумал -> запросил -> подумал"

const REFLECTION_SYSTEM_PROMPT = `
Ты — Внутренний Аналитик (Context Reflector). Твоя задача — подготовить идеальный контекст для Агента, который будет отвечать пользователю.

ТВОЯ ЦЕЛЬ:
Прочитать чат и имеющийся контекст, и понять: **Чего НЕ ХВАТАЕТ для исчерпывающего ответа?**

ТЫ НЕ ОТВЕЧАЕШЬ ПОЛЬЗОВАТЕЛЮ. Ты только ищешь информацию.

АЛГОРИТМ:
1. Проанализируй вопрос пользователя и текущий контекст.
2. Представь, какой должен быть идеальный ответ (с цифрами, фактами, деталями).
3. Проверь, есть ли эти данные в контексте.
4. ЕСЛИ ДАННЫХ НЕТ — ВЫЗОВИ ИНСТРУМЕНТЫ (Tools), чтобы их найти.
5. ЕСЛИ ДАННЫЕ ЕСТЬ — просто напиши "COMPLETE".

ДОСТУПНЫЕ ИНСТРУМЕНТЫ (Read-Only):
- search_facts / search_knowledge / search_notes — для поиска в базе знаний
- get_metrics — для бизнес-метрик
- get_goals — для целей и планов
- get_avito_* / get_stats_* — для внешней статистики (если доступны)

ПРАВИЛА:
- НЕ пытайся отвечать пользователю.
- НЕ вызывай изменяющие инструменты (create_*, update_*, send_*).
- НЕ вызывай browser инструменты (browser_open, browser_act, browser_read, browser_fill, browser_click) — они тебе НЕДОСТУПНЫ. Работа с браузером выполняется отдельным агентом.
- НЕ пытайся регистрироваться на сайтах, заполнять формы или взаимодействовать с веб-страницами.
- Если вопрос философский или "привет", и данные не нужны — отвечай "COMPLETE".
- Будь жадным до данных: если спрашивают "как дела?", лучше загрузить метрики, цели и задачи, чем не загрузить ничего.
- Если задача требует работы с браузером — напиши "COMPLETE" (задача будет делегирована browser агенту).
`;

// ============================================================================
// Основная логика
// ============================================================================

/**
 * Запуск рефлексивного цикла
 */
export async function runReflectionLoop(
    userMessage: string,
    initialContext: RelevantContext,
    agentSlug: string,
    sessionId: string,
    messageId: number,
    broadcastStep?: BroadcastStepFn
): Promise<RelevantContext> {
    console.log(`🤔 [Reflector] Запуск рефлексивного цикла для агента ${agentSlug}`);

    let currentContext = { ...initialContext };

    // Метаданные рефлексии для UI
    let totalIterations = 0;
    let totalToolCalls = 0;
    const toolNames: string[] = [];

    // 1. Получаем только Read-Only tools
    // Берём только read-only tools, ИСКЛЮЧАЯ browser tools (они бесполезны в рефлексии
    // и дублируют работу browser субагента)
    const allTools = toolRegistry.getAll();
    const EXCLUDED_FROM_REFLECTION = new Set(['browser_open', 'browser_act', 'browser_read']);
    const readOnlyTools = allTools.filter(t => t.isReadOnly && !EXCLUDED_FROM_REFLECTION.has(t.name));

    if (readOnlyTools.length === 0) {
        console.warn(`[Reflector] Нет доступных read-only инструментов. Пропуск.`);
        (currentContext as any)._reflectionMeta = { iterations: 0, toolCalls: 0, tools: [], preview: 'Нет read-only инструментов' };
        return currentContext;
    }

    const aiConfig = await getAIClientForTask('agent_reflection').catch(() =>
        getAIClientForTask('agent_core') // Fallback если нет спец конфига
    );

    // 2. Итеративный цикл
    const allToolCallDetails: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    for (let i = 1; i <= MAX_REFLECTION_ITERATIONS; i++) {
        totalIterations = i;
        const contextSection = formatContextForPrompt(currentContext);
        const history = formatMessagesForPrompt(currentContext.recentMessages.slice(0, -1));

        const messages = [
            { role: "system" as const, content: REFLECTION_SYSTEM_PROMPT },
            { role: "system" as const, content: `ТЕКУЩИЙ КОНТЕКСТ:\n${contextSection}` },
            ...history,
            { role: "user" as const, content: `Сообщение пользователя: "${userMessage}"\n\nЧего не хватает? Действуй.` }
        ];

        // 3. ReAct Loop с ограниченным набором read-only tools
        const result = await executeReActLoop({
            messages,
            tools: readOnlyTools,
            aiConfig,
            context: {
                sessionId,
                messageId,
                agentSlug: 'reflector',
                isSubagent: true
            },
            maxIterations: 8,
            agentSlug: 'reflector',
            broadcastStep,
            phase: 'reflection',
        });

        // 4. Если tools не вызывались — контекст достаточен
        if (result.toolCalls.length === 0) {
            console.log(`[Reflector] Итерация ${i}: Инструменты не вызывались. Завершаем цикл.`);
            break;
        }

        totalToolCalls += result.toolCalls.length;
        toolNames.push(...result.toolCalls.map(tc => tc.toolName));
        allToolCallDetails.push(...result.toolCalls.map(tc => ({ toolName: tc.toolName, input: tc.input, success: tc.result.success })));

        console.log(`[Reflector] Итерация ${i}: Выполнено ${result.toolCalls.length} вызовов.`);

        // 5. Вливаем УСПЕШНЫЕ результаты tools в documentsContext как ad-hoc данные для финального агента
        // Фейловые tool calls не включаются — они создают шум и не несут полезных данных
        const successfulCalls = result.toolCalls.filter(tc => tc.result.success);
        const failedCount = result.toolCalls.length - successfulCalls.length;
        if (failedCount > 0) {
            console.log(`[Reflector] Итерация ${i}: ${failedCount} tool call(s) завершились с ошибкой — не включены в reflectionContext.`);
        }
        const toolOutputs = successfulCalls.map(tc =>
            `🔧 Результат ${tc.toolName} (${JSON.stringify(tc.input)}):\n${tc.result.displayText}`
        ).join('\n\n');

        const reflectionDoc = `🔍 ДАННЫЕ ИЗ РЕФЛЕКСИИ (Итерация ${i}):\n${toolOutputs}`;

        currentContext.reflectionContext = currentContext.reflectionContext
            ? `${currentContext.reflectionContext}\n\n${reflectionDoc}`
            : reflectionDoc;

        // Ранняя остановка: если собрано достаточно данных — не тратим время
        if (totalToolCalls >= 8) {
            console.log(`[Reflector] Достаточно данных (${totalToolCalls} tool calls). Ранняя остановка.`);
            break;
        }

        // Если модель написала "COMPLETE" в контенте - выходим
        if (result.content.includes("COMPLETE")) {
            break;
        }
    }

    // Прикрепляем метаданные для UI (используются в summaryFn оркестратора)
    const preview = currentContext.reflectionContext
        ? currentContext.reflectionContext.substring(0, 300)
        : 'Дополнительные данные не потребовались';
    (currentContext as any)._reflectionMeta = {
        iterations: totalIterations,
        toolCalls: totalToolCalls,
        tools: Array.from(new Set(toolNames)),
        preview,
        // Детальная сводка вызовов рефлектора — для инъекции в промпт основного агента,
        // чтобы он видел ЧТО ИМЕННО уже найдено и не дублировал те же запросы
        toolCallsSummary: allToolCallDetails.length > 0
            ? allToolCallDetails.map(tc =>
                `• ${tc.toolName}(${JSON.stringify(tc.input)})`
            ).join('\n')
            : '',
        // Массив вызовов для Duplicate Guard в executionEngine
        allToolCallDetails,
    };

    return currentContext;
}
