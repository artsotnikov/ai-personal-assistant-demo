/**
 * Profile Manager — Менеджер профиля пользователя
 * 
 * Хранит и обновляет характеристики пользователя (9 категорий):
 * ┌─ Ядро (core / редко меняется) ─────────────────────────────┐
 * │ personality, values, ambitions                              │
 * └─────────────────────────────────────────────────────────────┘
 * ┌─ Динамика (dynamic / эволюционирует) ──────────────────────┐
 * │ cognitive_patterns, strengths, weaknesses,                  │
 * │ expertise, emotional_triggers, communication                │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * Включает:
 * - Семантическую дедупликацию ключей через эмбеддинги
 * - Версионирование с аудит-логом (previousValue, version)
 * - AI-Judge для интеллектуального мержа близких записей
 * - Фоновое извлечение профиля из сообщений
 * - Синтез (Living Persona Model): схлопывание переполненных категорий
 */

import { db } from "./db";
import { userProfile, facts, type UserProfile } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { createEmbedding, cosineSimilarity, parseEmbedding, serializeEmbedding } from "./embeddingService";

// ============================================================================
// Конфигурация дедупликации
// ============================================================================

/** Порог автоматического мержа (ключи семантически идентичны) */
const PROFILE_AUTO_MERGE_THRESHOLD = 0.90;

/** Порог для вызова AI-Judge (ключи потенциально похожи) */
const PROFILE_JUDGE_THRESHOLD = 0.75;

/** Количество записей в категории, после которого запускается синтез */
const SYNTHESIS_THRESHOLD = 15;

/** Целевое количество записей после консолидации */
const SYNTHESIS_TARGET_COUNT = 6;

/**
 * Категории профиля (9 шт.) в двухуровневой системе:
 * Ядро (core) — ценности и личность, изменяются редко.
 * Динамика (dynamic) — навыки, паттерны, экспертиза — эволюционируют.
 */
export const PROFILE_CATEGORIES = [
    // ── Core (Ядро) ──
    "personality",         // Психотип и базовые черты
    "values",              // Жизненные ценности и принципы
    "ambitions",           // Долгосрочные амбиции и экзистенциальные притязания
    // ── Dynamic (Контекст) ──
    "cognitive_patterns",  // Стиль мышления и принятия решений
    "strengths",           // Сильные стороны и способности
    "weaknesses",          // Слабые стороны / области роста
    "expertise",           // Предметная экспертиза (домены знаний)
    "emotional_triggers",  // Эмоциональные триггеры, мотивации и стрeссоры
    "communication",       // Стиль и особенности общения
] as const;

export type ProfileCategory = typeof PROFILE_CATEGORIES[number];

/** "Ядровые" категории — меняются редко, синтез только при накоплении многочисленных записей */
export const CORE_CATEGORIES: ProfileCategory[] = ["personality", "values", "ambitions"];

/** "Динамические" категории — эволюционируют вместе с опытом */
export const DYNAMIC_CATEGORIES: ProfileCategory[] = [
    "cognitive_patterns", "strengths", "weaknesses",
    "expertise", "emotional_triggers", "communication",
];

/**
 * Структурированный профиль
 */
export interface StructuredProfile {
    personality: Record<string, string>;
    values: string[];
    ambitions: string[];
    cognitive_patterns: string[];
    strengths: string[];
    weaknesses: string[];
    expertise: string[];
    emotional_triggers: string[];
    communication: string[];
    summary: string;
}

// Тип источника обновления
export type ProfileUpdateSource = "agent" | "background" | "manual" | "profile_from_facts" | "synthesis";

// ============================================================================
// Базовые CRUD-операции
// ============================================================================

/**
 * Получение всех АКТИВНЫХ записей профиля (только isCurrent = true)
 */
export async function getAllProfileEntries(): Promise<UserProfile[]> {
    return db.select()
        .from(userProfile)
        .where(eq(userProfile.isCurrent, true))
        .orderBy(userProfile.category);
}

/**
 * Получение ВСЕХ записей (включая архивные) — для исторического поиска
 */
export async function getAllProfileEntriesIncludingArchived(): Promise<UserProfile[]> {
    return db.select()
        .from(userProfile)
        .orderBy(userProfile.category, userProfile.isCurrent);
}

/**
 * Получение записей профиля по категории (только активные)
 */
export async function getProfileByCategory(category: ProfileCategory): Promise<UserProfile[]> {
    return db.select()
        .from(userProfile)
        .where(and(eq(userProfile.category, category), eq(userProfile.isCurrent, true)));
}

