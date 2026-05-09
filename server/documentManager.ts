/**
 * Document Manager — Сохранение и поиск полных документов
 * 
 * Отвечает за:
 * - Сохранение документов (отчёты, анализы, стратегии) целиком
 * - AI-генерация заголовка и summary
 * - Поиск по типу и ключевым словам
 */

import { db } from "./db";
import { documents, type InsertDocument, type Document } from "@shared/schema";
import { desc, eq, and, ilike, sql } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ============================================================================
// Типы
// ============================================================================

export interface SaveDocumentInput {
    content: string;
    contentType?: string;       // 'markdown' | 'plain_text' | 'csv' | 'report'
    documentType?: string;      // 'competitor_analysis' | 'financial_report' | 'strategy' | 'general'
    title?: string;             // Если не задан — AI сгенерирует
    metadata?: Record<string, any>;
    sourceMessageId?: number;
}

export interface SaveDocumentResult {
    documentId: number;
    title: string;
    summary: string;
    documentType: string;
}

// ============================================================================
// AI: Генерация title и summary
// ============================================================================

async function generateDocumentMeta(content: string): Promise<{ title: string; summary: string; documentType: string }> {
    try {
        const aiConfig = await getAIClientForTask('data_ingestion');
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.3, maxTokens: 300 },
            [
                {
                    role: 'system',
                    content: `Ты анализируешь текстовый документ. Извлеки из него:
1. title — краткий заголовок (до 80 символов)
2. summary — сжатое описание содержимого (2-3 предложения)
3. documentType — один из: "competitor_analysis", "financial_report", "strategy", "general"

Ответ в JSON:
{ "title": "...", "summary": "...", "documentType": "..." }`
                },
                { role: 'user', content: content.substring(0, 3000) }
            ],
        );

        const raw = result.content || '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);

        return {
            title: parsed.title || 'Без названия',
            summary: parsed.summary || '',
            documentType: parsed.documentType || 'general',
        };
    } catch (error) {
        console.error('[DocumentManager] Ошибка генерации мета:', error);
        return {
            title: 'Документ',
            summary: '',
            documentType: 'general',
        };
    }
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Сохранить документ
 */
export async function saveDocument(input: SaveDocumentInput): Promise<SaveDocumentResult> {
    console.log('[DocumentManager] 📄 Сохранение документа...');

    // AI генерирует мета, если не заданы
    const meta = await generateDocumentMeta(input.content);

    const doc: InsertDocument = {
        title: input.title || meta.title,
        content: input.content,
        contentType: input.contentType || 'plain_text',
        documentType: input.documentType || meta.documentType,
        summary: meta.summary,
        metadata: input.metadata || null,
        sourceMessageId: input.sourceMessageId || null,
        isActive: true,
    };

    const [saved] = await db.insert(documents).values(doc).returning();

    console.log(`[DocumentManager] ✅ Документ #${saved.id} "${saved.title}" сохранён`);

    return {
        documentId: saved.id,
        title: saved.title,
        summary: meta.summary,
        documentType: saved.documentType,
    };
}

/**
 * Поиск документов — гибридный (FTS + vector + ILIKE fallback)
 * 
 * Три канала поиска с разными весами:
 * 1. FTS через tsvector (точные слова) — вес 0.4
 * 2. Vector через pgvector (семантика) — вес 0.5
 * 3. ILIKE fallback (подстрока) — вес 0.1
 * 
 * Результаты дедуплицируются по ID и ранжируются по финальному score.
 */
