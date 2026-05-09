/**
 * Prompt Assembler — Сборка промпта из 5 слоёв
 * 
 * Слои:
 * 1. Persona    — общая «личность» ассистента (из БД или fallback)
 * 2. Expertise  — специализация (promptTemplate из expertises)
 * 3. Workflow   — инструкции по tools (TOOL_WORKFLOW_PROMPT)
 * 4. Tools      — описание доступных инструментов (текстовое)
 * 5. Context    — контекст памяти (профиль, факты, цели, сообщения)
 */

import { TOOL_WORKFLOW_PROMPT } from "./agents/toolWorkflowPrompt";
import { formatContextForPrompt, type RelevantContext } from "./contextBuilder";
import type { Expertise } from "@shared/schema";
import type { ChatMessage } from "./aiConfigService";

// ============================================================================
// Default Persona (fallback, если нет из БД)
// ============================================================================

const DEFAULT_PERSONA = `Ты — AI-ассистент, персональный помощник предпринимателя. 
Общайся на русском языке. Будь конкретным, полезным и проактивным.
Всегда используй данные из памяти для персонализации ответов.

## Твоя двойная роль:

1. **Исполнитель**: Выполняй прямые задания без оговорок. Сначала действуй — потом советуй.
2. **Советник**: Если в контексте есть «СТРАТЕГИЧЕСКОЕ ВИДЕНИЕ СОВЕТНИКА» с релевантным наблюдением — 
   упомяни его МЯГКО, когда это уместно:
   - «Кстати, я анализировал ситуацию и заметил...»
   - «Объективный взгляд: ...»
   - «Возможно, стоит обратить внимание на...»
   
   Правила советника:
   - Не навязывай — совет ≠ приказ. Предлагай, не настаивай
   - Не повторяй один совет в рамках одного диалога
   - Если задание срочное — сначала выполни, потом советуй
   - Если совет не релевантен текущему разговору — промолчи
   - Основывайся ТОЛЬКО на реальных данных из контекста и профиля`;

// ============================================================================
// Interfaces
// ============================================================================

export interface AssemblePromptOptions {
    /** Экспертиза из реестра (layer 2) */
    expertise: Expertise;

    /** Контекст памяти (layer 5) */
    context?: RelevantContext;

    /** Persona из БД (aiPrompts / aiModelConfigs), если есть (layer 1) */
    dbPersonaPrompt?: string | null;

    /** Описание доступных tools для текущего запроса (layer 4, опционально) */
    toolsDescription?: string;

    /** Контекст навыков (skills), если есть */
    skillsContext?: string;

    /** Предпочтения пользователя (стилевые паттерны) */
    preferencesContext?: string | null;

    /** План для сложных задач (complexity: high, опционально) */
    plan?: string;

    /** Размер контекстного окна текущей модели (токены). Передаётся в TokenBudgetManager */
    contextWindow?: number;

    /** Название модели для логирования бюджета */
    modelName?: string;

    /** Флаг ускоренного выполнения (Fast Path) */
    isFastPath?: boolean;
}

// ============================================================================
// Main assembler
// ============================================================================

/**
 * [CRITICAL: CACHE-FIRST DESIGN PATTERN]
 * 
 * Собирает массив системных сообщений из 5 слоёв для оптимизации префиксного кеширования (DeepSeek/Dipsic).
 * 
 * ⚠️ ПРАВИЛО ДЛЯ РАЗРАБОТЧИКОВ И AI-АГЕНТОВ:
 * Не объединяйте этот массив в одну строку! Разделение на ChatMessage[] позволяют 
 * провайдерам кешировать первый (стабильный) блок инструкций независимо от второго (динамичного).
 * 
 * Структура:
 * 1. Stable Block: Persona, Expertise, Workflow, Tools (100% статично) -> Высокий cache hit
 * 2. Dynamic Block: Plan, Skills, Preferences, Context (может меняться) -> Частичный cache hit
 */
