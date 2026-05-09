/**
 * Скрипт дедупликации тем
 * 
 * Находит похожие темы (similarity > 0.80) и объединяет их:
 * 1. Выбирает каноническую тему (с большим количеством фактов)
 * 2. Переносит факты с дублей на каноническую
 * 3. Удаляет пустые дубли
 * 
 * Запуск: npx tsx server/scripts/deduplicateTopics.ts
 * 
 * Опции:
 *   --dry-run  - только показать, что будет сделано (по умолчанию)
 *   --execute  - реально выполнить изменения
 */

import 'dotenv/config';
import { db } from "../db";
import { topics, facts } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

const SIMILARITY_THRESHOLD = 0.82;
const isDryRun = !process.argv.includes('--execute');

// Ручные правила для родительских тем (одно и то же по смыслу)
const PARENT_MERGE_RULES: Array<{ from: string; to: string }> = [
    { from: 'Личная жизнь', to: 'Жизнь' },
];

interface DuplicatePair {
    keepId: number;
    keepName: string;
    keepFacts: number;
    mergeId: number;
    mergeName: string;
    mergeFacts: number;
    similarity: number;
}

async function findDuplicates(): Promise<DuplicatePair[]> {
    console.log(`\n🔍 Поиск дубликатов тем (порог: ${SIMILARITY_THRESHOLD})...\n`);

    const result = await db.execute<{
        keep_id: number;
        keep_name: string;
        keep_facts: number;
        merge_id: number;
        merge_name: string;
        merge_facts: number;
        similarity: number;
    }>(sql`
        SELECT 
            t1.id as keep_id,
            t1.name as keep_name,
            t1.fact_count as keep_facts,
            t2.id as merge_id,
            t2.name as merge_name,
            t2.fact_count as merge_facts,
            1 - (t1.embedding_vector <=> t2.embedding_vector) as similarity
        FROM topics t1
        JOIN topics t2 ON t1.id < t2.id
        WHERE t1.embedding_vector IS NOT NULL 
            AND t2.embedding_vector IS NOT NULL
            AND 1 - (t1.embedding_vector <=> t2.embedding_vector) > ${SIMILARITY_THRESHOLD}
        ORDER BY similarity DESC
    `);

    // Преобразуем и выбираем каноническую тему (с большим количеством фактов)
    const pairs: DuplicatePair[] = [];
    const processed = new Set<number>();

    for (const row of result.rows) {
        const id1 = row.keep_id;
        const id2 = row.merge_id;

        // Пропускаем если одна из тем уже обработана
        if (processed.has(id1) || processed.has(id2)) continue;

        // Определяем кто keep, кто merge по количеству фактов
        const facts1 = row.keep_facts;
        const facts2 = row.merge_facts;

        if (facts1 >= facts2) {
            pairs.push({
                keepId: id1,
                keepName: row.keep_name,
                keepFacts: facts1,
                mergeId: id2,
                mergeName: row.merge_name,
                mergeFacts: facts2,
                similarity: row.similarity,
            });
            processed.add(id2);
        } else {
            pairs.push({
                keepId: id2,
                keepName: row.merge_name,
                keepFacts: facts2,
                mergeId: id1,
                mergeName: row.keep_name,
                mergeFacts: facts1,
                similarity: row.similarity,
            });
            processed.add(id1);
        }
    }

    return pairs;
}

async function mergeTopic(pair: DuplicatePair): Promise<void> {
    console.log(`\n  📦 Объединение: "${pair.mergeName}" → "${pair.keepName}"`);
    console.log(`     Similarity: ${(pair.similarity * 100).toFixed(1)}%`);
    console.log(`     Фактов: ${pair.mergeFacts} → переносится в тему с ${pair.keepFacts} фактами`);

    if (isDryRun) {
        console.log(`     ⏸️  [DRY-RUN] Пропуск...`);
        return;
    }

    // 1. Переносим все факты на каноническую тему
    const movedFacts = await db.update(facts)
        .set({ topicId: pair.keepId })
        .where(eq(facts.topicId, pair.mergeId))
        .returning();

    console.log(`     ✅ Перенесено ${movedFacts.length} фактов`);

    // 2. Обновляем счётчик фактов
    await db.update(topics)
        .set({
            factCount: sql`${topics.factCount} + ${pair.mergeFacts}`,
            updatedAt: new Date(),
        })
        .where(eq(topics.id, pair.keepId));

    // 3. Удаляем дубль
    await db.delete(topics).where(eq(topics.id, pair.mergeId));

    console.log(`     🗑️  Удалена тема "${pair.mergeName}" (id: ${pair.mergeId})`);
}

