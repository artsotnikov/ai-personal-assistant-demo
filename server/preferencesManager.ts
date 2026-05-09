/**
 * Preferences Manager — Менеджер предпочтений пользователя
 * 
 * Автоматическое накопление предпочтений из диалогов:
 * - "любит краткие ответы"
 * - "предпочитает metric-first подход"  
 * - "просит структурировать списками"
 * 
 * В отличие от Profile (декларативные факты: "живёт в Москве"),
 * Preferences — это стилевые и поведенческие паттерны.
 * 
 * Confidence растёт с каждым подтверждением, предпочтения с 
 * низким confidence < 30 не включаются в контекст.
 */

import { db } from "./db";
import { userPreferences, type UserPreference } from "@shared/schema";
import { eq, sql, gte, lte, and, lt } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";
import { createEmbedding, cosineSimilarity } from "./embeddingService";
import { findSimilarProfileEntries } from "./profileManager";

// ============================================================================
// Конфигурация
// ============================================================================

/** Минимальный confidence для включения в контекст промпта */
const MIN_CONFIDENCE_FOR_CONTEXT = 30;

/** Прирост confidence при повторном подтверждении */
const CONFIDENCE_INCREMENT = 10;

/** Максимальный confidence */
const MAX_CONFIDENCE = 100;

/** Минимальная длина сообщения для анализа предпочтений */
const MIN_MESSAGE_LENGTH = 40;

/** Порог семантического совпадения для авто-мержа preferences */
const PREF_SIMILARITY_THRESHOLD = 0.85;

/** Порог для кросс-проверки с profile */
const CROSS_SYSTEM_THRESHOLD = 0.80;

/** Дней без обновления для начала decay */
const DECAY_AFTER_DAYS = 14;

/** Снижение confidence за период без подтверждения */
const DECAY_AMOUNT = 5;

/** Порог confidence для автоудаления */
const DELETE_CONFIDENCE_THRESHOLD = 10;

// ============================================================================
// Кэш эмбеддингов предпочтений (для семантической дедупликации)
// ============================================================================

const embeddingCache = new Map<string, number[]>();
let embeddingCacheValid = false;

/** Получить или создать embedding для preference key:value */
async function getPreferenceEmbedding(key: string, value: string): Promise<number[] | null> {
    const cacheKey = `${key}:${value}`;
    if (embeddingCache.has(cacheKey)) {
        return embeddingCache.get(cacheKey)!;
    }
    try {
        const emb = await createEmbedding(`${key}: ${value}`);
        embeddingCache.set(cacheKey, emb);
        return emb;
    } catch {
        return null;
    }
}

/** Инвалидировать кэш (при upsert) */
function invalidateEmbeddingCache() {
    embeddingCacheValid = false;
}

/** Загрузить эмбеддинги для всех preferences в кэш */
async function ensureEmbeddingCache(): Promise<void> {
    if (embeddingCacheValid) return;
    const allPrefs = await getAllPreferences();
    for (const pref of allPrefs) {
        const cacheKey = `${pref.key}:${pref.value}`;
        if (!embeddingCache.has(cacheKey)) {
            try {
                const emb = await createEmbedding(`${pref.key}: ${pref.value}`);
                embeddingCache.set(cacheKey, emb);
            } catch {
                // skip
            }
        }
    }
    embeddingCacheValid = true;
}

/**
 * Поиск семантически похожих preferences
 * Возвращает наиболее похожую запись или null
 */
async function findSimilarPreference(
    key: string,
    value: string,
    minSimilarity: number = PREF_SIMILARITY_THRESHOLD
): Promise<{ pref: UserPreference; similarity: number } | null> {
    const queryEmbedding = await getPreferenceEmbedding(key, value);
    if (!queryEmbedding) return null;

    await ensureEmbeddingCache();

    const allPrefs = await getAllPreferences();
    let bestMatch: { pref: UserPreference; similarity: number } | null = null;

    for (const pref of allPrefs) {
        const cacheKey = `${pref.key}:${pref.value}`;
        const prefEmb = embeddingCache.get(cacheKey);
        if (!prefEmb) continue;

        const sim = cosineSimilarity(queryEmbedding, prefEmb);
        if (sim >= minSimilarity && (!bestMatch || sim > bestMatch.similarity)) {
            bestMatch = { pref, similarity: sim };
        }
    }

    return bestMatch;
}

