/**
 * Intent Classifier — Классификатор намерений (Этап 6)
 * 
 * Заменяет Router Agent. Вместо выбора slug агента возвращает:
 * - domain: область знаний
 * - intent: конкретное намерение пользователя
 * - toolPacks: необходимые пакеты инструментов
 * - expertiseSlugs: подходящие экспертизы из реестра
 * - confidence: уверенность классификации
 * - complexity: сложность задачи (low/medium/high)
 * 
 * Для complexity: high → генерирует план перед ReAct Loop.
 */

import { db } from "./db";
import { sessionContext, type SessionContext, type DataClassification } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { getAllExpertises, getExpertiseByDomain, getExpertiseBySlug, ALL_TOOL_PACKS } from "./expertiseRegistry";
import type { Expertise } from "@shared/schema";

// ============================================================================
// Типы
// ============================================================================

/**
 * Уровень сложности задачи
 */
export type TaskComplexity = 'low' | 'medium' | 'high';

/**
 * Результат классификации интента
 */
export interface ClassificationResult {
    domain: string;                      // "business", "finance", "psychology", "general"
    intent: string;                      // "analyze_metrics", "ask_advice", "set_goal" и т.д.
    toolPacks: string[];                 // ["core", "business_metrics", "web_access"]
    expertiseSlugs: string[];            // ["business"] — может быть >1 для кросс-доменных
    confidence: number;                  // 0-1
    complexity: TaskComplexity;          // low/medium/high
    detectedTopics: string[];            // Обнаруженные темы
    reasoning: string;                   // Обоснование
    hasQuestion: boolean;                // Содержит ли вопрос
    isAction?: boolean;                  // Является ли явным распоряжением (ACTION)
    needsContext: boolean;               // Нужен ли контекст истории (упоминания "тот", "это", "мы обсуждали")
    dataClassification: DataClassification;
    plan?: string;                       // План при complexity: high
}

/**
 * Сырой ответ AI-классификатора (до resolve)
 */
interface RawClassification {
    domain: string;
    intent: string;
    complexity: TaskComplexity;
    detectedTopics: string[];
    confidence: number;
    reasoning: string;
    hasQuestion: boolean;
    isAction: boolean;
    needsContext: boolean;
    dataClassification: DataClassification;
}

// ============================================================================
// Промпт классификатора
// ============================================================================

