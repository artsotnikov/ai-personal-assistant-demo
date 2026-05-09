/**
 * Embedding Service - Сервис для работы с векторными представлениями текста
 * 
 * Primary: OpenRouter API (не заблокирован в РФ, прокси не нужен)
 * Fallback: OpenAI API напрямую через прокси (если OpenRouter недоступен)
 * 
 * Модель: openai/text-embedding-3-small (1536 измерений)
 */

import OpenAI from "openai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { db } from "./db";
import { topics, facts, goals, messages, notes, ticktickTasks } from "@shared/schema";
import { sql } from "drizzle-orm";
import type { Agent } from "http";

// Размерность вектора для text-embedding-3-small
const EMBEDDING_DIMENSION = 1536;

// Timeout для КАЖДОГО embedding провайдера (не суммарный!)
// Embedding — быстрая операция (~200-500ms в норме).
// 10с — достаточно для медленного ответа, но не блокирует fallback.
// Суммарный worst-case: 10с (primary) + 10с (fallback) = 20с < tool timeout (45с)
const EMBEDDING_TIMEOUT_MS = 10_000;

// Модель для OpenRouter (префикс openai/)
const OPENROUTER_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
// Модель для прямого OpenAI
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

// Кэш для прокси-агента
let cachedProxyAgent: Agent | null = null;

function getProxyAgent(): Agent | undefined {
    const proxyUrl = process.env.OPENAI_PROXY;
    if (!proxyUrl) return undefined;

    if (!cachedProxyAgent) {
        // Определяем тип прокси по URL схеме
        if (proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
            console.log("🔄 OpenAI Embedding: настроен SOCKS прокси");
            cachedProxyAgent = new SocksProxyAgent(proxyUrl);
        } else {
            console.log("🔄 OpenAI Embedding: настроен HTTP прокси");
            cachedProxyAgent = new HttpsProxyAgent(proxyUrl);
        }
    }
    return cachedProxyAgent;
}

// ⚠️ OpenRouter embedding ОТКЛЮЧЁН — возвращает 403 Terms of Service
// для openai/text-embedding-3-small. Протестировано 2026-04-11.
// Если OpenRouter снимет блокировку, можно вернуть как primary.
// function getOpenRouterClient() { ... }

// Primary: OpenAI напрямую БЕЗ прокси
// Тест 2026-04-11 показал: работает из РФ, ~1.5с
function getOpenAIDirectClient(): OpenAI | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    return new OpenAI({ apiKey, timeout: EMBEDDING_TIMEOUT_MS });
}

// Fallback: OpenAI через прокси (медленнее, ~17с, но стабильно)
function getOpenAIProxyClient(): OpenAI | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const proxyAgent = getProxyAgent();
    if (!proxyAgent) return null;

    return new OpenAI({
        apiKey,
        timeout: EMBEDDING_TIMEOUT_MS,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
            const nodeFetch = (await import('node-fetch')).default;
            const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
            return nodeFetch(urlString, {
                ...init as any,
                agent: proxyAgent,
            }) as unknown as Response;
        }) as typeof fetch,
    });
}

/**
 * Создание embedding для текста
 * 
 * Стратегия (обновлена 2026-04-11 после тестирования):
 * 1. OpenAI напрямую — без прокси, ~1.5с из РФ
 * 2. OpenAI через прокси — fallback, ~17с но стабильно
 * 
 * OpenRouter отключён — 403 Terms of Service на embedding модели.
 */
export async function createEmbedding(text: string): Promise<number[]> {
    // Очищаем текст
    const cleanedText = text.trim().replace(/\n+/g, ' ').slice(0, 8000);

    if (!cleanedText) {
        throw new Error("Пустой текст для создания embedding");
    }

    const startTime = Date.now();

    // 1. Primary: OpenAI напрямую (без прокси)
    const directClient = getOpenAIDirectClient();
    if (directClient) {
        try {
            const response = await directClient.embeddings.create({
                model: OPENAI_EMBEDDING_MODEL,
                input: cleanedText,
            });
            const elapsed = Date.now() - startTime;
            if (elapsed > 3000) {
                console.warn(`⚠️ OpenAI embedding slow: ${elapsed}ms`);
            }
            return response.data[0].embedding;
        } catch (error: any) {
            const elapsed = Date.now() - startTime;
            console.warn(`⚠️ OpenAI direct embedding failed (${elapsed}ms): ${error.message?.slice(0, 100)}`);
            // Продолжаем к fallback через прокси
        }
    }

    // 2. Fallback: OpenAI через прокси
    const proxyClient = getOpenAIProxyClient();
    if (proxyClient) {
        try {
            const fallbackStart = Date.now();
            console.log('🔄 Embedding fallback: OpenAI через прокси');
            const response = await proxyClient.embeddings.create({
                model: OPENAI_EMBEDDING_MODEL,
                input: cleanedText,
            });
            const elapsed = Date.now() - fallbackStart;
            console.log(`✅ Embedding fallback OK (${elapsed}ms)`);
            return response.data[0].embedding;
        } catch (error: any) {
            const elapsed = Date.now() - startTime;
            console.error(`❌ OpenAI proxy embedding failed (total ${elapsed}ms): ${error.message?.slice(0, 100)}`);
        }
    }

    const totalElapsed = Date.now() - startTime;
    throw new Error(`Не удалось создать embedding (${totalElapsed}ms): ни direct, ни proxy OpenAI не доступны`);
}