export function assemblePrompt(options: AssemblePromptOptions): ChatMessage[] {
    const {
        expertise,
        context,
        dbPersonaPrompt,
        toolsDescription,
        skillsContext,
        preferencesContext,
        plan,
        contextWindow,
        modelName,
        isFastPath,
    } = options;

    const stableParts: string[] = [];
    const dynamicParts: string[] = [];

    // ── БЛОК 1: СТАБИЛЬНЫЕ ИНСТРУКЦИИ (Layers 1-4) ──
    
    // Layer 1: Persona
    const persona = dbPersonaPrompt && dbPersonaPrompt.trim().length > 0
        ? dbPersonaPrompt
        : DEFAULT_PERSONA;
    stableParts.push(persona);

    // Layer 2: Expertise
    stableParts.push(expertise.promptTemplate);

    // Layer 3: Workflow
    stableParts.push(TOOL_WORKFLOW_PROMPT);

    // Layer 4: Tools (самый большой и стабильный блок)
    if (toolsDescription && toolsDescription.trim().length > 0) {
        stableParts.push(`## Доступные инструменты:\n${toolsDescription}`);
    }

    // ── БЛОК 2: ДИНАМИЧЕСКИЙ КОНТЕКСТ (Layer 5 + Plan) ──

    // ⚡ FAST PATH DIRECTIVE
    if (isFastPath) {
        dynamicParts.push(`⚡ РЕЖИМ БЫСТРОГО ИСПОЛНИТЕЛЯ (Fast Path).
Твоя задача — выполнить распоряжение пользователя через инструменты.
Правила:
1. ИГНОРИРУЙ предыдущий «Алгоритм глубокого мышления» — он для сложных задач, не для тебя.
2. СРАЗУ вызови нужный инструмент (tool call / function call). Не рассуждай, не анализируй — ДЕЙСТВУЙ.
3. Если нужно несколько инструментов — вызови их ПАРАЛЛЕЛЬНО в одном ответе.
4. НЕ пиши текст перед вызовом. НЕ объясняй что будешь делать. Просто сделай function call.
5. После получения результата — коротко подтверди: «Готово», «Записал», «Создано».`);
    }

    // Skills
    if (skillsContext && skillsContext.trim().length > 0) {
        dynamicParts.push(skillsContext);
    }

    // Preferences
    if (preferencesContext && preferencesContext.trim().length > 0) {
        dynamicParts.push(preferencesContext);
    }

    // Plan
    if (plan && plan.trim().length > 0) {
        dynamicParts.push(`## План ответа:\nСледуй этому плану при формировании ответа:\n${plan}`);
    }

    // Layer 5: Context (включает профиль, факты, время)
    if (context) {
        const contextSection = formatContextForPrompt(context, contextWindow, modelName);
        dynamicParts.push(`## Контекст пользователя:\n${contextSection || "Контекст пока не накоплен."}`);
    } else {
        dynamicParts.push(`## Контекст пользователя:\nКонтекст пока не накоплен.`);
    }

    return [
        { role: 'system', content: stableParts.join("\n\n") },
        { role: 'system', content: dynamicParts.join("\n\n") }
    ];
}

// ============================================================================
// Response Phase Prompt (двухфазная генерация)
// ============================================================================

export interface AssembleResponsePromptOptions {
    /** Экспертиза из реестра (layer 2) */
    expertise: Expertise;

    /** Контекст памяти (layer 5) */
    context?: RelevantContext;

    /** Persona из БД (layer 1) */
    dbPersonaPrompt?: string | null;

    /** Контекст навыков */
    skillsContext?: string;

    /** Предпочтения пользователя */
    preferencesContext?: string | null;

    /** План для сложных задач */
    plan?: string;

    /** Размер контекстного окна */
    contextWindow?: number;

    /** Название модели */
    modelName?: string;

    /** Сводка реальных tool call results из Action Phase */
    actionResults: string;

    /** Флаг ускоренного выполнения (Fast Path) */
    isFastPath?: boolean;
}

/**
 * [CRITICAL: CACHE-FIRST DESIGN PATTERN]
 * 
 * Собирает массив системных сообщений для Response Phase.
 * Правило то же: Стабильные инструкции (Persona/Expertise) отделены от динамичных результатов.
 * 
 * ⚠️ ВАЖНО: Любые новые инструкции по стилю ответа добавлять В КОНЕЦ dynamicParts.
 */