function buildClassifierPrompt(
    message: string,
    expertises: Expertise[],
    currentContext?: SessionContext | null,
): string {
    // Формируем описание экспертиз
    const expertiseDescriptions = expertises.map(exp => {
        const domains = (exp.triggerDomains as string[] | null) || [];
        const toolPacks = (exp.toolPacks as string[] | null) || [];
        return `- ${exp.slug}: ${exp.name}
  Домены: ${domains.join(", ") || "fallback"}
  Tool packs: ${toolPacks.join(", ")}`;
    }).join("\n");

    // Контекст сессии
    let contextInfo = "";
    if (currentContext) {
        contextInfo = `
Текущий контекст сессии:
- Активная тема: ${currentContext.currentTopics || "не определена"}
- Настроение: ${currentContext.mood || "нейтральное"}
- Предыдущая экспертиза: ${currentContext.activeAgentSlug || "нет"}`;
    }

    return `Проанализируй сообщение пользователя и классифицируй его намерение.

Доступные экспертизы:
${expertiseDescriptions}

${contextInfo}

Сообщение пользователя:
"${message}"

Правила классификации:

1. **domain** — выбери domain из доступных экспертиз (slug экспертизы или один из её доменов). Для общих/бытовых вопросов используй "general".
   - Если это чистое распоряжение по календарю/заметкам/напоминаниям — используй "assistant".

2. **intent** — определи конкретное намерение:
    - "manage_calendar" — создать, изменить, удалить событие в календаре
    - "manage_notes" — создать заметку, добавить пункт в список
    - "manage_tasks" — создать, показать, обновить, завершить задачу в планировщике TickTick
    - "set_reminder" — установить напоминание
   - "analyze" — анализ данных, метрик, ситуации
   - "plan" — планирование, декомпозиция, стратегия
   - "brainstorm" — генерация идей
   - "ask_advice" — запрос совета, рекомендации
   - "track_progress" — отслеживание прогресса, целей
   - "set_goal" — постановка целей, задач
   - "remember" — сохранение информации (факт)
   - "search" — поиск информации, фактов
   - "quick_lookup" — быстрый справочный запрос (погода, курс валют, время, "что такое X")
   - "daily_overview" — обзор дел на сегодня, расписание, список задач, итоги дня
   - "chat" — обычная беседа, приветствие
   - "compare" — сравнение вариантов
   - "explain" — объяснение концепции
   - или другой подходящий intent

3. **complexity** — определи сложность задачи (Action-задачи обычно low):
   - "low" — простой вопрос или ПРЯМОЕ РАСПОРЯЖЕНИЕ (один-два шага: привет, "запиши X", "что такое X", "поставь встречу").
   - "medium" — требует контекста и размышлений (совет, анализ, рекомендация).
   - "high" — мульти-шаговая задача: планирование, комплексный анализ.

4. **isAction** — является ли это ЯВНЫМ РАСПОРЯЖЕНИЕМ (сделай, запиши, поставь в календарь, создай заметку).
   True, если пользователь хочет, чтобы ты ВЫПОЛНИЛ действие, а не просто ответил.

5. **hasQuestion** — содержит ли сообщение ВОПРОС (спрашивает, просит совет, оценку, сравнение).

6. **needsContext** — содержит ли сообщение ссылки на прошлый контекст ("тот", "мы обсуждали", "последний", "его", "её", "вчера") или требует знания фактов о пользователе.

7. **dataClassification** — содержит ли СТРУКТУРИРОВАННЫЕ ДАННЫЕ... (оставь как есть)

Ответ строго в JSON:
{
  "domain": "slug экспертизы или домен",
  "intent": "тип намерения",
  "complexity": "low|medium|high",
  "isAction": true,
  "detectedTopics": ["тема1", "тема2"],
  "confidence": 0.9,
  "reasoning": "обоснование классификации",
  "hasQuestion": false,
  "dataClassification": {
    "hasStructuredData": false,
    "dataType": "none",
    "confidence": 0.9
  }
}`;
}

// ============================================================================
// AI Classifications
// ============================================================================

/**
 * Parse raw AI response into RawClassification
 */
function parseClassifierResponse(content: string): RawClassification | null {
    try {
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        const validComplexities: TaskComplexity[] = ['low', 'medium', 'high'];

        const dataClassification: DataClassification = parsed.dataClassification
            ? {
                hasStructuredData: !!parsed.dataClassification.hasStructuredData,
                dataType: ['competitor_info', 'financial_metrics', 'document', 'none'].includes(parsed.dataClassification.dataType)
                    ? parsed.dataClassification.dataType
                    : 'none',
                confidence: typeof parsed.dataClassification.confidence === 'number'
                    ? parsed.dataClassification.confidence
                    : 0.5,
            }
            : { hasStructuredData: false, dataType: 'none' as const, confidence: 0.5 };

        // ─── Guard: повышенный порог для financial_metrics и competitor_info ───
        // Аудио-транскрипты часто содержат числа (цены, даты), что создаёт ложные срабатывания.
        // Порог 0.8 отсекает неуверенные классификации.
        const HIGH_CONFIDENCE_TYPES = ['financial_metrics', 'competitor_info'];
        if (
            dataClassification.hasStructuredData &&
            HIGH_CONFIDENCE_TYPES.includes(dataClassification.dataType) &&
            dataClassification.confidence < 0.8
        ) {
            console.log(`[IntentClassifier] 🛡️ Data classification guard: ${dataClassification.dataType} отклонён (confidence ${dataClassification.confidence} < 0.8)`);
            dataClassification.hasStructuredData = false;
            dataClassification.dataType = 'none';
        }

        return {
            domain: parsed.domain || 'general',
            intent: parsed.intent || 'chat',
            complexity: validComplexities.includes(parsed.complexity) ? parsed.complexity : 'medium',
            detectedTopics: parsed.detectedTopics || [],
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
            reasoning: parsed.reasoning || "Автоматическая классификация",
            hasQuestion: typeof parsed.hasQuestion === 'boolean' ? parsed.hasQuestion : true,
            isAction: typeof parsed.isAction === 'boolean' ? parsed.isAction : false,
            needsContext: typeof parsed.needsContext === 'boolean' ? parsed.needsContext : false,
            dataClassification,
        };
    } catch {
        return null;
    }
}