/**
 * Категории предпочтений
 */
export const PREFERENCE_CATEGORIES = [
    "communication",    // Стиль общения: краткость, формальность, юмор
    "analysis",         // Глубина анализа, метрики vs. нарратив
    "formatting",       // Структура ответов: списки, абзацы, emoji
    "workflow",         // Рабочие предпочтения: время, ритм, инструменты
    "content",          // Предпочтения по содержанию: примеры, аналогии
] as const;

export type PreferenceCategory = typeof PREFERENCE_CATEGORIES[number];

// ============================================================================
// CRUD-операции
// ============================================================================

/**
 * Получение всех предпочтений
 */
export async function getAllPreferences(): Promise<UserPreference[]> {
    return db.select()
        .from(userPreferences)
        .orderBy(userPreferences.category);
}

/**
 * Получение предпочтений с достаточным confidence (для контекста)
 */
export async function getConfidentPreferences(): Promise<UserPreference[]> {
    return db.select()
        .from(userPreferences)
        .where(gte(userPreferences.confidence, MIN_CONFIDENCE_FOR_CONTEXT))
        .orderBy(userPreferences.category);
}

/**
 * Upsert предпочтения с семантической дедупликацией и кросс-проверкой
 * 
 * Логика:
 * 1. Exact key match → обновляем confidence
 * 2. Семантический дубль (>= 0.85) → мержим в существующую запись
 * 3. Кросс-проверка с Profile (>= 0.80) → пропускаем
 * 4. Новая запись
 */
