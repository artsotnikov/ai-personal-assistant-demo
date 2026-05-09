/**
 * Competitor Registry — Реестр конкурентов с версионированием атрибутов
 * 
 * Отвечает за:
 * - Создание/обновление конкурентов
 * - AI-резолвинг имён (дедупликация транскрипций)
 * - Система алиасов для альтернативных написаний
 * - Версионирование атрибутов (validFrom/validUntil)
 * - AI-парсинг данных о конкурентах из текста
 * - Сравнительный анализ
 */

import { db } from "./db";
import { competitors, competitorAttributes, type InsertCompetitor, type Competitor, type CompetitorAttribute } from "@shared/schema";
import { desc, eq, and, isNull, sql } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ============================================================================
// Типы
// ============================================================================

export interface CompetitorAttributeInput {
    key: string;
    value: string;
    category?: string;
}

export interface ParsedCompetitorData {
    competitorName: string;
    website?: string;
    attributes: CompetitorAttributeInput[];
}

export interface UpsertCompetitorResult {
    competitorId: number;
    competitorName: string;
    isNew: boolean;
    attributesCount: number;
    updatedAttributesCount: number;
    resolvedFrom?: string; // Если имя было резолвнуто из алиаса
}

interface NameResolutionResult {
    matchedCompetitorId: number | null;
    canonicalName: string;       // Каноническое название
    isNewCompetitor: boolean;
}

// ============================================================================
// Slug-утилита
// ============================================================================

function toSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[а-яё]/g, (char) => {
            const map: Record<string, string> = {
                'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
                'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
                'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
                'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
                'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
            };
            return map[char] || char;
        })
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// ============================================================================
// AI: Резолвинг имени конкурента
// ============================================================================

/**
 * AI определяет, является ли новое имя вариантом существующего конкурента.
 * Сравнивает с именами и алиасами всех конкурентов в базе.
 * 
 * Примеры:
 * - "Эдвайс" → существующий "Advies" (добавляет алиас)
 * - "B2B-Center" → существующий "B2B Center" (добавляет алиас)
 * - "НовыйСервис" → null (создаёт нового)
 */
async function resolveCompetitorName(incomingName: string): Promise<NameResolutionResult> {
    // 1. Загружаем всех активных конкурентов с алиасами
    const allCompetitors = await db.select()
        .from(competitors)
        .where(eq(competitors.isActive, true));

    if (allCompetitors.length === 0) {
        return { matchedCompetitorId: null, canonicalName: incomingName, isNewCompetitor: true };
    }

    // 2. Быстрая проверка точного совпадения (по name, slug, или алиасу)
    const incomingSlug = toSlug(incomingName);
    const incomingLower = incomingName.toLowerCase().trim();

    for (const c of allCompetitors) {
        if (c.slug === incomingSlug) {
            return { matchedCompetitorId: c.id, canonicalName: c.name, isNewCompetitor: false };
        }
        if (c.name.toLowerCase().trim() === incomingLower) {
            return { matchedCompetitorId: c.id, canonicalName: c.name, isNewCompetitor: false };
        }
        const aliases = (c.aliases || []) as string[];
        if (aliases.some(a => a.toLowerCase().trim() === incomingLower)) {
            return { matchedCompetitorId: c.id, canonicalName: c.name, isNewCompetitor: false };
        }
    }

    // 3. AI-резолвинг — нечёткое сравнение через LLM
    try {
        const competitorsList = allCompetitors.map(c => {
            const aliases = (c.aliases || []) as string[];
            const aliasStr = aliases.length > 0 ? ` (алиасы: ${aliases.join(', ')})` : '';
            return `ID=${c.id}: "${c.name}"${aliasStr}`;
        }).join('\n');

        const aiConfig = await getAIClientForTask('data_ingestion');
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.1, maxTokens: 200 },
            [
                {
                    role: 'system',
                    content: `Ты помогаешь определить, является ли название компании вариантом написания уже известного конкурента.
Учитывай:
- Транслитерацию (Advies ↔ Адвайс ↔ Эдвайс)
- Ошибки транскрипции голосового ввода
- Разные регистры и разделители (B2B Center ↔ b2b-center)
- Сокращения и полные формы

Вот список известных конкурентов:
${competitorsList}

Верни JSON:
{
  "matchedId": <ID конкурента или null если это новый>,
  "confidence": <число от 0 до 1>,
  "reason": "<почему считаешь что это тот же/новый>"
}

ВАЖНО: возвращай matchedId только если уверенность >= 0.7. Если сомневаешься — верни null.`
                },
                {
                    role: 'user',
                    content: `Новое название: "${incomingName}"`
                }
            ],
        );

        const raw = result.content || '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);

        if (parsed.matchedId && parsed.confidence >= 0.7) {
            const matched = allCompetitors.find(c => c.id === parsed.matchedId);
            if (matched) {
                console.log(`[CompetitorRegistry] 🔍 AI резолвинг: "${incomingName}" → "${matched.name}" (${(parsed.confidence * 100).toFixed(0)}%, ${parsed.reason})`);

                // Автоматически добавляем алиас
                await addAlias(matched.id, incomingName);

                return {
                    matchedCompetitorId: matched.id,
                    canonicalName: matched.name,
                    isNewCompetitor: false,
                };
            }
        }

        console.log(`[CompetitorRegistry] 🆕 AI резолвинг: "${incomingName}" — новый конкурент (${parsed.reason || 'нет совпадений'})`);
    } catch (error) {
        console.error('[CompetitorRegistry] Ошибка AI-резолвинга:', error);
        // Fallback — считаем новым
    }

    return { matchedCompetitorId: null, canonicalName: incomingName, isNewCompetitor: true };
}