/**
 * Вычисление cosine similarity между двумя векторами
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error("Векторы должны быть одинаковой размерности");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dotProduct / (normA * normB);
}

/**
 * Парсинг embedding из JSON-строки
 */
export function parseEmbedding(embeddingJson: string | null): number[] | null {
    if (!embeddingJson) return null;

    try {
        const parsed = JSON.parse(embeddingJson);
        if (Array.isArray(parsed) && parsed.length === EMBEDDING_DIMENSION) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Сериализация embedding в JSON-строку
 */
export function serializeEmbedding(embedding: number[]): string {
    return JSON.stringify(embedding);
}

/**
 * Результат поиска похожих записей
 */
export interface SimilarityResult {
    id: number;
    content?: string;
    name?: string;
    similarity: number;
    sourceMessageId?: number;
}

/**
 * Поиск похожих тем по embedding
 * Использует pgvector для быстрого поиска, fallback на O(N) если pgvector недоступен
 */
export async function findSimilarTopics(
    queryEmbedding: number[],
    limit: number = 5,
    minSimilarity: number = 0.3
): Promise<SimilarityResult[]> {
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const pgvectorResults = await db.execute(sql`
            SELECT id, name,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM topics
            WHERE embedding_vector IS NOT NULL
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${minSimilarity}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🔍 [pgvector] Найдено ${pgvectorResults.rows.length} тем`);
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                name: row.name,
                similarity: row.similarity as number,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector topics недоступен, fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск
    const allTopics = await db.select({
        id: topics.id,
        name: topics.name,
        embedding: topics.embedding,
    }).from(topics);

    const results: SimilarityResult[] = [];

    for (const topic of allTopics) {
        const topicEmbedding = parseEmbedding(topic.embedding);
        if (!topicEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, topicEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: topic.id,
                name: topic.name,
                similarity,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Поиск похожих фактов по embedding
 * Использует pgvector для быстрого поиска, fallback на O(N) если pgvector недоступен
 */
export async function findSimilarFacts(
    queryEmbedding: number[],
    limit: number = 10,
    minSimilarity: number = 0.4,
    onlyCurrentFacts: boolean = true
): Promise<SimilarityResult[]> {
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const currentFilter = onlyCurrentFacts ? sql`AND is_current = true` : sql``;
        const pgvectorResults = await db.execute(sql`
            SELECT id, content, source_message_id,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM facts
            WHERE embedding_vector IS NOT NULL
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${minSimilarity}
              ${currentFilter}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🔍 [pgvector] Найдено ${pgvectorResults.rows.length} фактов`);
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                similarity: row.similarity as number,
                sourceMessageId: row.source_message_id ?? undefined,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector facts недоступен, fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск
    let query = db.select({
        id: facts.id,
        content: facts.content,
        embedding: facts.embedding,
    }).from(facts);

    const allFacts = await query;

    const results: SimilarityResult[] = [];

    for (const fact of allFacts) {
        const factEmbedding = parseEmbedding(fact.embedding);
        if (!factEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, factEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: fact.id,
                content: fact.content,
                similarity,
                sourceMessageId: (fact as any).sourceMessageId ?? undefined,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Создание и сохранение embedding для темы
 */
export async function createTopicEmbedding(topicId: number, topicName: string): Promise<void> {
    const embedding = await createEmbedding(topicName);
    const embeddingJson = serializeEmbedding(embedding);

    // Сохраняем в JSON колонку
    await db.update(topics)
        .set({ embedding: embeddingJson })
        .where(sql`${topics.id} = ${topicId}`);

    // Сохраняем в pgvector колонку (если доступна)
    try {
        await db.execute(sql`
            UPDATE topics 
            SET embedding_vector = ${embeddingJson}::vector 
            WHERE id = ${topicId}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector topics UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }
}

/**
 * Создание и сохранение embedding для факта
 */
export async function createFactEmbedding(factId: number, factContent: string): Promise<void> {
    const embedding = await createEmbedding(factContent);
    const embeddingJson = serializeEmbedding(embedding);

    // Сохраняем в JSON колонку
    await db.update(facts)
        .set({ embedding: embeddingJson })
        .where(sql`${facts.id} = ${factId}`);

    // Сохраняем в pgvector колонку (если доступна)
    try {
        await db.execute(sql`
            UPDATE facts 
            SET embedding_vector = ${embeddingJson}::vector 
            WHERE id = ${factId}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector facts UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }
}

/**
 * Поиск фактов по текстовому запросу (создаёт embedding и ищет похожие)
 */
export async function searchFactsByQuery(
    query: string,
    limit: number = 10,
    minSimilarity: number = 0.4
): Promise<SimilarityResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarFacts(queryEmbedding, limit, minSimilarity);
}

/**
 * Поиск тем по текстовому запросу
 */
export async function searchTopicsByQuery(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.5
): Promise<SimilarityResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarTopics(queryEmbedding, limit, minSimilarity);
}

// ============================================================================
// Goals Embedding — Семантический поиск целей
// ============================================================================

/**
 * Создание и сохранение embedding для цели
 */
export async function createGoalEmbedding(goalId: number, goalText: string): Promise<void> {
    const embedding = await createEmbedding(goalText);
    const embeddingJson = serializeEmbedding(embedding);

    // Сохраняем в JSON колонку
    await db.update(goals)
        .set({ embedding: embeddingJson })
        .where(sql`${goals.id} = ${goalId}`);

    // Сохраняем в pgvector колонку (если доступна)
    try {
        await db.execute(sql`
            UPDATE goals 
            SET embedding_vector = ${embeddingJson}::vector 
            WHERE id = ${goalId}
        `);
    } catch (e: any) {
        console.log(`⚠️ pgvector goals UPDATE пропущен: ${e.message?.slice(0, 50)}`);
    }
}

/**
 * Поиск похожих целей по embedding
 * Использует pgvector для быстрого поиска, fallback на O(N) если недоступен
 */
export async function findSimilarGoals(
    queryEmbedding: number[],
    limit: number = 5,
    minSimilarity: number = 0.45,
    onlyActiveGoals: boolean = true
): Promise<SimilarityResult[]> {
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const statusFilter = onlyActiveGoals ? sql`AND status = 'active'` : sql``;
        const pgvectorResults = await db.execute(sql`
            SELECT id, title as content,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM goals
            WHERE embedding_vector IS NOT NULL
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${minSimilarity}
              ${statusFilter}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🎯 [pgvector] Найдено ${pgvectorResults.rows.length} релевантных целей`);
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                similarity: row.similarity as number,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector goals недоступен, fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск
    const allGoals = await db.select({
        id: goals.id,
        title: goals.title,
        status: goals.status,
        embedding: goals.embedding,
    }).from(goals);

    const results: SimilarityResult[] = [];

    for (const goal of allGoals) {
        if (onlyActiveGoals && goal.status !== 'active') continue;

        const goalEmbedding = parseEmbedding(goal.embedding);
        if (!goalEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, goalEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: goal.id,
                content: goal.title,
                similarity,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Поиск целей по текстовому запросу (создаёт embedding и ищет похожие)
 */
export async function searchGoalsByQuery(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.45
): Promise<SimilarityResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarGoals(queryEmbedding, limit, minSimilarity);
}

// ============================================================================
// Notes Embedding — Семантический поиск заметок
// ============================================================================

/**
 * Создание и сохранение embedding для заметки
 * Текст для embedding: заголовок + первые 500 символов контента + теги
 */
export async function createNoteEmbedding(noteId: number, title: string, content?: string | null, tags?: string[]): Promise<void> {
    const parts = [title];
    if (content) parts.push(content.substring(0, 500));
    if (tags && tags.length > 0) parts.push(tags.join(', '));
    const textForEmbedding = parts.join(' | ');

    try {
        const embedding = await createEmbedding(textForEmbedding);
        const embeddingJson = serializeEmbedding(embedding);

        await db.update(notes)
            .set({ embedding: embeddingJson })
            .where(sql`${notes.id} = ${noteId}`);
    } catch (e: any) {
        console.log(`⚠️ Note embedding пропущен (id=${noteId}): ${e.message?.slice(0, 80)}`);
    }
}

/**
 * Поиск похожих заметок по embedding
 * Использует O(N) fallback (у notes нет pgvector колонки)
 */
export async function findSimilarNotes(
    queryEmbedding: number[],
    limit: number = 5,
    minSimilarity: number = 0.4
): Promise<SimilarityResult[]> {
    const allNotes = await db.select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        isActive: notes.isActive,
        isArchived: notes.isArchived,
        embedding: notes.embedding,
    }).from(notes);

    const results: SimilarityResult[] = [];

    for (const note of allNotes) {
        if (!note.isActive || note.isArchived) continue;

        const noteEmbedding = parseEmbedding(note.embedding);
        if (!noteEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, noteEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: note.id,
                content: note.title,
                name: note.content?.substring(0, 150) || undefined,
                similarity,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Поиск заметок по текстовому запросу (создаёт embedding и ищет похожие)
 */
export async function searchNotesByQuery(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.4
): Promise<SimilarityResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarNotes(queryEmbedding, limit, minSimilarity);
}

// ============================================================================
// Messages Embedding — Семантический поиск по истории сообщений
// ============================================================================

/**
 * Результат поиска сообщений (расширяет SimilarityResult)
 */
export interface MessageSearchResult extends SimilarityResult {
    sender?: string;
    timestamp?: Date;
}

/**
 * Опции поиска сообщений
 */
export interface MessageSearchOptions {
    limit?: number;
    minSimilarity?: number;
    sender?: 'user' | 'assistant' | 'all';  // 'assistant' маппится на 'ai' внутри
    minContentLength?: number;               // мин. длина контента (по умолчанию 30)
}

const DEFAULT_MESSAGE_SEARCH_OPTIONS: Required<MessageSearchOptions> = {
    limit: 10,
    minSimilarity: 0.35,
    sender: 'all',
    minContentLength: 30,
};

/**
 * Создание и сохранение embedding для сообщения
 */
export async function createMessageEmbedding(messageId: number, content: string): Promise<void> {
    // Не индексируем слишком короткие сообщения
    if (content.trim().length < 30) return;

    try {
        const embedding = await createEmbedding(content);
        const embeddingJson = serializeEmbedding(embedding);

        // Сохраняем в pgvector колонку
        await db.execute(sql`
            UPDATE messages 
            SET embedding_vector = ${embeddingJson}::vector 
            WHERE id = ${messageId}
        `);
    } catch (e: any) {
        // Тихо пропускаем ошибки — embedding для сообщений не критичен
        console.log(`⚠️ Message embedding пропущен (id=${messageId}): ${e.message?.slice(0, 80)}`);
    }
}

/**
 * Поиск похожих сообщений по embedding (pgvector)
 */
export async function findSimilarMessages(
    queryEmbedding: number[],
    opts: MessageSearchOptions = {}
): Promise<MessageSearchResult[]> {
    const options = { ...DEFAULT_MESSAGE_SEARCH_OPTIONS, ...opts };
    const embeddingJson = serializeEmbedding(queryEmbedding);

    try {
        // Формируем фильтр по sender
        const senderFilter = options.sender === 'all'
            ? sql`AND sender IN ('user', 'ai')`
            : options.sender === 'assistant'
                ? sql`AND sender = 'ai'`
                : sql`AND sender = 'user'`;

        const pgvectorResults = await db.execute(sql`
            SELECT id, content, sender, timestamp,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM messages
            WHERE embedding_vector IS NOT NULL
              AND length(content) >= ${options.minContentLength}
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${options.minSimilarity}
              ${senderFilter}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${options.limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🔍 [pgvector] Найдено ${pgvectorResults.rows.length} сообщений`);
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                sender: row.sender,
                timestamp: row.timestamp,
                similarity: row.similarity as number,
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector messages недоступен: ${pgvectorError.message?.slice(0, 60)}`);
        return [];
    }
}

/**
 * Поиск сообщений по текстовому запросу (vector search)
 */
export async function searchMessagesByQuery(
    query: string,
    opts: MessageSearchOptions = {}
): Promise<MessageSearchResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarMessages(queryEmbedding, opts);
}

/**
 * FTS-поиск сообщений через PostgreSQL tsvector
 */
export async function ftsSearchMessages(
    query: string,
    opts: MessageSearchOptions = {}
): Promise<MessageSearchResult[]> {
    const options = { ...DEFAULT_MESSAGE_SEARCH_OPTIONS, ...opts };
    const tsQuery = buildTsQuery(query);
    if (!tsQuery) return [];

    try {
        const senderFilter = options.sender === 'all'
            ? sql`AND sender IN ('user', 'ai')`
            : options.sender === 'assistant'
                ? sql`AND sender = 'ai'`
                : sql`AND sender = 'user'`;

        const results = await db.execute(sql`
            SELECT id, content, sender, timestamp,
                   ts_rank(search_vector, to_tsquery('simple', ${tsQuery})) as rank
            FROM messages
            WHERE search_vector @@ to_tsquery('simple', ${tsQuery})
              AND length(content) >= ${options.minContentLength}
              ${senderFilter}
            ORDER BY rank DESC
            LIMIT ${options.limit}
        `);

        if (results.rows && results.rows.length > 0) {
            console.log(`📝 [FTS] Найдено ${results.rows.length} сообщений`);
            return results.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                sender: row.sender,
                timestamp: row.timestamp,
                similarity: row.rank as number,
            }));
        }
        return [];
    } catch (error: any) {
        if (error.message?.includes('search_vector') || error.message?.includes('column')) {
            console.log(`⚠️ FTS messages недоступен (миграция не применена?): ${error.message?.slice(0, 60)}`);
        } else {
            console.error('❌ Ошибка FTS поиска сообщений:', error.message);
        }
        return [];
    }
}

/**
 * Гибридный поиск сообщений: vector + FTS
 * 
 * Алгоритм аналогичен hybridSearchFacts:
 * 1. Параллельно vector search + FTS
 * 2. Нормализация FTS рангов
 * 3. Merge с boost для пересечений
 * 4. Сортировка по итоговому score
 */
export async function hybridSearchMessages(
    query: string,
    opts: MessageSearchOptions = {}
): Promise<(MessageSearchResult & { sources: ('vector' | 'fts')[]; vectorScore?: number; ftsScore?: number })[]> {
    const options = { ...DEFAULT_MESSAGE_SEARCH_OPTIONS, ...opts };
    const searchOpts = { ...options, limit: (options.limit) * 2 };
    const vectorWeight = 0.7;
    const ftsWeight = 0.3;

    // Параллельный поиск
    const [vectorResults, ftsResults] = await Promise.all([
        searchMessagesByQuery(query, searchOpts),
        ftsSearchMessages(query, searchOpts),
    ]);

    // Нормализуем FTS-ранги в 0..1
    const maxFtsRank = ftsResults.length > 0
        ? Math.max(...ftsResults.map(r => r.similarity))
        : 1;
    const normalizedFts = ftsResults.map(r => ({
        ...r,
        similarity: maxFtsRank > 0 ? r.similarity / maxFtsRank : 0,
    }));

    // Собираем в map по ID
    type MergedResult = MessageSearchResult & { sources: ('vector' | 'fts')[]; vectorScore?: number; ftsScore?: number };
    const mergedMap = new Map<number, MergedResult>();

    for (const r of vectorResults) {
        mergedMap.set(r.id, {
            ...r,
            similarity: r.similarity * vectorWeight,
            sources: ['vector'],
            vectorScore: r.similarity,
        });
    }

    for (const r of normalizedFts) {
        const existing = mergedMap.get(r.id);
        if (existing) {
            existing.similarity =
                (existing.vectorScore || 0) * vectorWeight +
                r.similarity * ftsWeight;
            existing.sources.push('fts');
            existing.ftsScore = r.similarity;
        } else {
            mergedMap.set(r.id, {
                ...r,
                similarity: r.similarity * ftsWeight,
                sources: ['fts'],
                ftsScore: r.similarity,
            });
        }
    }

    const results = Array.from(mergedMap.values())
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, options.limit);

    const bothCount = results.filter(r => r.sources.length === 2).length;
    const vectorOnly = results.filter(r => r.sources.length === 1 && r.sources[0] === 'vector').length;
    const ftsOnly = results.filter(r => r.sources.length === 1 && r.sources[0] === 'fts').length;
    console.log(`🔀 Hybrid message search: ${results.length} сообщений (v+f: ${bothCount}, v: ${vectorOnly}, f: ${ftsOnly})`);

    return results;
}

// ============================================================================
// Full-Text Search (FTS) — Полнотекстовый поиск через tsvector/tsquery
// ============================================================================

/**
 * Построение tsquery из пользовательского запроса
 * Разбивает на слова, фильтрует короткие, объединяет через OR (|)
 * Использует 'simple' конфигурацию для максимальной совместимости с русским/английским
 */
function buildTsQuery(query: string): string {
    const words = query
        .replace(/[^\w\sа-яА-ЯёЁ-]/g, ' ')  // убираем спецсимволы
        .split(/\s+/)
        .filter(w => w.length >= 2)            // только слова ≥2 символов
        .map(w => w.toLowerCase());

    if (words.length === 0) return '';

    // Формат: word1:* | word2:* — поиск по префиксу через OR
    return words.map(w => `${w}:*`).join(' | ');
}

/**
 * FTS-поиск фактов через PostgreSQL tsvector
 * Возвращает результаты ранжированные по ts_rank
 */
export async function ftsSearchFacts(
    query: string,
    limit: number = 10,
    onlyCurrentFacts: boolean = true
): Promise<SimilarityResult[]> {
    const tsQuery = buildTsQuery(query);
    if (!tsQuery) return [];

    try {
        const currentFilter = onlyCurrentFacts ? sql`AND is_current = true` : sql``;
        const results = await db.execute(sql`
            SELECT id, content,
                   ts_rank(search_vector, to_tsquery('simple', ${tsQuery})) as rank
            FROM facts
            WHERE search_vector @@ to_tsquery('simple', ${tsQuery})
              ${currentFilter}
            ORDER BY rank DESC
            LIMIT ${limit}
        `);

        if (results.rows && results.rows.length > 0) {
            console.log(`📝 [FTS] Найдено ${results.rows.length} фактов`);
            return results.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                similarity: row.rank as number,  // ts_rank (0..1+), нормализуется позже
            }));
        }
        return [];
    } catch (error: any) {
        // Если search_vector колонка ещё не создана — тихо пропускаем
        if (error.message?.includes('search_vector') || error.message?.includes('column')) {
            console.log(`⚠️ FTS facts недоступен (миграция не применена?): ${error.message?.slice(0, 60)}`);
        } else {
            console.error('❌ Ошибка FTS поиска фактов:', error.message);
        }
        return [];
    }
}

/**
 * FTS-поиск тем через PostgreSQL tsvector
 */
export async function ftsSearchTopics(
    query: string,
    limit: number = 5
): Promise<SimilarityResult[]> {
    const tsQuery = buildTsQuery(query);
    if (!tsQuery) return [];

    try {
        const results = await db.execute(sql`
            SELECT id, name,
                   ts_rank(search_vector, to_tsquery('simple', ${tsQuery})) as rank
            FROM topics
            WHERE search_vector @@ to_tsquery('simple', ${tsQuery})
            ORDER BY rank DESC
            LIMIT ${limit}
        `);

        if (results.rows && results.rows.length > 0) {
            console.log(`📝 [FTS] Найдено ${results.rows.length} тем`);
            return results.rows.map((row: any) => ({
                id: row.id,
                name: row.name,
                similarity: row.rank as number,
            }));
        }
        return [];
    } catch (error: any) {
        if (error.message?.includes('search_vector') || error.message?.includes('column')) {
            console.log(`⚠️ FTS topics недоступен: ${error.message?.slice(0, 60)}`);
        }
        return [];
    }
}

// ============================================================================
// Hybrid Search — Объединение Vector + FTS результатов
// ============================================================================

/**
 * Конфигурация весов для гибридного поиска
 */
const HYBRID_WEIGHTS = {
    vectorWeight: 0.7,   // Вес vector search (семантическое сходство)
    ftsWeight: 0.3,      // Вес FTS (точное совпадение слов)
};

/**
 * Результат гибридного поиска с источником
 */
export interface HybridSearchResult extends SimilarityResult {
    sources: ('vector' | 'fts')[];
    vectorScore?: number;
    ftsScore?: number;
}

/**
 * Гибридный поиск фактов: объединяет vector search + FTS
 * 
 * Алгоритм:
 * 1. Параллельно выполняет vector search и FTS
 * 2. Нормализует FTS ранги в диапазон 0..1
 * 3. Объединяет результаты: если факт найден обоими методами — 
 *    итоговый score = α×vector + β×fts, если одним — только его score с дисконтом
 * 4. Сортирует по итоговому score
 */
export async function hybridSearchFacts(
    query: string,
    limit: number = 15,
    minSimilarity: number = 0.35,
    onlyCurrentFacts: boolean = true
): Promise<HybridSearchResult[]> {
    // Параллельный поиск
    const [vectorResults, ftsResults] = await Promise.all([
        searchFactsByQuery(query, limit * 2, minSimilarity),
        ftsSearchFacts(query, limit * 2, onlyCurrentFacts),
    ]);

    // Нормализуем FTS-ранги в 0..1
    const maxFtsRank = ftsResults.length > 0
        ? Math.max(...ftsResults.map(r => r.similarity))
        : 1;
    const normalizedFts = ftsResults.map(r => ({
        ...r,
        similarity: maxFtsRank > 0 ? r.similarity / maxFtsRank : 0,
    }));

    // Собираем все результаты в map по ID
    const mergedMap = new Map<number, HybridSearchResult>();

    // Добавляем vector results
    for (const r of vectorResults) {
        mergedMap.set(r.id, {
            id: r.id,
            content: r.content,
            name: r.name,
            similarity: r.similarity * HYBRID_WEIGHTS.vectorWeight,
            sources: ['vector'],
            vectorScore: r.similarity,
        });
    }

    // Добавляем / мержим FTS results
    for (const r of normalizedFts) {
        const existing = mergedMap.get(r.id);
        if (existing) {
            // Факт найден обоими методами — boost!
            existing.similarity =
                (existing.vectorScore || 0) * HYBRID_WEIGHTS.vectorWeight +
                r.similarity * HYBRID_WEIGHTS.ftsWeight;
            existing.sources.push('fts');
            existing.ftsScore = r.similarity;
        } else {
            // Только FTS нашёл — добавляем с дисконтом
            mergedMap.set(r.id, {
                id: r.id,
                content: r.content,
                name: r.name,
                similarity: r.similarity * HYBRID_WEIGHTS.ftsWeight,
                sources: ['fts'],
                ftsScore: r.similarity,
            });
        }
    }

    // Сортируем по итоговому score и берём top-N
    const results = Array.from(mergedMap.values())
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

    // Логируем статистику
    const bothCount = results.filter(r => r.sources.length === 2).length;
    const vectorOnly = results.filter(r => r.sources.length === 1 && r.sources[0] === 'vector').length;
    const ftsOnly = results.filter(r => r.sources.length === 1 && r.sources[0] === 'fts').length;
    console.log(`🔀 Hybrid search: ${results.length} фактов (vector+fts: ${bothCount}, vector only: ${vectorOnly}, fts only: ${ftsOnly})`);

    return results;
}

/**
 * Гибридный поиск тем: vector + FTS
 */
export async function hybridSearchTopics(
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.3
): Promise<HybridSearchResult[]> {
    const [vectorResults, ftsResults] = await Promise.all([
        searchTopicsByQuery(query, limit * 2, minSimilarity),
        ftsSearchTopics(query, limit * 2),
    ]);

    const maxFtsRank = ftsResults.length > 0
        ? Math.max(...ftsResults.map(r => r.similarity))
        : 1;
    const normalizedFts = ftsResults.map(r => ({
        ...r,
        similarity: maxFtsRank > 0 ? r.similarity / maxFtsRank : 0,
    }));

    const mergedMap = new Map<number, HybridSearchResult>();

    for (const r of vectorResults) {
        mergedMap.set(r.id, {
            id: r.id,
            content: r.content,
            name: r.name,
            similarity: r.similarity * HYBRID_WEIGHTS.vectorWeight,
            sources: ['vector'],
            vectorScore: r.similarity,
        });
    }

    for (const r of normalizedFts) {
        const existing = mergedMap.get(r.id);
        if (existing) {
            existing.similarity =
                (existing.vectorScore || 0) * HYBRID_WEIGHTS.vectorWeight +
                r.similarity * HYBRID_WEIGHTS.ftsWeight;
            existing.sources.push('fts');
            existing.ftsScore = r.similarity;
        } else {
            mergedMap.set(r.id, {
                id: r.id,
                content: r.content,
                name: r.name,
                similarity: r.similarity * HYBRID_WEIGHTS.ftsWeight,
                sources: ['fts'],
                ftsScore: r.similarity,
            });
        }
    }

    return Array.from(mergedMap.values())
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

// ============================================================================
// TickTick Tasks Embedding — Семантический поиск по задачам
// ============================================================================

/**
 * Создание и сохранение embedding для задачи TickTick.
 * Текст для embedding: заголовок + контент + пункты чек-листа
 */
export async function createTickTickTaskEmbedding(taskRecordId: number, title: string, content?: string | null, items?: any[]): Promise<void> {
    const parts = [title];
    if (content) parts.push(content.slice(0, 1000));
    if (items && items.length > 0) {
        items.forEach(item => parts.push(`item: ${item.title}`));
    }
    const textForEmbedding = parts.join(' | ');

    try {
        const embedding = await createEmbedding(textForEmbedding);
        const embeddingJson = serializeEmbedding(embedding);

        // Сохраняем в JSON колонку
        await db.update(ticktickTasks)
            .set({ embedding: embeddingJson })
            .where(sql`${ticktickTasks.id} = ${taskRecordId}`);

        // Сохраняем в pgvector колонку (если доступна)
        try {
            await db.execute(sql`
                UPDATE ticktick_tasks 
                SET embedding_vector = ${embeddingJson}::vector 
                WHERE id = ${taskRecordId}
            `);
        } catch (e: any) {
            console.log(`⚠️ pgvector ticktick_tasks UPDATE пропущен: ${e.message?.slice(0, 50)}`);
        }
    } catch (e: any) {
        console.log(`⚠️ TickTick task embedding пропущен (id=${taskRecordId}): ${e.message?.slice(0, 80)}`);
    }
}

/**
 * Поиск похожих задач TickTick по embedding
 */
export async function findSimilarTickTickTasks(
    queryEmbedding: number[],
    limit: number = 10,
    minSimilarity: number = 0.4,
    showCompleted: boolean = false
): Promise<SimilarityResult[]> {
    const embeddingJson = serializeEmbedding(queryEmbedding);

    // Попробуем pgvector поиск
    try {
        const statusFilter = !showCompleted ? sql`AND status = 0` : sql``;
        const pgvectorResults = await db.execute(sql`
            SELECT id, title as content, task_id as external_id,
                   1 - (embedding_vector <=> ${embeddingJson}::vector) as similarity
            FROM ticktick_tasks
            WHERE embedding_vector IS NOT NULL
              AND 1 - (embedding_vector <=> ${embeddingJson}::vector) >= ${minSimilarity}
              ${statusFilter}
            ORDER BY embedding_vector <=> ${embeddingJson}::vector
            LIMIT ${limit}
        `);

        if (pgvectorResults.rows && pgvectorResults.rows.length > 0) {
            console.log(`🔍 [pgvector] Найдено ${pgvectorResults.rows.length} задач TickTick`);
            return pgvectorResults.rows.map((row: any) => ({
                id: row.id,
                content: row.content,
                similarity: row.similarity as number,
                externalId: row.external_id, // Сохраняем оригинальный taskId для TickTick
            }));
        }
        return [];
    } catch (pgvectorError: any) {
        console.log(`⚠️ pgvector ticktick_tasks недоступен, fallback: ${pgvectorError.message?.slice(0, 50)}`);
    }

    // Fallback: O(N) поиск
    const allTasks = await db.select({
        id: ticktickTasks.id,
        title: ticktickTasks.title,
        status: ticktickTasks.status,
        embedding: ticktickTasks.embedding,
        taskId: ticktickTasks.taskId,
    }).from(ticktickTasks);

    const results: any[] = [];

    for (const task of allTasks) {
        if (!showCompleted && task.status === 2) continue;

        const taskEmbedding = parseEmbedding(task.embedding);
        if (!taskEmbedding) continue;

        const similarity = cosineSimilarity(queryEmbedding, taskEmbedding);

        if (similarity >= minSimilarity) {
            results.push({
                id: task.id,
                content: task.title,
                similarity,
                externalId: task.taskId,
            });
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}

/**
 * Семантический поиск задач TickTick по текстовому запросу
 */
export async function searchTickTickTasksByQuery(
    query: string,
    limit: number = 10,
    minSimilarity: number = 0.4,
    showCompleted: boolean = false
): Promise<SimilarityResult[]> {
    const queryEmbedding = await createEmbedding(query);
    return findSimilarTickTickTasks(queryEmbedding, limit, minSimilarity, showCompleted);
}

/**
 * Backfill: найти все задачи TickTick без embedding и сгенерировать их.
 * Вызывается после syncAllProjects для гарантии полноты эмбеддингов.
 */
export async function backfillMissingTaskEmbeddings(): Promise<{ total: number; created: number; failed: number }> {
    const tasksWithoutEmbedding = await db.select({
        id: ticktickTasks.id,
        title: ticktickTasks.title,
        content: ticktickTasks.content,
        items: ticktickTasks.items,
    }).from(ticktickTasks)
      .where(sql`${ticktickTasks.embedding} IS NULL`);

    if (tasksWithoutEmbedding.length === 0) {
        return { total: 0, created: 0, failed: 0 };
    }

    console.log(`🔄 [Backfill] Найдено ${tasksWithoutEmbedding.length} задач TickTick без эмбеддинга`);

    let created = 0;
    let failed = 0;

    for (const task of tasksWithoutEmbedding) {
        try {
            await createTickTickTaskEmbedding(task.id, task.title, task.content, task.items);
            created++;
            console.log(`  ✅ [${created}/${tasksWithoutEmbedding.length}] ${task.title.slice(0, 60)}`);
        } catch (e: any) {
            failed++;
            console.error(`  ❌ ${task.title.slice(0, 60)}: ${e.message?.slice(0, 80)}`);
        }
    }

    console.log(`🔄 [Backfill] Завершено: создано ${created}, ошибок ${failed} из ${tasksWithoutEmbedding.length}`);
    return { total: tasksWithoutEmbedding.length, created, failed };
}