/**
 * Удаление записи профиля
 */
export async function deleteProfileEntry(key: string): Promise<void> {
    await db.delete(userProfile)
        .where(eq(userProfile.key, key));
}

// ============================================================================
// Семантический поиск — Поиск похожих записей профиля
// ============================================================================

interface ProfileSimilarityResult {
    id: number;
    key: string;
    value: string;
    category: string | null;
    similarity: number;
}

/**
 * Поиск семантически похожих записей профиля по эмбеддингу
 * Использует pgvector, fallback на O(N) cosine similarity
 */
export async function findSimilarProfileEntries(
    queryEmbedding: number[],
    limit: number = 5,
    minSimilarity: number = PROFILE_JUDGE_THRESHOLD
): Promise<ProfileSimilarityResult[]> {
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const pgvectorResults = await db.execute(sql`
            SELECT id, key, value, category,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM user_profile
            WHERE embedding_vector IS NOT NULL
              AND is_current = true
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${minSimilarity}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                key: row.key,
                value: row.value,
                category: row.category,
                similarity: row.similarity as number,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector profile недоступен, fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск (только активные записи)
    const allEntries = await db.select({
        id: userProfile.id,
        key: userProfile.key,
        value: userProfile.value,
        category: userProfile.category,
        embedding: userProfile.embedding,
    }).from(userProfile)
     .where(eq(userProfile.isCurrent, true));

    const results: ProfileSimilarityResult[] = [];

    for (const entry of allEntries) {
        const entryEmbedding = parseEmbedding(entry.embedding);
        if (!entryEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, entryEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: entry.id,
                key: entry.key,
                value: entry.value,
                category: entry.category,
                similarity,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

// ============================================================================
// AI-Judge — Интеллектуальный мерж профильных записей
// ============================================================================

interface ProfileJudgeResult {
    verdict: 'MERGE' | 'NEW' | 'SKIP';
    reason: string;
    /** Если MERGE — какой ключ оставить и что станет новым значением */
    mergedValue?: string;
}

/**
 * AI-Judge для профильных записей — определяет, мержить ли два похожих ключа
 */
async function judgeProfileUpdate(
    newKey: string,
    newValue: string,
    existingKey: string,
    existingValue: string,
    similarity: number
): Promise<ProfileJudgeResult> {
    try {
        const aiConfig = await getAIClientForTask('profile_judge');

        const prompt = `Ты — AI-судья для профиля пользователя. Тебе дают две записи профиля. Реши, что с ними делать.

СУЩЕСТВУЮЩАЯ запись:
- Ключ: "${existingKey}"
- Значение: "${existingValue}"

НОВАЯ запись:
- Ключ: "${newKey}"
- Значение: "${newValue}"

Семантическое сходство ключей: ${(similarity * 100).toFixed(0)}%

Правила:
1. MERGE — если записи описывают ОДИН И ТОТ ЖЕ аспект пользователя. Объедини информацию в одно значение, сохранив ВСЕ детали из обеих записей.
2. NEW — если записи описывают РАЗНЫЕ аспекты (несмотря на похожие ключи).
3. SKIP — если новая запись не содержит полезной информации или является шумом.

Ответ строго в JSON:
{"verdict": "MERGE|NEW|SKIP", "reason": "...", "mergedValue": "...объединённый текст если MERGE..."}`;

        const result = await callWithFallback(aiConfig, [
            { role: "system", content: aiConfig.systemPrompt || "Ты точный AI-судья." },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        return {
            verdict: parsed.verdict || 'NEW',
            reason: parsed.reason || 'Не определено',
            mergedValue: parsed.mergedValue,
        };
    } catch (error) {
        console.error('⚠️ Profile AI-Judge error, defaulting to NEW:', error);
        return { verdict: 'NEW', reason: 'AI-Judge недоступен' };
    }
}

// ============================================================================
// setProfileValue — Основная функция записи с дедупликацией и версионированием
// ============================================================================

/**
 * Установка значения профиля с семантической дедупликацией и версионированием
 * 
 * Логика:
 * 1. Если ключ точно совпадает — обновляем с сохранением previousValue и version++
 * 2. Если ключ новый — создаём эмбеддинг и ищем семантически похожие
 *    - similarity >= 0.90: автоматический мерж в существующий ключ
 *    - similarity >= 0.75: вызываем AI-Judge для решения
 *    - similarity < 0.75: создаём новую запись
 */
export async function setProfileValue(
    key: string,
    value: string,
    category: ProfileCategory,
    source: ProfileUpdateSource = "agent",
    precomputedEmbedding?: number[] | null
): Promise<UserProfile> {
    // 0. Подготавливаем эмбеддинг (выносим наверх для использования во всех ветках)
    let embedding: number[] | null = precomputedEmbedding || null;

    // 1. Проверяем точное совпадение ключа
    const existing = await db.select()
        .from(userProfile)
        .where(eq(userProfile.key, key))
        .limit(1);

    if (existing.length > 0) {
        // Обновляем с версионированием
        return await updateExistingEntry(existing[0], value, category, source, embedding);
    }

    // 2. Новый ключ — создаём эмбеддинг если его ещё нет
    if (!embedding) {
        try {
            embedding = await createEmbedding(`${key}: ${value}`);
        } catch (err) {
            console.warn('⚠️ Не удалось создать эмбеддинг для профиля, пропускаем дедупликацию');
        }
    }

    if (embedding) {
        const similarEntries = await findSimilarProfileEntries(embedding, 5, PROFILE_JUDGE_THRESHOLD);

        for (const similar of similarEntries) {
            const isCrossCategory = similar.category !== category;

            // Авто-мерж при высоком сходстве (только внутри одной категории)
            if (similar.similarity >= PROFILE_AUTO_MERGE_THRESHOLD && !isCrossCategory) {
                console.log(`🔄 Profile auto-merge: "${key}" → "${similar.key}" (similarity: ${(similar.similarity * 100).toFixed(0)}%)`);
                return await updateExistingEntry(
                    { ...similar, updatedAt: new Date(), version: 1, previousValue: null, updatedBy: null, embedding: null, embeddingVector: null } as any,
                    `${similar.value}. ${value}`,
                    category,
                    source,
                    embedding
                );
            }

            // AI-Judge для пограничных случаев (включая кросс-категорийные)
            if (similar.similarity >= PROFILE_JUDGE_THRESHOLD) {
                const crossLabel = isCrossCategory ? ` [CROSS: ${similar.category} → ${category}]` : '';
                console.log(`🧑‍⚖️ Profile AI-Judge: "${key}" vs "${similar.key}" (similarity: ${(similar.similarity * 100).toFixed(0)}%)${crossLabel}`);
                const judgeResult = await judgeProfileUpdate(key, value, similar.key, similar.value, similar.similarity);

                if (judgeResult.verdict === 'MERGE') {
                    if (isCrossCategory) {
                        console.log(`🔄 Profile cross-category merge: "${key}" [${category}] → "${similar.key}" [${similar.category}] (${judgeResult.reason})`);
                    } else {
                        console.log(`🔄 Profile merge by AI-Judge: "${key}" → "${similar.key}" (${judgeResult.reason})`);
                    }
                    // При мёрже сохраняем категорию СУЩЕСТВУЮЩЕЙ записи (она старше)
                    return await updateExistingEntry(
                        { ...similar, updatedAt: new Date(), version: 1, previousValue: null, updatedBy: null, embedding: null, embeddingVector: null } as any,
                        judgeResult.mergedValue || `${similar.value}. ${value}`,
                        (isCrossCategory ? similar.category : category) as ProfileCategory,
                        source,
                        embedding
                    );
                }

                if (judgeResult.verdict === 'SKIP') {
                    console.log(`⏭️ Profile skip by AI-Judge: "${key}" (${judgeResult.reason})`);
                    // Возвращаем существующую запись без изменений
                    return await db.select().from(userProfile).where(eq(userProfile.id, similar.id)).then((r: UserProfile[]) => r[0]);
                }
            }
        }
    }

    // 3. Действительно новая запись
    const embeddingJson = embedding ? serializeEmbedding(embedding) : null;
    const created = await db.insert(userProfile)
        .values({
            key,
            value,
            category,
            version: 1,
            updatedBy: source,
            embedding: embeddingJson,
        })
        .returning();

    // Обновляем pgvector
    if (embeddingJson) {
        try {
            await db.execute(sql`
                UPDATE user_profile 
                SET embedding_vector = ${embeddingJson}::vector 
                WHERE id = ${created[0].id}
            `);
        } catch (err) {
            // pgvector может быть недоступен
        }
    }

    console.log(`✨ Profile new entry: ${category}/${key}`);
    return created[0];
}

/**
 * Обновление существующей записи с версионированием
 */
async function updateExistingEntry(
    existing: UserProfile,
    newValue: string,
    category: ProfileCategory,
    source: ProfileUpdateSource,
    newEmbedding?: number[] | null
): Promise<UserProfile> {
    // Создаём эмбеддинг если не передан
    let embeddingJson: string | null = null;
    if (newEmbedding) {
        embeddingJson = serializeEmbedding(newEmbedding);
    } else {
        try {
            const emb = await createEmbedding(`${existing.key}: ${newValue}`);
            embeddingJson = serializeEmbedding(emb);
        } catch {
            // OK, обновим без эмбеддинга
        }
    }

    const currentVersion = (existing as any).version || 1;

    const updated = await db.update(userProfile)
        .set({
            value: newValue,
            category,
            previousValue: existing.value,
            version: currentVersion + 1,
            updatedBy: source,
            embedding: embeddingJson || (existing as any).embedding,
            updatedAt: new Date(),
        })
        .where(eq(userProfile.key, existing.key))
        .returning();

    // Обновляем pgvector 
    if (embeddingJson && updated[0]) {
        try {
            await db.execute(sql`
                UPDATE user_profile 
                SET embedding_vector = ${embeddingJson}::vector 
                WHERE id = ${updated[0].id}
            `);
        } catch {
            // pgvector может быть недоступен
        }
    }

    console.log(`📝 Profile updated: ${existing.key} v${currentVersion} → v${currentVersion + 1} (by ${source})`);
    return updated[0];
}

// ============================================================================
// Структурированный профиль и контекст для промпта
// ============================================================================

/**
 * Получение структурированного профиля (только isCurrent = true записи)
 */
export async function getStructuredProfile(): Promise<StructuredProfile> {
    const entries = await getAllProfileEntries();

    const profile: StructuredProfile = {
        personality: {},
        values: [],
        ambitions: [],
        cognitive_patterns: [],
        strengths: [],
        weaknesses: [],
        expertise: [],
        emotional_triggers: [],
        communication: [],
        summary: "",
    };

    for (const entry of entries) {
        switch (entry.category) {
            case "personality":
                profile.personality[entry.key] = entry.value;
                break;
            case "values":
                profile.values.push(entry.value);
                break;
            case "ambitions":
                profile.ambitions.push(entry.value);
                break;
            case "cognitive_patterns":
                profile.cognitive_patterns.push(entry.value);
                break;
            case "strengths":
                profile.strengths.push(entry.value);
                break;
            case "weaknesses":
                profile.weaknesses.push(entry.value);
                break;
            case "expertise":
                profile.expertise.push(entry.value);
                break;
            case "emotional_triggers":
                profile.emotional_triggers.push(entry.value);
                break;
            case "communication":
                profile.communication.push(entry.value);
                break;
        }
    }

    return profile;
}

/**
 * Форматирование профиля для промпта агента (только активные записи)
 */
export async function getProfileContextForPrompt(): Promise<string> {
    const profile = await getStructuredProfile();

    const parts: string[] = [];

    // Ядро
    if (Object.keys(profile.personality).length > 0) {
        const traits = Object.entries(profile.personality)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
        parts.push(`Личность: ${traits}`);
    }
    if (profile.values.length > 0) {
        parts.push(`Ценности: ${profile.values.join(", ")}`);
    }
    if (profile.ambitions.length > 0) {
        parts.push(`Амбиции: ${profile.ambitions.join(", ")}`);
    }

    // Динамические
    if (profile.cognitive_patterns.length > 0) {
        parts.push(`Мышление и решения: ${profile.cognitive_patterns.join(", ")}`);
    }
    if (profile.strengths.length > 0) {
        parts.push(`Сильные стороны: ${profile.strengths.join(", ")}`);
    }
    if (profile.weaknesses.length > 0) {
        parts.push(`Области роста: ${profile.weaknesses.join(", ")}`);
    }
    if (profile.expertise.length > 0) {
        parts.push(`Экспертиза: ${profile.expertise.join(", ")}`);
    }
    if (profile.emotional_triggers.length > 0) {
        parts.push(`Эмоциональные паттерны: ${profile.emotional_triggers.join(", ")}`);
    }
    if (profile.communication.length > 0) {
        parts.push(`Стиль общения: ${profile.communication.join(", ")}`);
    }

    if (parts.length === 0) {
        return "";
    }

    return "## Профиль пользователя\n" + parts.join("\n");
}

// ============================================================================
// AI-извлечение — Обновление профиля из фактов
// ============================================================================

/**
 * Автоматическое извлечение характеристик профиля из фактов
 */
export async function updateProfileFromFacts(): Promise<number> {
    const aiConfig = await getAIClientForTask('profile_analysis');

    // Получаем факты о личности из базы
    const personalFacts = await db.select()
        .from(facts)
        .where(
            and(
                eq(facts.isCurrent, true),
                // Ищем факты с высокой уверенностью
            )
        )
        .limit(50);

    if (personalFacts.length === 0) {
        return 0;
    }

    const factsText = personalFacts.map((f: any) => `- ${f.content}`).join("\n");

    const prompt = `Проанализируй следующие факты о человеке и извлеки характеристики его профиля.

Факты:
${factsText}

Извлеки следующие категории (если есть данные):
1. personality — черты личности (интроверт/экстраверт, рационал/интуит, и т.д.)
2. values — ценности (семья, успех, свобода, и т.д.)
3. strengths — сильные стороны
4. weaknesses — слабые стороны / области для развития
5. communication — предпочтительный стиль общения

Ответ в JSON:
{
  "extractions": [
    {"category": "personality", "key": "тип", "value": "интроверт"},
    {"category": "values", "key": "ценность_1", "value": "семья"},
    ...
  ]
}

Извлекай только то, о чём есть явные данные в фактах. Не придумывай.`;

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: aiConfig.systemPrompt!
            },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";

        try {
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            let savedCount = 0;

            if (Array.isArray(parsed.extractions)) {
                for (const extraction of parsed.extractions) {
                    if (extraction.category && extraction.key && extraction.value) {
                        await setProfileValue(
                            extraction.key,
                            extraction.value,
                            extraction.category as ProfileCategory,
                            "profile_from_facts"
                        );
                        savedCount++;
                    }
                }
            }

            console.log(`📊 Профиль обновлён из фактов: ${savedCount} записей`);
            return savedCount;

        } catch (parseError) {
            console.error("Ошибка парсинга профиля:", parseError);
            return 0;
        }
    } catch (error) {
        console.error("Ошибка извлечения профиля:", error);
        return 0;
    }
}

// ============================================================================
// AI-извлечение — Инкрементальное обновление из сообщения (фоновое)
// ============================================================================

/**
 * Инкрементальное извлечение обновлений профиля из сообщения
 * 
 * Вызывается фоново из оркестратора (fire-and-forget).
 * Извлекает только УСТОЙЧИВЫЕ характеристики пользователя.
 */
export async function extractProfileUpdatesFromMessage(message: string): Promise<{ count: number; details: string[] }> {
    // Пропускаем короткие сообщения — вряд ли содержат профильную информацию
    if (message.length < 50) {
        return { count: 0, details: [] };
    }

    const aiConfig = await getAIClientForTask('profile_extraction');

    // Получаем текущий профиль для контекста (с ключами для дедупликации)
    const currentEntries = await getAllProfileEntries();
    const currentProfileSummary = currentEntries.length > 0
        ? `Текущий профиль (${currentEntries.length} записей):\n` +
        currentEntries.map(e => `- [${e.category}] ${e.key}: ${e.value}`).join("\n")
        : "Профиль пока пустой.";

    const prompt = `Проанализируй сообщение пользователя и найди НОВУЮ информацию о его УСТОЙЧИВЫХ личностных характеристиках.

${currentProfileSummary}

## ЧТО ЯВЛЯЕТСЯ ПРОФИЛЕМ (извлекай):
- personality: Черты личности — интроверт/экстраверт, аналитик/интуит, перфекционист и т.д.
- values: Ценности — семья, свобода, честность, здоровье, деньги и т.д.
- ambitions: Долгосрочные амбиции и экзистенциальные притязания — «хочу изменить индустрию», «создать legacy»
- cognitive_patterns: Стиль мышления и принятия решений — «сначала данные», «интуиция над цифрами», «bottom-up мышление»
- strengths: Сильные стороны — навыки, таланты, врождённые способности
- weaknesses: Слабые стороны — устойчивые паттерны поведения, привычки, трудности (области роста)
- expertise: Предметная экспертиза — домены глубокого знания: «SaaS, финтех, Python, переговоры»
- emotional_triggers: Эмоциональные триггеры — что мотивирует, что вызывает стресс, чего боится
- communication: Стиль и предпочтения общения — прямолинейность, формальность, любовь к аналогиям

## ЧТО НЕ ЯВЛЯЕТСЯ ПРОФИЛЕМ (НЕ извлекай):
❌ Бизнес-данные: метрики, выручка, количество клиентов, цены
❌ Текущие события: «сегодня я сделал...», «вчера произошло...»
❌ Технические факты: стек технологий, инструменты, архитектура проекта
❌ Контекстные данные: о сотрудниках, клиентах, конкурентах
❌ Мимолётные эмоции: «я раздражён» (если это не ПАТТЕРН поведения)
❌ Кадровые решения: «ценит внимательность кандидатов»
❌ Стилевые предпочтения к ответам ассистента (→ это preferences, не профиль)

## ТЕСТ НА КОНТЕКСТОНЕЗАВИСИМОСТЬ:
Прежде чем записать — ответь себе: «Это верно о человеке ВСЕГДА, даже вне конкретной ситуации?»
Если нет — НЕ записывай.
Пример: «перфекционист» → ДА. «Ценит сопроводительные письма» → НЕТ (контекст найма).

## Правила:
1. Извлекай ТОЛЬКО информацию, которой ЕЩЁ НЕТ в профиле
2. Ключи должны быть в snake_case на русском: «склонность_к_перфекционизму»
3. Значения должны быть информативными, 1-2 предложения
4. Если НОВОЙ информации нет — верни пустой массив
5. Обновляй существующие данные только при ЯВНОМ противоречии
6. Минимальная важность: записывай только СУЩЕСТВЕННЫЕ черты, не мелочи

Сообщение:
"""
${message}
"""

Ответ строго в JSON:
{
  "updates": [
    {"category": "personality", "key": "название_в_snake_case", "value": "описание черты", "importance": 4}
  ]
}

importance: 1-5, где 1=мелочь, 5=ключевая черта. Записывай только importance >= 4.
Если нет новой информации — верни {"updates": []}`;

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: aiConfig.systemPrompt || "Ты — точный экстрактор профильных данных. Извлекай только устойчивые характеристики личности."
            },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";

        try {
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            let savedCount = 0;
            const savedDetails: string[] = [];

            if (Array.isArray(parsed.updates) && parsed.updates.length > 0) {
                // 1. Фильтруем валидные обновления
                const validUpdates = parsed.updates.filter((u: any) => 
                    (u.importance || 0) >= 4 && 
                    u.category && u.key && u.value &&
                    PROFILE_CATEGORIES.includes(u.category as ProfileCategory)
                );

                if (validUpdates.length > 0) {
                    console.log(`👤 Profile: подготовка ${validUpdates.length} эмбеддингов параллельно...`);
                    
                    // 2. Параллельная генерация эмбеддингов (самая медленная часть)
                    const updatesWithEmbeddings = await Promise.all(
                        validUpdates.map(async (update: any) => {
                            try {
                                const embedding = await createEmbedding(`${update.key}: ${update.value}`);
                                return { ...update, embedding };
                            } catch (err) {
                                console.warn(`⚠️ Ошибка эмбеддинга для "${update.key}":`, err);
                                return { ...update, embedding: null };
                            }
                        })
                    );

                    // 3. Последовательное сохранение в БД (безопасно для дедупликации)
                    for (const update of updatesWithEmbeddings) {
                        await setProfileValue(
                            update.key,
                            update.value,
                            update.category as ProfileCategory,
                            "background",
                            update.embedding
                        );
                        savedCount++;
                        savedDetails.push(`[${update.category}] ${update.key}: ${update.value}`);
                    }
                }
            }

            return { count: savedCount, details: savedDetails };

        } catch (parseError) {
            // Тихо игнорируем ошибки парсинга — это нормально, если нет данных
            return { count: 0, details: [] };
        }
    } catch (error) {
        console.error("Ошибка извлечения профиля:", error);
        return { count: 0, details: [] };
    }
}

// ============================================================================
// Synthesis Engine — Living Persona Model
// ============================================================================

/**
 * Проверяет, нужен ли синтез для категории.
 * Считает только ОРГАНИЧЕСКИЕ записи (без synth_ prefix) — synth-записи уже консолидированы.
 * Возвращает true, если органических записей >= SYNTHESIS_THRESHOLD.
 */
export async function checkCategorySynthesisNeed(category: ProfileCategory): Promise<boolean> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
        .from(userProfile)
        .where(and(
            eq(userProfile.category, category),
            eq(userProfile.isCurrent, true),
            sql`key NOT LIKE 'synth_%'`
        ));
    const count = result[0]?.count ?? 0;
    return count >= SYNTHESIS_THRESHOLD;
}

/**
 * Синтез (консолидация) одной категории профиля:
 * 
 * Ключевое отличие: синтезируем только ОРГАНИЧЕСКИЕ записи (без synth_ prefix).
 * Существующие synth-записи сохраняются как стабильная база и передаются AI как контекст.
 * 
 * Алгоритм:
 * 1. Разделяем записи на synthetic (база) и organic (новые наблюдения)
 * 2. AI получает оба набора: organic для консолидации, synthetic как контекст
 * 3. AI решает: интегрировать organic в существующие synth, обновить synth, или создать новые
 * 4. Архивируем ТОЛЬКО organic записи
 * 5. Обновляем/создаём synth записи
 * 
 * Возвращает { archived, created } — количество архивированных и созданных/обновлённых записей.
 */
export async function synthesizeCategory(
    category: ProfileCategory
): Promise<{ archived: number; created: number }> {
    const entries = await getProfileByCategory(category);
    if (entries.length < 2) return { archived: 0, created: 0 };

    // Разделяем на synth (стабильная база) и organic (новые наблюдения)
    const synthEntries = entries.filter(e => e.key.startsWith('synth_'));
    const organicEntries = entries.filter(e => !e.key.startsWith('synth_'));

    // Нет organic записей — нечего синтезировать
    if (organicEntries.length < 2) {
        console.log(`🧠 [ProfileSynthesis] Пропуск \"${category}\": всего ${organicEntries.length} organic записей`);
        return { archived: 0, created: 0 };
    }

    console.log(`🧠 [ProfileSynthesis] Синтез категории \"${category}\" (${organicEntries.length} organic + ${synthEntries.length} synth → обновление)`);

    const aiConfig = await getAIClientForTask('profile_synthesis');

    const organicList = organicEntries
        .map(e => `- key: "${e.key}"\n  value: "${e.value}"`)
        .join("\n");

    const synthList = synthEntries.length > 0
        ? synthEntries.map(e => `- key: "${e.key}"\n  value: "${e.value}"`).join("\n")
        : "(пока нет)";

    // Определяем целевое количество: если synthetics уже есть, стремимся к их количеству + 1-2 новых
    const targetCount = synthEntries.length > 0
        ? Math.min(SYNTHESIS_TARGET_COUNT, synthEntries.length + 2)
        : SYNTHESIS_TARGET_COUNT;

    const prompt = `Ты — эксперт по психологии личности. У пользователя есть СУЩЕСТВУЮЩАЯ база характеристик (synth-записи) и НОВЫЕ наблюдения (organic-записи) в категории «${category}».

ЗАДАЧА: Интегрируй новые наблюдения в существующую базу.

## СУЩЕСТВУЮЩАЯ БАЗА (synth-записи, уже консолидированные):
${synthList}

## НОВЫЕ НАБЛЮДЕНИЯ (organic-записи, подлежат консолидации):
${organicList}

## Правила:
1. Если новое наблюдение ДОПОЛНЯЕТ существующую synth-запись — объедини с ней, расширив формулировку
2. Если новое наблюдение описывает НОВЫЙ аспект (не покрытый synthetics) — создай новую запись
3. Если новое наблюдение ПРОТИВОРЕЧИТ synth-записи — обнови запись, отразив изменение
4. УДАЛЯЙ шум: одиночные наблюдения без повторного подтверждения можно интегрировать молча
5. Итого: не более ${targetCount} записей
6. Ключи (key) должны быть snake_case, информативными, с префиксом
7. Каждый тезис — самодостаточный (понятный без контекста)

Ответ строго в JSON:
{
  "synthesized": [
    {"key": "ключ_snake_case", "value": "Ёмкое описание. Сохраняет нюансы и конкретику.", "action": "update|new"}
  ]
}

action: "update" если обновлена существующая synth-запись, "new" если создана новая.`;

    let synthesized: Array<{ key: string; value: string; action?: string }> = [];

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: "Ты — точный психологический аналитик. Интегрируй новые наблюдения в существующую базу без потери смысла."
            },
            { role: "user", content: prompt },
        ]);

        const raw = result.content?.trim() || "{}";
        const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(clean);

        if (Array.isArray(parsed.synthesized) && parsed.synthesized.length > 0) {
            synthesized = parsed.synthesized
                .filter((s: any) => s.key && s.value)
                .slice(0, targetCount);
        }
    } catch (err) {
        console.error(`[ProfileSynthesis] ❌ Ошибка AI синтеза для "${category}":`, err);
        return { archived: 0, created: 0 };
    }

    if (synthesized.length === 0) {
        console.warn(`[ProfileSynthesis] ⚠️ AI вернул пустой результат для "${category}", синтез отменён`);
        return { archived: 0, created: 0 };
    }

    // 1. Архивируем ТОЛЬКО organic записи (synth-записи остаются!)
    const archiveIds = organicEntries.map(e => e.id);
    if (archiveIds.length > 0) {
        await db.update(userProfile)
            .set({ isCurrent: false, updatedAt: new Date() })
            .where(sql`id = ANY(ARRAY[${sql.join(archiveIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
    }

    // 2. Архивируем старые synth-записи (будут заменены обновлёнными)
    const synthArchiveIds = synthEntries.map(e => e.id);
    if (synthArchiveIds.length > 0) {
        await db.update(userProfile)
            .set({ isCurrent: false, updatedAt: new Date() })
            .where(sql`id = ANY(ARRAY[${sql.join(synthArchiveIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
    }

    // 3. Генерируем эмбеддинги для новых записей параллельно
    const withEmbeddings = await Promise.all(
        synthesized.map(async (s) => {
            try {
                const embedding = await createEmbedding(`${s.key}: ${s.value}`);
                return { ...s, embedding };
            } catch {
                return { ...s, embedding: null };
            }
        })
    );

    // 4. Определяем stability_level для категории
    const stabilityLevel = CORE_CATEGORIES.includes(category) ? 'core' : 'dynamic';

    // 5. Вставляем синтезированные записи
    let created = 0;
    for (const s of withEmbeddings) {
        try {
            const embStr = s.embedding ? serializeEmbedding(s.embedding) : null;
            // Используем upsert — ключ может случайно совпасть со старым
            const inserted = await db.insert(userProfile).values({
                key: `synth_${category}_${s.key}`,
                value: s.value,
                category,
                isCurrent: true,
                stabilityLevel,
                updatedBy: 'synthesis' as any,
                embedding: embStr,
                version: 1,
            }).onConflictDoUpdate({
                target: userProfile.key,
                set: {
                    value: s.value,
                    isCurrent: true,
                    stabilityLevel,
                    updatedBy: 'synthesis' as any,
                    embedding: embStr,
                    updatedAt: new Date(),
                },
            }).returning();

            // Обновляем pgvector отдельным запросом
            if (embStr && inserted[0]) {
                try {
                    await db.execute(sql`
                        UPDATE user_profile 
                        SET embedding_vector = ${embStr}::vector 
                        WHERE id = ${inserted[0].id}
                    `);
                } catch {
                    // pgvector может быть недоступен
                }
            }

            created++;
        } catch (err) {
            console.error(`[ProfileSynthesis] ❌ Ошибка вставки синтезированной записи "${s.key}":`, err);
        }
    }

    console.log(`🧠 [ProfileSynthesis] ✅ "${category}": organic архивировано ${archiveIds.length}, synth обновлено ${synthArchiveIds.length} → создано ${created}`);
    return { archived: archiveIds.length, created };
}

/**
 * Проверяет все категории профиля и запускает синтез там, где достигнут порог.
 * Вызывается фоново из proactiveScheduler.
 */
export async function synthesizeAllCategories(): Promise<void> {
    let totalArchived = 0;
    let totalCreated = 0;
    const categoriesProcessed: string[] = [];

    for (const category of PROFILE_CATEGORIES) {
        try {
            const needsSynthesis = await checkCategorySynthesisNeed(category);
            if (!needsSynthesis) continue;

            const result = await synthesizeCategory(category as ProfileCategory);
            if (result.created > 0) {
                totalArchived += result.archived;
                totalCreated += result.created;
                categoriesProcessed.push(category);
            }
        } catch (err) {
            console.error(`[ProfileSynthesis] ❌ Ошибка обработки категории "${category}":`, err);
        }
    }

    if (categoriesProcessed.length > 0) {
        console.log(
            `🧠 [ProfileSynthesis] Полный цикл завершён.`,
            `Категорий: ${categoriesProcessed.join(", ")}.`,
            `Архивировано: ${totalArchived}, создано: ${totalCreated}.`
        );
    }
}

