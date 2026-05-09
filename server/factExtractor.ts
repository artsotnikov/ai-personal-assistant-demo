/**
 * Fact Extractor - Извлечение фактов из сообщений
 * 
 * Отвечает за:
 * - Извлечение ключевых фактов из сообщений пользователя через AI
 * - Сохранение фактов с привязкой к темам
 * - Обновление существующих фактов при противоречии
 */

import { db } from "./db";
import { facts, factRelations, type Fact, type InsertFact, type ProcessingStep, ORCHESTRATOR_STEPS } from "@shared/schema";
import type { BroadcastStepFn } from "./agentOrchestrator";
import { eq, and, sql } from "drizzle-orm";
import {
    createEmbedding,
    serializeEmbedding,
    findSimilarFacts,
    cosineSimilarity,
    parseEmbedding,
    searchFactsByQuery,
    type SimilarityResult,
} from "./embeddingService";
import { detectTopics, getOrCreateTopic, incrementTopicFactCount } from "./topicManager";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { splitTextIntoChunks, needsChunking, type TextChunk } from "./chunkService";

// AI-Judge пороги
const JUDGE_AUTO_DUPLICATE_THRESHOLD = 0.88;  // Выше — автоматический дубликат, AI не нужен
const JUDGE_CANDIDATE_THRESHOLD = 0.55;       // Ниже — точно новый факт, AI не нужен
// Серая зона 0.55–0.88 → вызываем AI-judge

// Legacy порог (используется как fallback если AI-judge недоступен)
const FACT_DUPLICATE_THRESHOLD = 0.80;

/**
 * Извлечённый факт из сообщения
 */
export interface ExtractedFact {
    topic: string;
    content: string;
    confidence: 'high' | 'medium' | 'low';
    importance?: number; // 1-5: quality gate для фильтрации
}

/**
 * Извлечение фактов из сообщения через AI
 * @param message - текущее сообщение
 * @param dialogContext - опциональный контекст последних сообщений диалога (для понимания контекста)
 */