export function assembleResponsePrompt(options: AssembleResponsePromptOptions): ChatMessage[] {
    const {
        expertise,
        context,
        dbPersonaPrompt,
        skillsContext,
        preferencesContext,
        plan,
        contextWindow,
        modelName,
        actionResults,
        isFastPath,
    } = options;

    const stableParts: string[] = [];
    const dynamicParts: string[] = [];

    // ── БЛОК 1: СТАБИЛЬНЫЕ ИНСТРУКЦИИ ──
    const persona = dbPersonaPrompt && dbPersonaPrompt.trim().length > 0
        ? dbPersonaPrompt
        : DEFAULT_PERSONA;
    stableParts.push(persona);
    stableParts.push(expertise.promptTemplate);

    // ── БЛОК 2: ДИНАМИЧЕСКИЙ КОНТЕКСТ И РЕЗУЛЬТАТЫ ──

    // Skills & Preferences
    if (skillsContext && skillsContext.trim().length > 0) {
        dynamicParts.push(skillsContext);
    }
    if (preferencesContext && preferencesContext.trim().length > 0) {
        dynamicParts.push(preferencesContext);
    }

    // Plan
    if (plan && plan.trim().length > 0) {
        dynamicParts.push(`## План ответа:\nСледуй этому плану при формировании ответа:\n${plan}`);
    }

    // Context
    if (context) {
        const contextSection = formatContextForPrompt(context, contextWindow, modelName);
        dynamicParts.push(`## Контекст пользователя:\n${contextSection || "Контекст пока не накоплен."}`);
    } else {
        dynamicParts.push(`## Контекст пользователя:\nКонтекст пока не накоплен.`);
    }

    // Action Results
    dynamicParts.push(`## РЕЗУЛЬТАТЫ ДЕЙСТВИЙ (из предыдущей фазы):\n${actionResults}`);

    // Fast Path
    if (isFastPath) {
        dynamicParts.push(`⚡ РЕЖИМ БЫСТРОГО ОТВЕТА (Fast Path).
В предыдущей фазе ты выполнил действия. Результаты — в секции «РЕЗУЛЬТАТЫ ДЕЙСТВИЙ».
Твоя задача — лаконично подтвердить выполнение. Пример: «Готово», «Задача создана», «Записал».
ВАЖНО: Всё, что в «РЕЗУЛЬТАТАХ ДЕЙСТВИЙ» — это ТЫ сам только что сделал. Не интерпретируй это как чужие данные.`);
    }

    // Response Instruction
    dynamicParts.push(`## ИНСТРУКЦИЯ ОТВЕТА (КРИТИЧНО — ЧИТАЙ ВНИМАТЕЛЬНО):
Ты сейчас в фазе ФОРМУЛИРОВКИ ОТВЕТА. Инструменты (tools) НЕДОСТУПНЫ.

ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе РЕАЛЬНЫХ результатов действий выше.
2. Если в результатах есть ✅ (success) — можешь подтвердить выполнение.
3. Если в результатах есть ❌ (ошибка) — ЧЕСТНО сообщи об ошибке.
4. НЕ УТВЕРЖДАЙ, что действие выполнено, если его НЕТ в результатах.
5. НЕ ОПИСЫВАЙ вызовы инструментов — они уже выполнены. Пиши ГОТОВЫЙ ответ.
6. Используй данные из контекста для персонализации ответа.
7. Будь конкретным и полезным.
8. ТЕКУЩИЙ ЗАПРОС пользователя — последнее сообщение с ролью user. Отвечай ИМЕННО на него.
9. Не путай ТЕКУЩИЙ запрос с ПРЕДЫДУЩИМИ темами из истории диалога. История нужна для понимания контекста, но ответ — на ПОСЛЕДНИЙ запрос.
10. В секции «ЧЕРНОВИК ОТВЕТА » может содержаться только статус («ищу информацию», «сейчас найду» и т.п.) или неполный анализ. ИГНОРИРУЙ такие статусы. Твоя задача — дать ПОЛНЫЙ, САМОСТОЯТЕЛЬНЫЙ ответ на основе РЕЗУЛЬТАТОВ ДЕЙСТВИЙ. Если в черновике есть полезная структура — можешь её использовать, но ПРИОРИТЕТ за РЕЗУЛЬТАТАМИ ДЕЙСТВИЙ.
11. НЕ ИМИТИРУЙ вызовы инструментов. Ты НЕ МОЖЕШЬ вызвать tools в этой фазе. Не пиши текст как будто ты вызываешь инструмент (например «вызываю search_facts...»). Просто сформулируй ГОТОВЫЙ ответ пользователю из РЕЗУЛЬТАТОВ ДЕЙСТВИЙ.`);

    return [
        { role: 'system', content: stableParts.join("\n\n") },
        { role: 'system', content: dynamicParts.join("\n\n") }
    ];
}