/**
 * Объединение родительских тем по ручным правилам
 */
async function mergeParentTopics(): Promise<number> {
    console.log('\n🏷️  Проверка родительских тем...\n');
    let merged = 0;

    for (const rule of PARENT_MERGE_RULES) {
        // Находим темы
        const [fromParent] = await db.select().from(topics).where(eq(topics.name, rule.from));
        const [toParent] = await db.select().from(topics).where(eq(topics.name, rule.to));

        if (!fromParent) {
            console.log(`  ⏭️  "${rule.from}" не найден, пропуск`);
            continue;
        }
        if (!toParent) {
            console.log(`  ⏭️  "${rule.to}" не найден, пропуск`);
            continue;
        }

        console.log(`  📦 Объединение родителя: "${rule.from}" → "${rule.to}"`);

        // Находим все подтемы fromParent
        const childTopics = await db.select().from(topics).where(eq(topics.parentId, fromParent.id));
        console.log(`     Найдено ${childTopics.length} подтем`);

        if (isDryRun) {
            for (const child of childTopics) {
                const newName = child.name.replace(rule.from, rule.to);
                console.log(`     ⏸️  [DRY-RUN] ${child.name} → ${newName}`);
            }
            console.log(`     ⏸️  [DRY-RUN] Удаление "${rule.from}" пропущено`);
            continue;
        }

        // Переносим подтемы
        for (const child of childTopics) {
            const newName = child.name.replace(rule.from, rule.to);

            // Проверяем, нет ли уже такой темы
            const [existing] = await db.select().from(topics).where(eq(topics.name, newName));

            if (existing) {
                // Переносим факты и удаляем дубль
                const movedFacts = await db.update(facts)
                    .set({ topicId: existing.id })
                    .where(eq(facts.topicId, child.id))
                    .returning();

                await db.update(topics)
                    .set({ factCount: sql`${topics.factCount} + ${child.factCount}` })
                    .where(eq(topics.id, existing.id));

                await db.delete(topics).where(eq(topics.id, child.id));
                console.log(`     ✅ ${child.name} → ${existing.name} (${movedFacts.length} фактов, удалён дубль)`);
            } else {
                // Просто переименовываем
                await db.update(topics)
                    .set({ name: newName, parentId: toParent.id, updatedAt: new Date() })
                    .where(eq(topics.id, child.id));
                console.log(`     ✅ ${child.name} → ${newName}`);
            }
        }

        // Удаляем пустого родителя
        await db.delete(topics).where(eq(topics.id, fromParent.id));
        console.log(`     🗑️  Удалён родитель "${rule.from}" (id: ${fromParent.id})`);
        merged++;
    }

    return merged;
}

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('       🧹 ДЕДУПЛИКАЦИЯ ТЕМ ПАМЯТИ');
    console.log('═══════════════════════════════════════════════════════');

    if (isDryRun) {
        console.log('\n⚠️  РЕЖИМ: DRY-RUN (только просмотр)');
        console.log('   Для реального выполнения запустите с --execute\n');
    } else {
        console.log('\n🔴 РЕЖИМ: EXECUTE (реальные изменения в БД)\n');
    }

    // 1. Объединяем родительские темы
    const mergedParents = await mergeParentTopics();

    // 2. Ищем дубликаты по similarity
    const duplicates = await findDuplicates();

    if (duplicates.length === 0 && mergedParents === 0) {
        console.log('✨ Дубликаты не найдены!');
        process.exit(0);
    }

    if (duplicates.length > 0) {
        console.log(`\n📋 Найдено ${duplicates.length} пар для объединения:\n`);

        for (const pair of duplicates) {
            console.log(`  • "${pair.mergeName}" → "${pair.keepName}" (${(pair.similarity * 100).toFixed(1)}%)`);
        }

        // Выполняем объединение
        console.log('\n───────────────────────────────────────────────────────');
        console.log('                    ОБРАБОТКА');
        console.log('───────────────────────────────────────────────────────');

        for (const pair of duplicates) {
            await mergeTopic(pair);
        }
    }

    console.log('\n═══════════════════════════════════════════════════════');
    if (isDryRun) {
        console.log('✅ DRY-RUN завершён. Запустите с --execute для применения.');
    } else {
        console.log(`✅ Готово! Родителей: ${mergedParents}, дублей: ${duplicates.length}`);
    }
    console.log('═══════════════════════════════════════════════════════\n');

    process.exit(0);
}

main().catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