export async function searchDocuments(query: string, limit: number = 5): Promise<Document[]> {
    const results = new Map<number, { doc: Document; score: number; sources: string[] }>();

    // Канал 1: FTS через tsvector (если миграция применена)
    try {
        const words = query
            .replace(/[^\w\sа-яА-ЯёЁ-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 2)
            .map(w => `${w.toLowerCase()}:*`);

        if (words.length > 0) {
            const tsQuery = words.join(' | ');
            const ftsResults = await db.execute(sql`
                SELECT *, ts_rank(search_vector, to_tsquery('simple', ${tsQuery})) as rank
                FROM documents
                WHERE is_active = true
                  AND search_vector @@ to_tsquery('simple', ${tsQuery})
                ORDER BY rank DESC
                LIMIT ${limit * 2}
            `);

            if (ftsResults.rows && ftsResults.rows.length > 0) {
                const maxRank = Math.max(...(ftsResults.rows as any[]).map(r => r.rank || 0));
                for (const row of ftsResults.rows as any[]) {
                    const normalizedScore = maxRank > 0 ? (row.rank / maxRank) * 0.4 : 0;
                    results.set(row.id, {
                        doc: row as unknown as Document,
                        score: normalizedScore,
                        sources: ['fts'],
                    });
                }
                console.log(`[DocumentSearch] 📝 FTS: ${ftsResults.rows.length} документов`);
            }
        }
    } catch (error: any) {
        // FTS недоступен — пропускаем
        if (!error.message?.includes('search_vector')) {
            console.error('[DocumentSearch] FTS ошибка:', error.message?.slice(0, 60));
        }
    }

    // Канал 2: Vector search через pgvector (если embedding есть)
    try {
        const { createEmbedding } = await import('./embeddingService');
        const queryEmbedding = await createEmbedding(query);

        const vectorResults = await db.execute(sql`
            SELECT *, 1 - (embedding_vector::vector <=> ${JSON.stringify(queryEmbedding)}::vector) as similarity
            FROM documents
            WHERE is_active = true
              AND embedding_vector IS NOT NULL
            ORDER BY embedding_vector::vector <=> ${JSON.stringify(queryEmbedding)}::vector
            LIMIT ${limit * 2}
        `);

        if (vectorResults.rows && vectorResults.rows.length > 0) {
            for (const row of vectorResults.rows as any[]) {
                if ((row.similarity || 0) < 0.3) continue; // минимальный порог
                const existing = results.get(row.id);
                const vectorScore = (row.similarity || 0) * 0.5;

                if (existing) {
                    existing.score += vectorScore;
                    existing.sources.push('vector');
                } else {
                    results.set(row.id, {
                        doc: row as unknown as Document,
                        score: vectorScore,
                        sources: ['vector'],
                    });
                }
            }
            console.log(`[DocumentSearch] 🔍 Vector: ${vectorResults.rows.length} документов`);
        }
    } catch (error: any) {
        // Vector search недоступен — пропускаем
        console.log(`[DocumentSearch] ⚠️ Vector пропущен: ${error.message?.slice(0, 60)}`);
    }

    // Канал 3: ILIKE fallback (всегда работает)
    if (results.size < limit) {
        try {
            const ilikeResults = await db.select()
                .from(documents)
                .where(and(
                    eq(documents.isActive, true),
                    sql`(
                        ${documents.title} ILIKE ${'%' + query + '%'} OR 
                        ${documents.summary} ILIKE ${'%' + query + '%'} OR
                        ${documents.content} ILIKE ${'%' + query + '%'}
                    )`
                ))
                .orderBy(desc(documents.createdAt))
                .limit(limit);

            for (const doc of ilikeResults) {
                const existing = results.get(doc.id);
                if (existing) {
                    existing.score += 0.1;
                    existing.sources.push('ilike');
                } else {
                    results.set(doc.id, { doc, score: 0.1, sources: ['ilike'] });
                }
            }
        } catch (error) {
            console.error('[DocumentSearch] ILIKE ошибка:', error);
        }
    }

    // Сортируем по score и возвращаем top-N
    const sorted = Array.from(results.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    if (sorted.length > 0) {
        const srcStats = sorted.map(r => r.sources.join('+')).join(', ');
        console.log(`[DocumentSearch] 🔀 Итого: ${sorted.length} документов (${srcStats})`);
    }

    return sorted.map(r => r.doc);
}


/**
 * Последние документы
 */
export async function getRecentDocuments(limit: number = 5): Promise<Document[]> {
    return db.select()
        .from(documents)
        .where(eq(documents.isActive, true))
        .orderBy(desc(documents.createdAt))
        .limit(limit);
}

/**
 * Документы по типу
 */
export async function getDocumentsByType(documentType: string, limit: number = 10): Promise<Document[]> {
    return db.select()
        .from(documents)
        .where(and(
            eq(documents.isActive, true),
            eq(documents.documentType, documentType),
        ))
        .orderBy(desc(documents.createdAt))
        .limit(limit);
}