async function resolveExpertises(raw: RawClassification): Promise<{
    expertiseSlugs: string[];
    toolPacks: string[];
    expertise: Expertise | null;
}> {
    // ⚡ БЫСТРЫЙ ПУТЬ: для простых распоряжений форсируем экспертизу ассистента (исполнителя)
    if (raw.isAction && raw.complexity === 'low') {
        const assistantExp = await getExpertiseBySlug('assistant');
        if (assistantExp) {
            return {
                expertiseSlugs: ['assistant'],
                toolPacks: (assistantExp.toolPacks as string[]) || ALL_TOOL_PACKS,
                expertise: assistantExp,
            };
        }
    }

    // Ищем экспертизу по домену (используем существующий алгоритм из expertiseRegistry)
    const expertise = await getExpertiseByDomain(raw.domain);

    if (expertise) {
        const toolPacks = (expertise.toolPacks as string[] | null) || ['core'];
        return {
            expertiseSlugs: [expertise.slug],
            toolPacks,
            expertise,
        };
    }

    // Fallback
    return {
        expertiseSlugs: ['general'],
        toolPacks: ['core'],
        expertise: null,
    };
}

// ============================================================================
// Adaptive Planning (complexity: high)
// ============================================================================

/**
 * Генерация плана для сложных задач (complexity: high)
 */
export async function generatePlan(
    message: string,
    classification: ClassificationResult,
): Promise<string> {
    const aiConfig = await getAIClientForTask('intent_planning');

    const prompt = `Пользователь задал сложный вопрос, требующий мульти-шагового подхода.

Классификация:
- Домен: ${classification.domain}
- Намерение: ${classification.intent}
- Темы: ${classification.detectedTopics.join(', ')}
- Экспертиза: ${classification.expertiseSlugs.join(', ')}

Сообщение пользователя:
"${message}"

Составь краткий план ответа (3-5 шагов). Для каждого шага укажи:
1. Что нужно сделать
2. Какие данные/tools понадобятся

Формат: нумерованный список, кратко и по делу. Не более 200 слов.`;

    try {
        const messages = [
            { role: "system" as const, content: "Ты — планировщик задач. Создаёшь краткие структурированные планы для сложных запросов." },
            { role: "user" as const, content: prompt },
        ];

        const result = await callWithFallback(aiConfig, messages);
        const plan = result.content?.trim();

        if (plan) {
            console.log(`[IntentClassifier] 📋 План сгенерирован (${plan.length} символов)`);
            return plan;
        }
    } catch (error: any) {
        console.error('[IntentClassifier] ⚠️ Ошибка генерации плана:', error?.message || error);
    }

    return '';
}

// ============================================================================
// Main Classification Function
// ============================================================================

/**
 * Классификация интента сообщения
 * 
 * Включает:
 * - AI-классификацию (domain, intent, complexity)
 * - Resolve экспертиз и tool packs из реестра
 * - Fallback на general при ошибках
 */