export async function extractFacts(
    message: string,
    dialogContext?: string[]
): Promise<ExtractedFact[]> {
    const aiConfig = await getAIClientForTask('fact_extraction');

    // Формируем контекст диалога если есть
    const contextBlock = dialogContext && dialogContext.length > 0
        ? `## Предыдущий контекст диалога (для понимания):\n${dialogContext.map((m, i) => `[${i + 1}] ${m}`).join('\n')}\n\n`
        : '';

    // Pre-search: получаем существующие похожие факты из БД для предотвращения дублей на этапе генерации
    let existingFactsBlock = '';
    try {
        const existingFacts = await searchFactsByQuery(message, 10);
        if (existingFacts.length > 0) {
            const factsList = existingFacts
                .map(f => `- "${f.content}"`)
                .join('\n');
            existingFactsBlock = `## ⚠️ СУЩЕСТВУЮЩИЕ ФАКТЫ В ПАМЯТИ (НЕ ДУБЛИРУЙ ИХ):\n${factsList}\n\nЕсли новая информация УТОЧНЯЕТ или ОБНОВЛЯЕТ существующий факт — извлеки ТОЛЬКО НОВУЮ часть информации.\nЕсли информация УЖЕ ЕСТЬ в базе — НЕ извлекай, даже если формулировка другая.\n\n`;
        }
    } catch (error) {
        console.error('⚠️ Pre-search существующих фактов пропущен:', error);
    }

    const prompt = `Ты — модуль долгосрочной памяти AI-ассистента. Извлеки из сообщения пользователя ЦЕННЫЕ ФАКТЫ, которые стоит запомнить навсегда.

${existingFactsBlock}${contextBlock}## Текущее сообщение:
"""
${message}
"""

═══════════════════════════════════════════════════════════════
## CRITICAL RULES
═══════════════════════════════════════════════════════════════

### 1. SELF-CONTAINED (самодостаточный факт)
Каждый факт ДОЛЖЕН быть понятен человеку, который НЕ читал диалог.
Факт ОБЯЗАН содержать КОНКРЕТНЫЙ СУБЪЕКТ (кто/что).

❌ "Тариф стоит 18 тысяч в год" — КАКОЙ тариф?
✅ "Тариф сервиса Юздеск стоит 18 тысяч рублей в год"

❌ "Функция будет платной" — КАКАЯ функция?
✅ "Функция перепубликации объявлений на Avito будет платной"

### 2. ДЕТАЛИЗАЦИЯ — ВСЯ КОНКРЕТИКА
Факт должен содержать ВСЕ конкретные детали из сообщения:
- Числа, даты, суммы, метрики — обязательно
- Связи между объектами — как они относятся друг к другу
- Контекст: почему, зачем, для чего
- Если для полноты нужно 2-3 предложения — пиши 2-3 предложения

❌ СЛИШКОМ КОРОТКО: "Antigravity — IDE от Google"
✅ ХОРОШО: "Antigravity — это среда разработки (IDE) от Google со встроенным ИИ, аналог VS Code или Cursor. Пользователь использует её как инструмент для написания кода."

❌ СЛИШКОМ КОРОТКО: "Пользователь развивает SaaS"
✅ ХОРОШО: "Пользователь развивает собственный SaaS-сервис example-service.ru — инструмент для управления объявлениями на Avito с функциями перепубликации и управления ставками."

### 3. НЕ ИЗВЛЕКАЙ (полностью игнорируй)
- **Эмоции/настроения**: "устал", "скучаю", "раздражает", "бесит"
- **Сиюминутные желания**: "хочу отдохнуть", "надо бы сделать"
- **Вопросы** пользователя (это не факты)
- **Общие рассуждения** без конкретики
- **Факты без субъекта** (непонятно о чём/ком)
- **Эфемерные/временные данные**: "сейчас работаю", "только что отправил", "жду ответ"
- **Технические действия в диалоге**: "тестирую функцию", "проверяю работу системы"
- **Инструкции ассистенту**: "помоги с X", "расскажи про Y"

### 4. ИЗВЛЕКАЙ (ценные долгосрочные факты)
- Конкретные числа: цены, количества, даты, метрики
- Названия продуктов, сервисов, компаний, людей
- Статусы проектов с указанием проекта
- Проблемы с указанием контекста
- Планы с конкретными действиями и сроками
- Принятые решения ("решил сделать X")
- Бизнес-метрики (доход, конверсия, количество клиентов)
- **Всё, что пользователь явно просит запомнить** (даже если кажется неважным)

### 5. IMPORTANCE (важность 1-5)
- **5** — ключевое бизнес-решение, стратегия, крупная метрика
- **4** — конкретный план, проблема с контекстом, новый клиент/партнёр
- **3** — полезная информация, статус проекта, мнение о чём-то
- **2** — второстепенная деталь, предпочтение
- **1** — мелкий факт, малозначимая заметка

### 6. Формат темы: "Категория/Подтема"
Категории: Бизнес, Финансы, Технологии, Личное, Здоровье, Отношения, Заметки

═══════════════════════════════════════════════════════════════
## ПРИМЕРЫ
═══════════════════════════════════════════════════════════════

✅ ХОРОШИЕ ФАКТЫ (подробные, с контекстом):
- topic: "Бизнес/Продукт", content: "SaaS-сервис example-service.ru предоставляет инструменты для управления объявлениями на Avito, включая автоматическую перепубликацию и управление ставками. Сервис разрабатывается в среде Antigravity.", importance: 4, confidence: "high"
- topic: "Бизнес/Тарифы", content: "Тариф сервиса Юздеск с поддержкой API стоит 50 тысяч рублей в год. Это значительно дороже базового тарифа за 18 тысяч, но необходим для интеграции с ботом.", importance: 4, confidence: "high"
- topic: "Бизнес/Клиенты", content: "Клиентская база сервиса example-service.ru насчитывает около N активных пользователей.", importance: 5, confidence: "high"
- topic: "Бизнес/Решения", content: "Принято решение запустить тестовую рассылку о новой функции перепубликации на 100 пользователей перед массовой, чтобы проверить техническую нагрузку и собрать обратную связь.", importance: 5, confidence: "high"
- topic: "Личное/Заметки", content: "Бегемоты — опасные животные", importance: 1, confidence: "high" (по явному запросу "запомни")

❌ НЕ ИЗВЛЕКАЙ:
- "Пользователь хочет получить обратную связь" — эфемерное желание
- "Отправил письмо клиенту" — сиюминутное действие, без долгосрочной ценности
- "Тариф стоит 18к" — нет субъекта (КАКОЙ тариф?)
- "Сейчас тестирую бота" — технический момент
- "Помоги разобраться с настройками" — инструкция ассистенту

═══════════════════════════════════════════════════════════════

Извлеки ВСЕ ценные факты — не ограничивай количество. Из длинного сообщения может быть 10+ фактов.
Если ценных фактов нет — верни пустой массив [].
Лучше пропустить сомнительный факт, чем сохранить мусор (КРОМЕ явных запросов "запомни").

Ответ СТРОГО в JSON (массив объектов с полями: topic, content, confidence, importance):`;

    try {
        const result = await callWithFallback(aiConfig, [
            { role: "system", content: aiConfig.systemPrompt! },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "[]";

        try {
            // Убираем возможные markdown-обёртки
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            if (Array.isArray(parsed)) {
                return parsed.filter(f =>
                    f &&
                    typeof f.topic === 'string' &&
                    typeof f.content === 'string' &&
                    f.content.length > 0
                ).map(f => ({
                    topic: f.topic,
                    content: f.content,
                    confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium',
                    importance: typeof f.importance === 'number' ? Math.min(5, Math.max(1, f.importance)) : 3,
                }));
            }
        } catch (parseError) {
            console.error("Ошибка парсинга фактов:", parseError, "Ответ:", content);
        }

        return [];
    } catch (error: any) {
        console.error("Ошибка извлечения фактов:", error);
        return [];
    }
}

/**
 * AI-Judge вердикт
 */
type JudgeVerdict = 'DUPLICATE' | 'UPDATE' | 'NEW';

interface JudgeResult {
    verdict: JudgeVerdict;
    reason: string;
}

// Fallback system prompt (используется если в БД нет конфига fact_judge)
const JUDGE_FALLBACK_SYSTEM_PROMPT = `Ты — судья-аналитик фактов. Тебе даны два факта: НОВЫЙ (который хотят сохранить) и СУЩЕСТВУЮЩИЙ (уже в базе).

Твоя задача — определить отношение между ними. Ответь СТРОГО в JSON:
{"verdict": "DUPLICATE|UPDATE|NEW", "reason": "краткое пояснение"}

Правила:
- DUPLICATE — факты говорят об одном и том же, новый не добавляет информации
- UPDATE — факты об одном предмете, И новый ДОБАВЛЯЕТ конкретику (числа, даты, детали, контекст)
- NEW — факты о разных вещах, даже если тематика похожа

⚠️ ЗАЩИТА ОТ ДЕГРАДАЦИИ:
- Если СУЩЕСТВУЮЩИЙ факт ДЛИННЕЕ и ПОДРОБНЕЕ нового → это DUPLICATE, НЕ UPDATE
- UPDATE ТОЛЬКО когда новый факт содержит НОВУЮ информацию, которой нет в существующем
- Короткий/упрощённый факт НИКОГДА не является UPDATE для подробного существующего
- При сомнениях между UPDATE и DUPLICATE — выбирай DUPLICATE

Примеры:
НОВЫЙ: "Клиентская база — 150 пользователей" + СУЩЕСТВУЮЩИЙ: "Клиентская база — 131 пользователь" → {"verdict":"UPDATE","reason":"Обновлённое количество клиентов"}
НОВЫЙ: "Antigravity — IDE от Google" + СУЩЕСТВУЮЩИЙ: "Antigravity — IDE от Google со встроенным ИИ, аналог VS Code. Пользователь использует её для разработки SaaS и бота." → {"verdict":"DUPLICATE","reason":"Новый факт — упрощённая версия, не добавляет информации"}
НОВЫЙ: "Сайт работает на WordPress" + СУЩЕСТВУЮЩИЙ: "Сайт работает на WordPress" → {"verdict":"DUPLICATE","reason":"Идентичная информация"}
НОВЫЙ: "Тариф 1500 руб/мес" + СУЩЕСТВУЮЩИЙ: "Клиент Иванов платит 500 руб" → {"verdict":"NEW","reason":"Разные предметы: общий тариф vs конкретный клиент"}`;

/**
 * AI-Judge: вызывает дешёвую модель для классификации пары фактов
 */
async function judgeFactWithAI(
    newContent: string,
    existingContent: string,
    similarity: number,
    messageId?: number,
    broadcastStep?: BroadcastStepFn
): Promise<JudgeResult> {
    // Broadcast running event
    if (broadcastStep && messageId) {
        broadcastStep({
            type: 'processing_step',
            messageId,
            stepId: ORCHESTRATOR_STEPS.factJudge.id,
            stepName: ORCHESTRATOR_STEPS.factJudge.name,
            stepIcon: ORCHESTRATOR_STEPS.factJudge.icon,
            status: 'running',
            timestamp: new Date().toISOString(),
        });
    }
    const start = Date.now();
    try {
        const aiConfig = await getAIClientForTask('fact_judge');

        const systemPrompt = aiConfig.systemPrompt || JUDGE_FALLBACK_SYSTEM_PROMPT;

        const userPrompt = `Cosine similarity: ${(similarity * 100).toFixed(1)}%

НОВЫЙ ФАКТ: "${newContent}"
СУЩЕСТВУЮЩИЙ ФАКТ: "${existingContent}"

Ответь ТОЛЬКО JSON: {"verdict": "DUPLICATE|UPDATE|NEW", "reason": "..."}`;

        const result = await callWithFallback(aiConfig, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ]);

        const content = result.content?.trim() || '';
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const parsed = JSON.parse(cleanContent);
        const verdict = parsed.verdict?.toUpperCase();

        if (['DUPLICATE', 'UPDATE', 'NEW'].includes(verdict)) {
            console.log(`🧑‍⚖️ AI-Judge: ${verdict} (${parsed.reason || 'no reason'}) | sim=${(similarity * 100).toFixed(1)}%`);
            // Broadcast completed event
            if (broadcastStep && messageId) {
                broadcastStep({
                    type: 'processing_step',
                    messageId,
                    stepId: ORCHESTRATOR_STEPS.factJudge.id,
                    stepName: ORCHESTRATOR_STEPS.factJudge.name,
                    stepIcon: ORCHESTRATOR_STEPS.factJudge.icon,
                    status: 'completed',
                    duration: Date.now() - start,
                    output: {
                        summary: `${verdict}: ${parsed.reason || ''}`,
                        data: {
                            verdict,
                            reason: parsed.reason,
                            similarity: `${(similarity * 100).toFixed(1)}%`,
                            новый_факт: newContent.substring(0, 80),
                            существующий_факт: existingContent.substring(0, 80),
                        }
                    },
                    timestamp: new Date().toISOString(),
                });
            }
            return { verdict: verdict as JudgeVerdict, reason: parsed.reason || '' };
        }

        console.warn(`🧑‍⚖️ AI-Judge: невалидный verdict "${verdict}", fallback на cosine`);
    } catch (error: any) {
        console.error(`🧑‍⚖️ AI-Judge ошибка: ${error?.message || error}, fallback на cosine`);
        if (broadcastStep && messageId) {
            broadcastStep({
                type: 'processing_step',
                messageId,
                stepId: ORCHESTRATOR_STEPS.factJudge.id,
                stepName: ORCHESTRATOR_STEPS.factJudge.name,
                stepIcon: ORCHESTRATOR_STEPS.factJudge.icon,
                status: 'error',
                duration: Date.now() - start,
                error: `Fallback на cosine: ${error?.message || error}`,
                timestamp: new Date().toISOString(),
            });
        }
    }

    // Fallback: используем cosine similarity как раньше
    if (similarity >= FACT_DUPLICATE_THRESHOLD) {
        return { verdict: 'DUPLICATE', reason: 'cosine fallback' };
    }
    return { verdict: 'NEW', reason: 'cosine fallback' };
}

/**
 * Глобальная проверка на дубликат факта (по ВСЕМ темам)
 * Трёхуровневая система: auto-duplicate → AI-judge → new
 */
async function checkForDuplicate(
    newContent: string,
    newEmbedding: number[],
    messageId?: number,
    broadcastStep?: BroadcastStepFn
): Promise<{ isDuplicate: boolean; isUpdate?: boolean; existingFactId?: number; existingContent?: string; similarity?: number; reason?: string }> {
    try {
        const similarFacts = await findSimilarFacts(newEmbedding, 10);

        for (const similar of similarFacts) {
            // Уровень 0: Факт из того же сообщения → агент уже сохранил, пропускаем
            if (messageId && similar.sourceMessageId === messageId && similar.similarity >= JUDGE_CANDIDATE_THRESHOLD) {
                console.log(`🛡️ Same-message skip: факт уже сохранён агентом (sim=${(similar.similarity * 100).toFixed(1)}%)`);
                return {
                    isDuplicate: true,
                    existingFactId: similar.id,
                    existingContent: similar.content,
                    similarity: similar.similarity,
                    reason: 'same-message (agent already saved)'
                };
            }

            // Уровень 1: Автоматический дубликат (очевидно одинаковые)
            if (similar.similarity >= JUDGE_AUTO_DUPLICATE_THRESHOLD) {
                return {
                    isDuplicate: true,
                    existingFactId: similar.id,
                    existingContent: similar.content,
                    similarity: similar.similarity,
                    reason: 'auto-duplicate (sim ≥ 0.92)'
                };
            }

            // Уровень 2: Серая зона → AI-Judge
            if (similar.similarity >= JUDGE_CANDIDATE_THRESHOLD) {
                const judgeResult = await judgeFactWithAI(newContent, similar.content || '', similar.similarity, messageId, broadcastStep);

                if (judgeResult.verdict === 'DUPLICATE') {
                    return {
                        isDuplicate: true,
                        existingFactId: similar.id,
                        existingContent: similar.content,
                        similarity: similar.similarity,
                        reason: `AI-judge: ${judgeResult.reason}`
                    };
                }

                if (judgeResult.verdict === 'UPDATE') {
                    return {
                        isDuplicate: false,
                        isUpdate: true,
                        existingFactId: similar.id,
                        existingContent: similar.content,
                        similarity: similar.similarity,
                        reason: `AI-judge: ${judgeResult.reason}`
                    };
                }

                // verdict === 'NEW' → продолжаем проверку следующих кандидатов
            }
            // Уровень 3: similarity < 0.70 → точно новый, пропускаем
        }
    } catch (error) {
        // Fallback: ручной поиск если pgvector недоступен
        const allCurrentFacts = await db.select()
            .from(facts)
            .where(eq(facts.isCurrent, true));

        for (const fact of allCurrentFacts) {
            const factEmbedding = parseEmbedding(fact.embedding);
            if (!factEmbedding) continue;

            const similarity = cosineSimilarity(newEmbedding, factEmbedding);
            if (similarity >= FACT_DUPLICATE_THRESHOLD) {
                return {
                    isDuplicate: true,
                    existingFactId: fact.id,
                    existingContent: fact.content,
                    similarity,
                    reason: 'cosine fallback (no pgvector)'
                };
            }
        }
    }

    return { isDuplicate: false };
}

// checkFactUpdate удалена — логика обновления полностью покрыта checkForDuplicate + AI-Judge

/**
 * Сохранение факта с проверкой на дубликаты и обновления
 */
export async function saveFact(
    extractedFact: ExtractedFact,
    sourceMessageId?: number,
    messageId?: number,
    broadcastStep?: BroadcastStepFn
): Promise<Fact | null> {
    // 1. Получаем или создаём тему
    const topic = await getOrCreateTopic(extractedFact.topic);

    // 2. Создаём embedding для факта
    const embedding = await createEmbedding(extractedFact.content);

    // 3. Проверяем глобальный дубликат (AI-Judge + cosine)
    const duplicateCheck = await checkForDuplicate(extractedFact.content, embedding, messageId, broadcastStep);

    if (duplicateCheck.isDuplicate && duplicateCheck.existingFactId) {
        console.log(`🔄 Дубликат пропущен [${duplicateCheck.reason}] (sim: ${(duplicateCheck.similarity! * 100).toFixed(1)}%): "${extractedFact.content.substring(0, 50)}..." ≈ "${duplicateCheck.existingContent?.substring(0, 50)}..."`);
        return null;
    }

    // 3b. AI-Judge определил UPDATE → обновляем существующий факт
    if (duplicateCheck.isUpdate && duplicateCheck.existingFactId) {
        console.log(`📝 AI-Judge UPDATE [${duplicateCheck.reason}]: "${duplicateCheck.existingContent?.substring(0, 50)}" → "${extractedFact.content.substring(0, 50)}"`);

        // Помечаем старый факт как неактуальный
        await db.update(facts)
            .set({ isCurrent: false, updatedAt: new Date() })
            .where(eq(facts.id, duplicateCheck.existingFactId));

        const oldFact = await db.select().from(facts).where(eq(facts.id, duplicateCheck.existingFactId));
        const newVersion = (oldFact[0]?.version || 0) + 1;

        const newFact: InsertFact = {
            topicId: topic.id,
            content: extractedFact.content,
            embedding: serializeEmbedding(embedding),
            confidence: extractedFact.confidence,
            version: newVersion,
            isCurrent: true,
            sourceMessageId,
        };

        const result = await db.insert(facts).values(newFact).returning();

        try {
            await db.execute(sql`
                UPDATE facts 
                SET embedding_vector = ${serializeEmbedding(embedding)}::vector 
                WHERE id = ${result[0].id}
            `);
        } catch (e: any) {
            console.log(`⚠️ pgvector facts UPDATE пропущен: ${e.message?.slice(0, 50)}`);
        }

        await db.insert(factRelations).values({
            sourceFactId: result[0].id,
            targetFactId: duplicateCheck.existingFactId,
            relationType: 'supersedes',
        });

        return result[0];
    }

    // 4. Создаём новый факт
    // (проверка checkFactUpdate удалена — она полностью покрыта улучшенным checkForDuplicate + AI-Judge)
    const newFact: InsertFact = {
        topicId: topic.id,
        content: extractedFact.content,
        embedding: serializeEmbedding(embedding),
        confidence: extractedFact.confidence,
        version: 1,
        isCurrent: true,
        sourceMessageId,
    };

    const result = await db.insert(facts).values(newFact).returning();

    // Сохраняем в pgvector колонку
    try {
        await db.execute(sql`
            UPDATE facts 
            SET embedding_vector = ${serializeEmbedding(embedding)}::vector 
            WHERE id = ${result[0].id}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector facts UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }

    // 5. Увеличиваем счётчик фактов для темы
    await incrementTopicFactCount(topic.id);

    console.log(`Создан новый факт: "${extractedFact.content}" (тема: ${topic.name})`);

    return result[0];
}

/**
 * Извлечение и сохранение всех фактов из сообщения
 * @param message - текущее сообщение
 * @param sourceMessageId - ID исходного сообщения
 * @param dialogContext - опциональный контекст последних сообщений диалога
 */
export async function extractAndSaveFacts(
    message: string,
    sourceMessageId?: number,
    dialogContext?: string[],
    broadcastStep?: BroadcastStepFn
): Promise<Fact[]> {
    // 1. Извлекаем факты через AI (с контекстом диалога если есть)
    const extractedFacts = await extractFacts(message, dialogContext);

    if (extractedFacts.length === 0) {
        return [];
    }

    console.log(`Извлечено ${extractedFacts.length} фактов из сообщения`);

    // 2. Сохраняем каждый факт (с дедупликацией)
    const savedFacts: Fact[] = [];
    let duplicatesSkipped = 0;
    let updatesApplied = 0;
    const judgeDetails: Array<{ fact: string; verdict: string; reason?: string }> = [];

    for (const extractedFact of extractedFacts) {
        try {
            // Передаём broadcastStep=undefined чтобы saveFact не делал per-fact broadcast
            // Мы сделаем агрегированный broadcast ниже
            const savedFact = await saveFact(extractedFact, sourceMessageId, sourceMessageId, undefined);
            if (savedFact) {
                if (savedFact.version > 1) {
                    updatesApplied++;
                    judgeDetails.push({ fact: extractedFact.content.substring(0, 60), verdict: 'UPDATE' });
                } else {
                    judgeDetails.push({ fact: extractedFact.content.substring(0, 60), verdict: 'NEW' });
                }
                savedFacts.push(savedFact);
            } else {
                duplicatesSkipped++;
                judgeDetails.push({ fact: extractedFact.content.substring(0, 60), verdict: 'DUPLICATE' });
            }
        } catch (error) {
            console.error(`Ошибка сохранения факта "${extractedFact.content}":`, error);
        }
    }

    // 3. Агрегированный broadcast для AI-Judge результатов
    if (broadcastStep && sourceMessageId) {
        broadcastStep({
            type: 'processing_step',
            messageId: sourceMessageId,
            stepId: ORCHESTRATOR_STEPS.factJudge.id,
            stepName: ORCHESTRATOR_STEPS.factJudge.name,
            stepIcon: ORCHESTRATOR_STEPS.factJudge.icon,
            status: 'completed',
            output: {
                summary: `Проверено ${extractedFacts.length}: ${savedFacts.length} новых, ${updatesApplied} обновлений, ${duplicatesSkipped} дубликатов`,
                data: {
                    всего_извлечено: extractedFacts.length,
                    сохранено_новых: savedFacts.length - updatesApplied,
                    обновлено: updatesApplied,
                    дубликатов_пропущено: duplicatesSkipped,
                    детали: judgeDetails,
                }
            },
            timestamp: new Date().toISOString(),
        });
    }

    // 4. Логируем статистику дедупликации
    if (duplicatesSkipped > 0 || updatesApplied > 0) {
        console.log(`📊 Дедупликация: сохранено ${savedFacts.length} (${updatesApplied} обновлений), пропущено дубликатов: ${duplicatesSkipped}`);
    }

    return savedFacts;
}

/**
 * Получение всех текущих фактов
 */
export async function getAllCurrentFacts(): Promise<Fact[]> {
    return db.select()
        .from(facts)
        .where(eq(facts.isCurrent, true))
        .orderBy(sql`${facts.createdAt} DESC`);
}

/**
 * Получение фактов по теме
 */
export async function getFactsByTopicId(topicId: number, includeOld: boolean = false): Promise<Fact[]> {
    if (includeOld) {
        return db.select()
            .from(facts)
            .where(eq(facts.topicId, topicId))
            .orderBy(sql`${facts.createdAt} DESC`);
    }

    return db.select()
        .from(facts)
        .where(and(
            eq(facts.topicId, topicId),
            eq(facts.isCurrent, true)
        ))
        .orderBy(sql`${facts.createdAt} DESC`);
}

/**
 * Удаление факта (мягкое удаление — помечаем как неактуальный)
 */
export async function deleteFact(factId: number): Promise<void> {
    await db.update(facts)
        .set({
            isCurrent: false,
            updatedAt: new Date(),
        })
        .where(eq(facts.id, factId));
}

/**
 * Сохранение длинного документа с разбиением на чанки
 * Каждый чанк сохраняется как отдельный факт со ссылкой на родительский
 */
export async function saveDocumentWithChunks(
    document: string,
    topicPath: string,
    sourceMessageId?: number,
    options?: { maxChunkSize?: number; overlapSize?: number }
): Promise<Fact[]> {
    // Проверяем, нужно ли разбивать
    if (!needsChunking(document)) {
        // Документ достаточно короткий — сохраняем как обычный факт
        const savedFact = await saveFact({
            topic: topicPath,
            content: document,
            confidence: 'high',
        }, sourceMessageId);
        // Если дубликат — возвращаем пустой массив
        return savedFact ? [savedFact] : [];
    }

    // Разбиваем на чанки
    const chunks = splitTextIntoChunks(document, options);
    console.log(`📄 Документ разбит на ${chunks.length} чанков`);

    // Получаем или создаём тему
    const topic = await getOrCreateTopic(topicPath);

    // Сохраняем каждый чанк как факт
    const savedFacts: Fact[] = [];
    let parentFactId: number | null = null;

    for (const chunk of chunks) {
        try {
            // Создаём embedding для чанка
            const embedding = await createEmbedding(chunk.content);

            // Добавляем метаданные чанка в контент
            const chunkMeta = chunks.length > 1
                ? ` [чанк ${chunk.index + 1}/${chunks.length}]`
                : '';

            const newFact: InsertFact = {
                topicId: topic.id,
                content: chunk.content + chunkMeta,
                embedding: serializeEmbedding(embedding),
                confidence: 'high',
                version: 1,
                isCurrent: true,
                sourceMessageId,
            };

            const result = await db.insert(facts).values(newFact).returning();
            const savedFact = result[0];
            savedFacts.push(savedFact);

            // Сохраняем в pgvector колонку
            try {
                await db.execute(sql`
                    UPDATE facts 
                    SET embedding_vector = ${serializeEmbedding(embedding)}::vector 
                    WHERE id = ${savedFact.id}
                `);
            } catch (e: any) {
                console.log(`⚠️ pgvector chunks UPDATE пропущен: ${e.message?.slice(0, 50)}`);
            }

            // Связываем с предыдущим чанком
            if (parentFactId !== null) {
                await db.insert(factRelations).values({
                    sourceFactId: savedFact.id,
                    targetFactId: parentFactId,
                    relationType: "continues", // Чанк продолжает предыдущий
                });
            }

            parentFactId = savedFact.id;
        } catch (error) {
            console.error(`Ошибка сохранения чанка ${chunk.index}:`, error);
        }
    }

    // Увеличиваем счётчик фактов для темы
    await incrementTopicFactCount(topic.id);

    console.log(`✅ Сохранено ${savedFacts.length} чанков документа`);
    return savedFacts;
}

/**
 * Расширенный поиск с автоматическим объединением связанных чанков
 */
export async function searchFactsWithContext(
    query: string,
    limit: number = 5
): Promise<{ facts: SimilarityResult[]; relatedChunks: Fact[] }> {
    // Находим релевантные факты по текстовому запросу
    const relevantFacts = await searchFactsByQuery(query, limit);

    // Собираем связанные чанки для каждого факта
    const relatedChunks: Fact[] = [];

    for (const fact of relevantFacts) {
        // Ищем чанки, которые "continues" этот факт
        const relations = await db.select()
            .from(factRelations)
            .where(eq(factRelations.targetFactId, fact.id));

        for (const relation of relations) {
            if (relation.relationType === 'continues') {
                const [relatedFact] = await db.select()
                    .from(facts)
                    .where(eq(facts.id, relation.sourceFactId));

                if (relatedFact && !relatedChunks.find(f => f.id === relatedFact.id)) {
                    relatedChunks.push(relatedFact);
                }
            }
        }
    }

    return { facts: relevantFacts, relatedChunks };
}