/**
 * Добавить алиас к конкуренту (если ещё не существует)
 */
async function addAlias(competitorId: number, alias: string): Promise<void> {
    const [comp] = await db.select()
        .from(competitors)
        .where(eq(competitors.id, competitorId))
        .limit(1);

    if (!comp) return;

    const currentAliases = (comp.aliases || []) as string[];
    const aliasLower = alias.toLowerCase().trim();

    // Не добавляем если уже есть или совпадает с основным именем
    if (comp.name.toLowerCase().trim() === aliasLower) return;
    if (currentAliases.some(a => a.toLowerCase().trim() === aliasLower)) return;

    const updatedAliases = [...currentAliases, alias];

    await db.update(competitors)
        .set({ aliases: updatedAliases, updatedAt: new Date() })
        .where(eq(competitors.id, competitorId));

    console.log(`[CompetitorRegistry] 📝 Добавлен алиас "${alias}" к "${comp.name}" (всего: ${updatedAliases.length})`);
}

// ============================================================================
// AI: Парсинг данных о конкуренте из текста
// ============================================================================

export async function parseCompetitorData(text: string): Promise<ParsedCompetitorData | null> {
    try {
        const aiConfig = await getAIClientForTask('data_ingestion');
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.2, maxTokens: 500 },
            [
                {
                    role: 'system',
                    content: `Извлеки из текста информацию о конкуренте. Верни JSON:
{
  "competitorName": "Название компании",
  "website": "сайт (если есть)",
  "attributes": [
    { "key": "описательный_ключ", "value": "значение", "category": "pricing|features|technology|general" }
  ]
}

Правила:
- key должен быть коротким и описательным (напр. "тариф_500", "технология", "автоперепубликация")
- category: pricing (тарифы, цены), features (функции), technology (стек), general (прочее)
- Не выдумывай данные, извлекай только то, что есть в тексте
- Если конкурент не найден, верни null`
                },
                { role: 'user', content: text }
            ],
        );

        const raw = result.content || '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        if (cleaned === 'null' || !cleaned) return null;

        const parsed = JSON.parse(cleaned);
        if (!parsed.competitorName) return null;

        return {
            competitorName: parsed.competitorName,
            website: parsed.website || undefined,
            attributes: (parsed.attributes || []).map((a: any) => ({
                key: a.key,
                value: a.value,
                category: a.category || 'general',
            })),
        };
    } catch (error) {
        console.error('[CompetitorRegistry] Ошибка AI-парсинга:', error);
        return null;
    }
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Создать или обновить конкурента + его атрибуты
 * Использует AI-резолвинг для дедупликации имён из голосового ввода
 */