export async function classifyIntent(
    message: string,
    currentContext?: SessionContext | null
): Promise<ClassificationResult> {
    const aiConfig = await getAIClientForTask('intent_classification');
    const activeExpertises = await getAllExpertises(true);

    if (activeExpertises.length === 0) {
        console.warn('[IntentClassifier] ⚠️ Нет активных экспертиз, используем fallback');
        return createFallbackResult('Нет активных экспертиз');
    }

    // Формируем промпт
    const prompt = buildClassifierPrompt(message, activeExpertises, currentContext);
    const messages = [
        {
            role: "system" as const,
            content: aiConfig.systemPrompt || "Ты — интеллектуальный классификатор намерений. Анализируй сообщения и определяй domain, intent и complexity. Отвечай только валидным JSON.",
        },
        { role: "user" as const, content: prompt },
    ];

    // AI-вызов с fallback
    try {
        const result = await callWithFallback(aiConfig, messages);
        const content = result.content?.trim();

        if (content) {
            const raw = parseClassifierResponse(content);
            if (raw) {
                // Resolve expertise from registry
                const resolved = await resolveExpertises(raw);

                const classification: ClassificationResult = {
                    domain: raw.domain,
                    intent: raw.intent,
                    toolPacks: resolved.toolPacks,
                    expertiseSlugs: resolved.expertiseSlugs,
                    confidence: raw.confidence,
                    complexity: raw.complexity,
                    detectedTopics: raw.detectedTopics,
                    reasoning: raw.reasoning,
                    hasQuestion: raw.hasQuestion,
                    isAction: raw.isAction,
                    needsContext: raw.needsContext,
                    dataClassification: raw.dataClassification,
                };

                console.log(`[IntentClassifier] ✅ domain=${classification.domain}, intent=${classification.intent}, complexity=${classification.complexity}, expertise=${classification.expertiseSlugs.join(',')} (confidence: ${classification.confidence}, provider: ${result.provider})`);
                return classification;
            }
        }
        console.warn('[IntentClassifier] ⚠️ Пустой или некорректный ответ от AI');
    } catch (error: any) {
        console.error('[IntentClassifier] ❌ Ошибка классификации (все провайдеры):', error?.message || error);
    }

    // Финальный fallback
    console.warn('[IntentClassifier] ⚠️ Все попытки не удались, используем fallback: general');
    return createFallbackResult('Все попытки классификации не удались');
}

/**
 * Создание fallback-результата
 */
function createFallbackResult(reason: string): ClassificationResult {
    return {
        domain: 'general',
        intent: 'chat',
        toolPacks: ['core'],
        expertiseSlugs: ['general'],
        confidence: 0.3,
        complexity: 'low',
        detectedTopics: [],
        reasoning: `Fallback: ${reason}`,
        hasQuestion: true,
        isAction: false,
        needsContext: true, // По умолчанию для безопасности считаем, что контекст нужен
        dataClassification: { hasStructuredData: false, dataType: 'none', confidence: 0.5 },
    };
}

// ============================================================================
// Session Context (переносим из routerAgent для обратной совместимости)
// ============================================================================

/**
 * Получение или создание контекста сессии
 */
export async function getOrCreateSessionContext(sessionId: string): Promise<SessionContext> {
    const existing = await db.select()
        .from(sessionContext)
        .where(eq(sessionContext.sessionId, sessionId))
        .limit(1);

    if (existing.length > 0) {
        return existing[0];
    }

    const newContext = await db.insert(sessionContext)
        .values({
            sessionId,
            mood: "neutral",
        })
        .returning();

    return newContext[0];
}

/**
 * Обновление контекста сессии
 */
export async function updateSessionContext(
    sessionId: string,
    updates: Partial<{
        currentTopics: string;
        mood: string;
        activeAgentSlug: string;
        openQuestions: string;
        mentionedEntities: string;
    }>
): Promise<void> {
    await db.update(sessionContext)
        .set({
            ...updates,
            updatedAt: new Date(),
        })
        .where(eq(sessionContext.sessionId, sessionId));
}