export async function upsertPreference(
    key: string,
    value: string,
    category: PreferenceCategory,
    source: 'auto' | 'explicit' | 'inferred' = 'auto'
): Promise<UserPreference> {
    // 1. Проверяем точное совпадение ключа
    const existing = await db.select()
        .from(userPreferences)
        .where(eq(userPreferences.key, key))
        .limit(1);

    if (existing.length > 0) {
        // Обновляем: повышаем confidence и mentionCount
        const currentConfidence = existing[0].confidence;
        const newConfidence = Math.min(currentConfidence + CONFIDENCE_INCREMENT, MAX_CONFIDENCE);

        const updated = await db.update(userPreferences)
            .set({
                value,  // Обновляем значение на актуальное
                confidence: newConfidence,
                mentionCount: sql`${userPreferences.mentionCount} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(userPreferences.key, key))
            .returning();

        console.log(`⚙️ Preference updated: ${key} (confidence: ${currentConfidence} → ${newConfidence})`);
        invalidateEmbeddingCache();
        return updated[0];
    }

    // 2. Семантический поиск дублей среди preferences
    try {
        const similar = await findSimilarPreference(key, value);
        if (similar) {
            const { pref, similarity } = similar;
            const currentConfidence = pref.confidence;
            const newConfidence = Math.min(currentConfidence + CONFIDENCE_INCREMENT, MAX_CONFIDENCE);

            const updated = await db.update(userPreferences)
                .set({
                    value,  // Обновляем на более свежую формулировку
                    confidence: newConfidence,
                    mentionCount: sql`${userPreferences.mentionCount} + 1`,
                    updatedAt: new Date(),
                })
                .where(eq(userPreferences.key, pref.key))
                .returning();

            console.log(`🔄 Preference semantic merge: "${key}" → "${pref.key}" (similarity: ${(similarity * 100).toFixed(0)}%, confidence: ${currentConfidence} → ${newConfidence})`);
            invalidateEmbeddingCache();
            return updated[0];
        }
    } catch (err) {
        // Ошибка дедупликации не должна блокировать создание
        console.warn('⚠️ Preference semantic dedup error, continuing:', (err as Error).message?.slice(0, 80));
    }

    // 3. Кросс-проверка с Profile — не дублируем то, что уже в профиле
    try {
        const queryEmbedding = await getPreferenceEmbedding(key, value);
        if (queryEmbedding) {
            const profileDupes = await findSimilarProfileEntries(queryEmbedding, 1, CROSS_SYSTEM_THRESHOLD);
            if (profileDupes.length > 0) {
                console.log(`⏭️ Preference skip (дубль профиля): "${key}" ≈ "${profileDupes[0].key}" (${(profileDupes[0].similarity * 100).toFixed(0)}%)`);
                // Возвращаем "фейковую" запись, чтобы не ломать цепочку вызовов
                return {
                    id: -1,
                    key,
                    value,
                    category,
                    confidence: 0,
                    mentionCount: 0,
                    source,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
            }
        }
    } catch (err) {
        console.warn('⚠️ Cross-system dedup error, continuing:', (err as Error).message?.slice(0, 80));
    }

    // 4. Действительно новая запись
    const created = await db.insert(userPreferences)
        .values({
            key,
            value,
            category,
            confidence: 50,  // Начальный confidence
            mentionCount: 1,
            source,
        })
        .returning();

    console.log(`⚙️ Preference created: ${category}/${key}`);
    invalidateEmbeddingCache();
    return created[0];
}

/**
 * Удаление предпочтения
 */
export async function deletePreference(key: string): Promise<void> {
    await db.delete(userPreferences)
        .where(eq(userPreferences.key, key));
    invalidateEmbeddingCache();
}

// ============================================================================
// Confidence Decay — старение неподтверждённых предпочтений
// ============================================================================

/**
 * Понижает confidence для давно не обновлявшихся предпочтений
 * и удаляет записи с критически низким confidence.
 * 
 * Предназначена для вызова раз в сутки из оркестратора.
 * 
 * Условия decay:
 * - mention_count <= 2 (мало подтверждений)
 * - updated_at > DECAY_AFTER_DAYS дней назад
 * 
 * @returns Количество изменённых и удалённых записей
 */
export async function decayStalePreferences(): Promise<{ decayed: number; deleted: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DECAY_AFTER_DAYS);

    // 1. Decay: понижаем confidence для устаревших записей
    const decayResult = await db.update(userPreferences)
        .set({
            confidence: sql`GREATEST(${userPreferences.confidence} - ${DECAY_AMOUNT}, 0)`,
            updatedAt: new Date(),
        })
        .where(
            and(
                lte(userPreferences.mentionCount, 2),
                lt(userPreferences.updatedAt, cutoffDate),
                gte(userPreferences.confidence, DELETE_CONFIDENCE_THRESHOLD + 1) // ещё не ниже порога
            )
        )
        .returning();

    // 2. Delete: удаляем записи с confidence <= порога
    const deleteResult = await db.delete(userPreferences)
        .where(lte(userPreferences.confidence, DELETE_CONFIDENCE_THRESHOLD))
        .returning();

    if (decayResult.length > 0 || deleteResult.length > 0) {
        console.log(`🕐 Preference decay: ${decayResult.length} decayed, ${deleteResult.length} deleted`);
        if (deleteResult.length > 0) {
            console.log(`   Deleted: ${deleteResult.map(r => r.key).join(', ')}`);
        }
        invalidateEmbeddingCache();
    }

    return { decayed: decayResult.length, deleted: deleteResult.length };
}

// ============================================================================
// Контекст для промпта
// ============================================================================

/**
 * Формирует строку предпочтений для включения в промпт AI
 * Возвращает null если предпочтений нет
 */
export async function getPreferencesContext(): Promise<string | null> {
    const prefs = await getConfidentPreferences();

    if (prefs.length === 0) {
        return null;
    }

    const byCategory = new Map<string, UserPreference[]>();
    for (const pref of prefs) {
        const cat = pref.category || 'other';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(pref);
    }

    const categoryLabels: Record<string, string> = {
        communication: '💬 Стиль общения',
        analysis: '📊 Анализ',
        formatting: '📝 Форматирование',
        workflow: '⚡ Рабочий процесс',
        content: '📖 Контент',
        other: '📌 Прочее',
    };

    const sections: string[] = [];
    for (const [cat, items] of Array.from(byCategory.entries())) {
        const label = categoryLabels[cat] || cat;
        const lines = items.map((p: UserPreference) => `  • ${p.value}`).join('\n');
        sections.push(`${label}:\n${lines}`);
    }

    return `⚙️ ПРЕДПОЧТЕНИЯ ПОЛЬЗОВАТЕЛЯ:\n${sections.join('\n')}`;
}

// ============================================================================
// AI-извлечение предпочтений из диалога
// ============================================================================

/**
 * Извлекает предпочтения из пары "сообщение пользователя + ответ AI"
 * 
 * Вызывается фоново из оркестратора (fire-and-forget).
 * Анализирует:
 * - Явные просьбы: "отвечай короче", "больше примеров"
 * - Косвенные сигналы: стиль вопросов, уточнения
 * - Паттерны: повторяющиеся форматы запросов
 * 
 * @returns Количество извлечённых/обновлённых предпочтений
 */
export async function extractPreferencesFromMessage(
    userMessage: string,
    aiResponse: string
): Promise<{ count: number; details: string[] }> {
    // Пропускаем слишком короткие сообщения
    if (userMessage.length < MIN_MESSAGE_LENGTH) {
        return { count: 0, details: [] };
    }

    const aiConfig = await getAIClientForTask('preference_extraction');

    // Получаем текущие предпочтения для контекста
    const currentPrefs = await getAllPreferences();
    const currentSummary = currentPrefs.length > 0
        ? `Текущие предпочтения (${currentPrefs.length}):\n` +
        currentPrefs.map(p => `- [${p.category}] ${p.key}: ${p.value} (confidence: ${p.confidence})`).join('\n')
        : 'Предпочтений пока нет.';

    const prompt = `Проанализируй пару "сообщение пользователя + ответ AI" и извлеки ПРЕДПОЧТЕНИЯ пользователя.

${currentSummary}

## ЧТО ЯВЛЯЕТСЯ ПРЕДПОЧТЕНИЕМ (извлекай):
- 💬 communication: "предпочитает краткие ответы", "любит формальный тон", "ценит юмор"
- 📊 analysis: "предпочитает metric-first подход", "любит примеры из практики"
- 📝 formatting: "просит структурировать списками", "любит emoji в ответах"
- ⚡ workflow: "работает по вечерам", "предпочитает пошаговые инструкции"
- 📖 content: "любит аналогии", "просит реальные примеры", "ценит ссылки на источники"

## ЧТО НЕ ЯВЛЯЕТСЯ ПРЕДПОЧТЕНИЕМ (НЕ извлекай):
❌ Биографические факты: "живёт в Москве", "CEO компании"
❌ Текущие задачи: "работает над проектом X"
❌ Эмоции: "сегодня в хорошем настроении"
❌ Технические данные: "использует Next.js"
❌ Черты личности: "перфекционист", "склонен к прокрастинации" (→ это profile)
❌ Психологические особенности: "мотивируется страхом", "склонен к руминации"
❌ Описания поведенческих паттернов: "избегает кадровых процессов" (→ profile/weaknesses)

## Правила:
1. Извлекай ТОЛЬКО если есть явный или сильный косвенный сигнал
2. Если предпочтение СОВПАДАЕТ с уже существующим — верни его повторно (для повышения confidence)
3. Ключи в snake_case на русском: "предпочитает_краткость"
4. Значения — 1 предложение, информативно
5. Если нет предпочтений — верни пустой массив

Сообщение пользователя:
"""
${userMessage}
"""

Ответ AI:
"""
${aiResponse.substring(0, 500)}
"""

Ответ строго в JSON:
{
  "preferences": [
    {"category": "communication", "key": "ключ_в_snake_case", "value": "описание предпочтения"}
  ]
}

Если нет новых предпочтений — верни {"preferences": []}`;

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: aiConfig.systemPrompt || "Ты — точный экстрактор предпочтений пользователя. Извлекай только стилевые и поведенческие паттерны."
            },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "{}";

        try {
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            let savedCount = 0;
            const savedDetails: string[] = [];

            if (Array.isArray(parsed.preferences) && parsed.preferences.length > 0) {
                for (const pref of parsed.preferences) {
                    if (pref.category && pref.key && pref.value) {
                        // Валидируем категорию
                        if (!PREFERENCE_CATEGORIES.includes(pref.category as PreferenceCategory)) {
                            continue;
                        }

                        await upsertPreference(
                            pref.key,
                            pref.value,
                            pref.category as PreferenceCategory,
                            'auto'
                        );
                        savedCount++;
                        savedDetails.push(`[${pref.category}] ${pref.key}: ${pref.value}`);
                    }
                }
            }

            return { count: savedCount, details: savedDetails };

        } catch (parseError) {
            // Тихо игнорируем — нормально если AI не нашёл предпочтений
            return { count: 0, details: [] };
        }
    } catch (error) {
        console.error("⚠️ Ошибка извлечения предпочтений:", error);
        return { count: 0, details: [] };
    }
}