export async function upsertCompetitor(data: ParsedCompetitorData, sourceDocumentId?: number): Promise<UpsertCompetitorResult> {
    console.log(`[CompetitorRegistry] 🏢 Upsert конкурента: ${data.competitorName}`);

    // 1. AI-резолвинг имени — ищем существующего или создаём нового
    const resolution = await resolveCompetitorName(data.competitorName);

    let existing: Competitor | undefined;
    let isNew = resolution.isNewCompetitor;

    if (!resolution.isNewCompetitor && resolution.matchedCompetitorId) {
        // Нашли существующего конкурента
        [existing] = await db.select()
            .from(competitors)
            .where(eq(competitors.id, resolution.matchedCompetitorId))
            .limit(1);
    }

    if (!existing) {
        // Создаём нового
        const slug = toSlug(data.competitorName);
        // Проверяем уникальность slug
        const [existingBySlug] = await db.select()
            .from(competitors)
            .where(eq(competitors.slug, slug))
            .limit(1);

        if (existingBySlug) {
            // Slug уже занят — используем существующего
            existing = existingBySlug;
            isNew = false;
        } else {
            [existing] = await db.insert(competitors).values({
                name: data.competitorName,
                slug,
                aliases: [],
                website: data.website || null,
                isActive: true,
            }).returning();
            isNew = true;
            console.log(`[CompetitorRegistry]   ✅ Создан конкурент #${existing.id} "${existing.name}"`);
        }
    } else {
        // Обновляем website если пришёл новый
        if (data.website && data.website !== existing.website) {
            await db.update(competitors)
                .set({ website: data.website, updatedAt: new Date(), lastUpdated: new Date() })
                .where(eq(competitors.id, existing.id));
        }
    }

    // 2. Upsert атрибутов с версионированием
    let updatedCount = 0;
    const now = new Date();

    for (const attr of data.attributes) {
        // Найти текущий актуальный атрибут с тем же ключом
        const [currentAttr] = await db.select()
            .from(competitorAttributes)
            .where(and(
                eq(competitorAttributes.competitorId, existing.id),
                eq(competitorAttributes.key, attr.key),
                isNull(competitorAttributes.validUntil),
            ))
            .limit(1);

        if (currentAttr && currentAttr.value === attr.value) {
            // Значение не изменилось — пропускаем
            continue;
        }

        if (currentAttr) {
            // Закрываем старый атрибут
            await db.update(competitorAttributes)
                .set({ validUntil: now })
                .where(eq(competitorAttributes.id, currentAttr.id));
            updatedCount++;
        }

        // Создаём новый атрибут
        await db.insert(competitorAttributes).values({
            competitorId: existing.id,
            key: attr.key,
            value: attr.value,
            category: attr.category || null,
            sourceDocumentId: sourceDocumentId || null,
            validFrom: now,
        });
    }

    console.log(`[CompetitorRegistry]   ✅ ${data.attributes.length} атрибутов, ${updatedCount} обновлено`);

    return {
        competitorId: existing.id,
        competitorName: existing.name,
        isNew,
        attributesCount: data.attributes.length,
        updatedAttributesCount: updatedCount,
        resolvedFrom: !isNew && data.competitorName !== existing.name ? data.competitorName : undefined,
    };
}

/**
 * Получить конкурента с актуальными атрибутами
 */
export async function getCompetitor(nameOrSlug: string): Promise<{ competitor: Competitor; attributes: CompetitorAttribute[] } | null> {
    const slug = toSlug(nameOrSlug);

    const [competitor] = await db.select()
        .from(competitors)
        .where(eq(competitors.slug, slug))
        .limit(1);

    if (!competitor) return null;

    const attrs = await db.select()
        .from(competitorAttributes)
        .where(and(
            eq(competitorAttributes.competitorId, competitor.id),
            isNull(competitorAttributes.validUntil),
        ))
        .orderBy(competitorAttributes.category);

    return { competitor, attributes: attrs };
}

/**
 * Получить всех активных конкурентов
 */
export async function getAllCompetitors(): Promise<Competitor[]> {
    return db.select()
        .from(competitors)
        .where(eq(competitors.isActive, true))
        .orderBy(competitors.name);
}

/**
 * Сравнительная таблица всех конкурентов
 */
export async function getCompetitorComparison(): Promise<Array<{
    competitor: Competitor;
    attributes: CompetitorAttribute[];
}>> {
    const allCompetitors = await getAllCompetitors();
    const result = [];

    for (const c of allCompetitors) {
        const attrs = await db.select()
            .from(competitorAttributes)
            .where(and(
                eq(competitorAttributes.competitorId, c.id),
                isNull(competitorAttributes.validUntil),
            ));
        result.push({ competitor: c, attributes: attrs });
    }

    return result;
}
