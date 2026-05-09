/**
 * Topic Manager - Управление динамическим деревом тем
 * 
 * Отвечает за:
 * - Определение тем в сообщении через AI
 * - Создание новых тем с проверкой на дубликаты
 * - Построение иерархии тем
 */

import { db } from "./db";
import { topics, type Topic, type InsertTopic } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import {
    createEmbedding,
    serializeEmbedding,
    findSimilarTopics
} from "./embeddingService";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// Порог похожести для определения дубликата темы (автоматическое объединение)
const DUPLICATE_SIMILARITY_THRESHOLD = 0.90;
// Порог похожести для поиска кандидатов на AI-нормализацию
const NORMALIZATION_SIMILARITY_THRESHOLD = 0.70;

/**
 * Результат AI-нормализации темы
 */
interface NormalizationResult {
    useExisting: boolean;
    existingTopicId?: number;
    reasoning: string;
}

/**
 * AI-нормализация: спрашиваем AI, нужно ли использовать существующую тему
 */
async function aiNormalizeTopic(
    newTopicName: string,
    candidates: Array<{ id: number; name: string; similarity: number }>
): Promise<NormalizationResult> {
    try {
        const aiConfig = await getAIClientForTask('topic_normalization');

        const candidateList = candidates
            .map(c => `- ID ${c.id}: "${c.name}" (похожесть ${(c.similarity * 100).toFixed(0)}%)`)
            .join('\n');

        const prompt = `Определи, нужно ли использовать существующую тему или создать новую.

Новая тема: "${newTopicName}"

Существующие похожие темы:
${candidateList}

Правила:
1. Если новая тема — синоним или вариант существующей → используй существующую
2. "Жизнь/Цели" = "Личная жизнь/Цели" = "Личное/Цели" — это ОДНО И ТО ЖЕ
3. "Бизнес/Клиенты" ≠ "Бизнес/Пользователи" — это РАЗНЫЕ темы
4. Создавай новую ТОЛЬКО если смысл действительно отличается

Ответ СТРОГО в JSON:
{"useExisting": true, "existingTopicId": 123, "reasoning": "почему"}
или
{"useExisting": false, "existingTopicId": null, "reasoning": "почему"}`;

        const result = await callWithFallback(aiConfig, [
            { role: "system", content: "Ты — эксперт по категоризации. Отвечай ТОЛЬКО валидным JSON." },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "";
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        console.log(`🔄 AI-нормализация "${newTopicName}": ${parsed.useExisting ? `→ ${candidates.find(c => c.id === parsed.existingTopicId)?.name}` : 'создать новую'} (${parsed.reasoning})`);

        return {
            useExisting: !!parsed.useExisting,
            existingTopicId: parsed.existingTopicId ?? undefined,
            reasoning: parsed.reasoning || "",
        };
    } catch (error: any) {
        console.error("⚠️ AI-нормализация не удалась:", error?.message?.slice(0, 100));
        // Fallback: не объединяем, создаём новую
        return { useExisting: false, reasoning: "Fallback: ошибка AI" };
    }
}

/**
 * Определение тем в сообщении через AI
 */
export async function detectTopics(message: string): Promise<string[]> {
    const aiConfig = await getAIClientForTask('topic_detection');

    const prompt = `Проанализируй следующее сообщение и определи основные темы, к которым оно относится.

Правила:
1. Возвращай темы в формате "Категория/Подтема", например: "Бизнес/Тарифы", "Финансы/Инвестиции"
2. Основные категории: Бизнес, Финансы, Психология, Здоровье, Личное, Карьера, Образование
3. Если тема не подходит под стандартные категории — создай новую
4. Возвращай от 1 до 5 тем, наиболее релевантных сообщению
5. Отвечай ТОЛЬКО JSON-массивом тем, без пояснений

Сообщение:
"""
${message}
"""

Ответ (JSON-массив):`;

    try {
        const result = await callWithFallback(aiConfig, [
            { role: "system", content: aiConfig.systemPrompt! },
            { role: "user", content: prompt },
        ]);

        const content = result.content?.trim() || "[]";

        // Парсим JSON-ответ
        try {
            // Убираем возможные markdown-обёртки
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanContent);

            if (Array.isArray(parsed)) {
                return parsed.filter(t => typeof t === 'string' && t.length > 0);
            }
        } catch (parseError) {
            console.error("Ошибка парсинга тем:", parseError, "Ответ:", content);
        }

        return [];
    } catch (error: any) {
        console.error("Ошибка определения тем:", error);
        return [];
    }
}

/**
 * Получение темы по имени или создание новой
 * 
 * Логика:
 * 1. Точное совпадение имени → возвращаем существующую
 * 2. Similarity >= 0.90 → автоматическое объединение
 * 3. Similarity >= 0.70 → AI-нормализация (спрашиваем AI)
 * 4. Иначе → создаём новую тему
 */
export async function getOrCreateTopic(topicName: string): Promise<Topic> {
    // 1. Пробуем найти точное совпадение
    const existing = await db.select().from(topics).where(eq(topics.name, topicName));
    if (existing.length > 0) {
        return existing[0];
    }

    // 2. Создаём embedding для новой темы
    const embedding = await createEmbedding(topicName);

    // 3. Ищем семантически похожие темы (с низким порогом для AI-нормализации)
    const similarTopics = await findSimilarTopics(embedding, 5, NORMALIZATION_SIMILARITY_THRESHOLD);

    if (similarTopics.length > 0) {
        // 3a. Проверяем, есть ли очень похожие (>= 0.90) — автоматическое объединение
        const verySimlar = similarTopics.filter(t => t.similarity >= DUPLICATE_SIMILARITY_THRESHOLD);
        if (verySimlar.length > 0) {
            const existingTopic = await db.select().from(topics).where(eq(topics.id, verySimlar[0].id));
            if (existingTopic.length > 0) {
                console.log(`✅ Тема "${topicName}" автоматически объединена с "${existingTopic[0].name}" (similarity: ${verySimlar[0].similarity.toFixed(2)})`);
                return existingTopic[0];
            }
        }

        // 3b. Есть кандидаты 0.70-0.90 — спрашиваем AI
        const candidates = await Promise.all(
            similarTopics.map(async t => {
                const [topic] = await db.select().from(topics).where(eq(topics.id, t.id));
                return topic ? { id: t.id, name: topic.name, similarity: t.similarity } : null;
            })
        );
        const validCandidates = candidates.filter((c): c is NonNullable<typeof c> => c !== null);

        if (validCandidates.length > 0) {
            const normalization = await aiNormalizeTopic(topicName, validCandidates);

            if (normalization.useExisting && normalization.existingTopicId) {
                const [existingTopic] = await db.select().from(topics).where(eq(topics.id, normalization.existingTopicId));
                if (existingTopic) {
                    return existingTopic;
                }
            }
        }
    }

    // 4. Создаём новую тему
    const parentId = await findOrCreateParentTopic(topicName);

    const newTopic: InsertTopic = {
        name: topicName,
        parentId,
        embedding: serializeEmbedding(embedding),
        factCount: 0,
    };

    const result = await db.insert(topics).values(newTopic).returning();

    // Сохраняем в pgvector колонку
    try {
        await db.execute(sql`
            UPDATE topics 
            SET embedding_vector = ${serializeEmbedding(embedding)}::vector 
            WHERE id = ${result[0].id}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector topics UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }

    console.log(`🆕 Создана новая тема: "${topicName}"`);

    return result[0];
}

/**
 * Находит или создаёт родительскую тему (категорию)
 */
async function findOrCreateParentTopic(topicName: string): Promise<number | null> {
    // Если тема содержит "/", первая часть — это категория
    if (!topicName.includes('/')) {
        return null;
    }

    const categoryName = topicName.split('/')[0];

    // Ищем категорию
    const existing = await db.select().from(topics).where(eq(topics.name, categoryName));
    if (existing.length > 0) {
        return existing[0].id;
    }

    // Создаём категорию
    const embedding = await createEmbedding(categoryName);
    const newCategory: InsertTopic = {
        name: categoryName,
        parentId: null,
        embedding: serializeEmbedding(embedding),
        factCount: 0,
    };

    const result = await db.insert(topics).values(newCategory).returning();

    // Сохраняем в pgvector колонку
    try {
        await db.execute(sql`
            UPDATE topics 
            SET embedding_vector = ${serializeEmbedding(embedding)}::vector 
            WHERE id = ${result[0].id}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector category UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }

    console.log(`Создана новая категория: "${categoryName}"`);

    return result[0].id;
}

/**
 * Получение всех тем
 */
export async function getAllTopics(): Promise<Topic[]> {
    return db.select().from(topics);
}

/**
 * Получение темы по ID
 */
export async function getTopicById(id: number): Promise<Topic | null> {
    const result = await db.select().from(topics).where(eq(topics.id, id));
    return result.length > 0 ? result[0] : null;
}

/**
 * Увеличение счётчика фактов для темы
 */
export async function incrementTopicFactCount(topicId: number): Promise<void> {
    await db.update(topics)
        .set({
            factCount: sql`${topics.factCount} + 1`,
            updatedAt: new Date(),
        })
        .where(eq(topics.id, topicId));
}

/**
 * Уменьшение счётчика фактов для темы
 */
export async function decrementTopicFactCount(topicId: number): Promise<void> {
    await db.update(topics)
        .set({
            factCount: sql`GREATEST(${topics.factCount} - 1, 0)`,
            updatedAt: new Date(),
        })
        .where(eq(topics.id, topicId));
}

/**
 * Структура узла дерева тем
 */
export interface TopicNode {
    id: number;
    name: string;
    factCount: number;
    children: TopicNode[];
}

/**
 * Получение иерархии тем в виде дерева
 */
export async function getTopicsTree(): Promise<TopicNode[]> {
    const allTopics = await getAllTopics();

    // Строим карту тем по ID
    const topicMap = new Map<number, TopicNode>();
    allTopics.forEach(topic => {
        topicMap.set(topic.id, {
            id: topic.id,
            name: topic.name,
            factCount: topic.factCount,
            children: [],
        });
    });

    // Строим дерево
    const roots: TopicNode[] = [];

    allTopics.forEach(topic => {
        const node = topicMap.get(topic.id)!;

        if (topic.parentId && topicMap.has(topic.parentId)) {
            // Добавляем к родителю
            topicMap.get(topic.parentId)!.children.push(node);
        } else {
            // Это корневой узел
            roots.push(node);
        }
    });

    return roots;
}
