/**
 * Скрипт чистки фактов: удаление дублей и мусора
 * 
 * Этапы:
 * 1. DRY-RUN: анализ без изменений (по умолчанию)
 * 2. APPLY: помечает дубли как is_current=false
 * 
 * Запуск:
 *   npx tsx scripts/clean-duplicate-facts.ts              # dry-run
 *   npx tsx scripts/clean-duplicate-facts.ts --apply       # применить
 *   npx tsx scripts/clean-duplicate-facts.ts --threshold 0.60  # свой порог
 */
import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';
import { getAIClientForTask, callWithFallback } from '../server/aiConfigService';

// ── Конфигурация ──────────────────────────────────────────────
const DEFAULT_SIMILARITY_THRESHOLD = 0.55;
const AUTO_DUPLICATE_THRESHOLD = 0.88;
const BATCH_SIZE = 50; // Сколько пар обрабатывать за один batch AI-Judge

// ── Аргументы командной строки ────────────────────────────────
const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const thresholdArg = args.find(a => a.startsWith('--threshold'));
const threshold = thresholdArg
    ? parseFloat(args[args.indexOf(thresholdArg) + 1] || String(DEFAULT_SIMILARITY_THRESHOLD))
    : DEFAULT_SIMILARITY_THRESHOLD;
const skipJudge = args.includes('--skip-judge');

// ── Типы ─────────────────────────────────────────────────────
interface FactPair {
    id_a: number;
    id_b: number;
    content_a: string;
    content_b: string;
    topic_a: string | null;
    topic_b: string | null;
    similarity: number;
    created_a: Date;
    created_b: Date;
}

interface CleanupDecision {
    pair: FactPair;
    verdict: 'DUPLICATE' | 'UPDATE' | 'NEW' | 'AUTO_DUPLICATE';
    keepId: number;
    removeId: number;
    reason: string;
}

// ── Основной скрипт ──────────────────────────────────────────
async function main() {
    console.log('🧹 Скрипт чистки фактов');
    console.log('════════════════════════════════════════════');
    console.log(`📊 Режим: ${applyMode ? '⚡ APPLY (изменения будут применены!)' : '👀 DRY-RUN (только анализ)'}`);
    console.log(`📏 Порог similarity: ${threshold}`);
    console.log(`🤖 AI-Judge: ${skipJudge ? 'отключен' : 'включен'}`);
    console.log('');

    // ── Этап 0: Общая статистика ──
    const stats = await getStats();
    console.log(`📦 Текущие факты: ${stats.current}`);
    console.log(`📦 Архивные факты: ${stats.old}`);
    console.log(`⚠️  Без embedding: ${stats.noEmbedding}`);
    console.log('');

    // ── Этап 1: Найти все пары дублей ──
    console.log('🔍 Ищу пары похожих фактов...');
    const pairs = await findDuplicatePairs(threshold);
    console.log(`   Найдено ${pairs.length} пар с similarity ≥ ${threshold}`);
    console.log('');

    if (pairs.length === 0) {
        console.log('✅ Дублей не найдено! База чистая.');
        process.exit(0);
    }

    // ── Этап 2: Анализ каждой пары (AI-Judge или auto) ──
    console.log('⚖️  Анализирую пары...');
    const decisions: CleanupDecision[] = [];
    let autoCount = 0;
    let judgeCount = 0;
    let newCount = 0;

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];

        if (i > 0 && i % 20 === 0) {
            console.log(`   ... обработано ${i}/${pairs.length} пар`);
        }

        // Авто-дубликат: очень высокая similarity
        if (pair.similarity >= AUTO_DUPLICATE_THRESHOLD) {
            const keepId = chooseKeepId(pair);
            const removeId = keepId === pair.id_a ? pair.id_b : pair.id_a;
            decisions.push({
                pair,
                verdict: 'AUTO_DUPLICATE',
                keepId,
                removeId,
                reason: `Auto: similarity ${(pair.similarity * 100).toFixed(1)}%`
            });
            autoCount++;
            continue;
        }

        // AI-Judge для серой зоны
        if (!skipJudge) {
            try {
                const judgeResult = await judgeWithAI(pair.content_a, pair.content_b, pair.similarity);
                judgeCount++;

                if (judgeResult.verdict === 'DUPLICATE') {
                    const keepId = chooseKeepId(pair);
                    const removeId = keepId === pair.id_a ? pair.id_b : pair.id_a;
                    decisions.push({
                        pair,
                        verdict: 'DUPLICATE',
                        keepId,
                        removeId,
                        reason: judgeResult.reason
                    });
                } else if (judgeResult.verdict === 'UPDATE') {
                    // При UPDATE оставляем более новый (он содержит обновление)
                    const keepId = pair.created_a > pair.created_b ? pair.id_a : pair.id_b;
                    const removeId = keepId === pair.id_a ? pair.id_b : pair.id_a;
                    decisions.push({
                        pair,
                        verdict: 'UPDATE',
                        keepId,
                        removeId,
                        reason: judgeResult.reason
                    });
                } else {
                    newCount++;
                }
            } catch (error) {
                console.error(`   ⚠️ AI-Judge ошибка для пары ${pair.id_a}/${pair.id_b}:`, error);
            }
        } else {
            // Без AI-Judge — считаем дубликатом всё выше 0.75
            if (pair.similarity >= 0.75) {
                const keepId = chooseKeepId(pair);
                const removeId = keepId === pair.id_a ? pair.id_b : pair.id_a;
                decisions.push({
                    pair,
                    verdict: 'AUTO_DUPLICATE',
                    keepId,
                    removeId,
                    reason: `No-judge: similarity ${(pair.similarity * 100).toFixed(1)}%`
                });
                autoCount++;
            }
        }
    }

    console.log('');
    console.log(`   ✅ Авто-дубликатов: ${autoCount}`);
    console.log(`   ⚖️  AI-Judge проверено: ${judgeCount}`);
    console.log(`   ✳️  Разные факты (NEW): ${newCount}`);
    console.log('');

    // ── Этап 3: Дедупликация решений (один факт может быть в нескольких парах) ──
    const uniqueRemovals = deduplicateDecisions(decisions);
    console.log(`🎯 К удалению: ${uniqueRemovals.size} уникальных фактов`);
    console.log('');

    // ── Этап 4: Отчёт ──
    printReport(decisions, uniqueRemovals);

    // ── Этап 5: Применение ──
    if (applyMode && uniqueRemovals.size > 0) {
        console.log('');
        console.log('⚡ Применяю изменения...');
        await applyCleanup(uniqueRemovals, decisions);

        const newStats = await getStats();
        console.log('');
        console.log('📊 Результат:');
        console.log(`   Было: ${stats.current} текущих фактов`);
        console.log(`   Стало: ${newStats.current} текущих фактов`);
        console.log(`   Удалено: ${stats.current - newStats.current} дублей`);
    } else if (uniqueRemovals.size > 0) {
        console.log('');
        console.log('👀 DRY-RUN завершён. Для применения запустите с --apply');
    }

    process.exit(0);
}

// ── Вспомогательные функции ──────────────────────────────────

async function getStats() {
    const result = await db.execute(sql`
        SELECT 
            COUNT(*) FILTER (WHERE is_current = true) as current,
            COUNT(*) FILTER (WHERE is_current = false) as old,
            COUNT(*) FILTER (WHERE is_current = true AND embedding_vector IS NULL) as no_embedding
        FROM facts
    `);
    const row = result.rows[0] as any;
    return {
        current: Number(row.current),
        old: Number(row.old),
        noEmbedding: Number(row.no_embedding),
    };
}

async function findDuplicatePairs(minSimilarity: number): Promise<FactPair[]> {
    const result = await db.execute(sql`
        WITH pairs AS (
            SELECT 
                a.id as id_a,
                b.id as id_b,
                a.content as content_a,
                b.content as content_b,
                ta.name as topic_a,
                tb.name as topic_b,
                1 - (a.embedding_vector <=> b.embedding_vector) as similarity,
                a.created_at as created_a,
                b.created_at as created_b
            FROM facts a
            JOIN facts b ON a.id < b.id
            LEFT JOIN topics ta ON a.topic_id = ta.id
            LEFT JOIN topics tb ON b.topic_id = tb.id
            WHERE a.is_current = true AND b.is_current = true
              AND a.embedding_vector IS NOT NULL AND b.embedding_vector IS NOT NULL
              AND 1 - (a.embedding_vector <=> b.embedding_vector) >= ${minSimilarity}
        )
        SELECT * FROM pairs
        ORDER BY similarity DESC
    `);

    return result.rows.map((row: any) => ({
        id_a: Number(row.id_a),
        id_b: Number(row.id_b),
        content_a: String(row.content_a),
        content_b: String(row.content_b),
        topic_a: row.topic_a ? String(row.topic_a) : null,
        topic_b: row.topic_b ? String(row.topic_b) : null,
        similarity: Number(row.similarity),
        created_a: new Date(row.created_a),
        created_b: new Date(row.created_b),
    }));
}

/**
 * Выбрать какой факт оставить: более длинный и подробный, при равной длине — более новый
 */
function chooseKeepId(pair: FactPair): number {
    // Более длинный (подробный) факт — приоритет
    const lenDiff = pair.content_a.length - pair.content_b.length;
    if (Math.abs(lenDiff) > 20) {
        return lenDiff > 0 ? pair.id_a : pair.id_b;
    }
    // При схожей длине — оставляем более новый
    return pair.created_a > pair.created_b ? pair.id_a : pair.id_b;
}

const CLEANUP_JUDGE_SYSTEM_PROMPT = `Ты — судья-дедупликатор фактов в базе знаний. Тебе даны ДВА факта из базы. Определи, являются ли они дубликатами.

Ответь СТРОГО JSON: {"verdict": "DUPLICATE|UPDATE|NEW", "reason": "краткое пояснение"}

Правила:
- DUPLICATE — факты говорят ОБ ОДНОМ И ТОМ ЖЕ разными словами, ИЛИ один является частью другого. При сомнении — ставь DUPLICATE.
- UPDATE — факты об одном предмете, НО содержат РАЗНЫЕ числа/даты/значения (обновлённые данные)
- NEW — факты о СОВЕРШЕННО разных вещах

⚠️ ВАЖНО для чистки базы:
- Два факта про одно и то же разными словами = DUPLICATE (пример: "ИП на отца" и "Бизнес оформлен на ИП отца")
- Один факт — подробная версия другого = DUPLICATE (оставим подробный)
- Факты про один предмет с разными числами = UPDATE
- Только если предметы РЕАЛЬНО разные = NEW`;

async function judgeWithAI(
    contentA: string,
    contentB: string,
    similarity: number
): Promise<{ verdict: 'DUPLICATE' | 'UPDATE' | 'NEW'; reason: string }> {
    const aiConfig = await getAIClientForTask('fact_judge');

    const userPrompt = `Cosine similarity: ${(similarity * 100).toFixed(1)}%

НОВЫЙ ФАКТ: "${contentA}"
СУЩЕСТВУЮЩИЙ ФАКТ: "${contentB}"

Ответь ТОЛЬКО JSON: {"verdict": "DUPLICATE|UPDATE|NEW", "reason": "..."}`;

    const result = await callWithFallback(aiConfig, [
        { role: 'system', content: CLEANUP_JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
    ]);

    try {
        const cleanResult = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanResult);
        const verdict = (parsed.verdict || 'NEW').toUpperCase();
        if (!['DUPLICATE', 'UPDATE', 'NEW'].includes(verdict)) {
            return { verdict: 'NEW', reason: 'Invalid verdict' };
        }
        return { verdict: verdict as any, reason: parsed.reason || '' };
    } catch {
        return { verdict: 'NEW', reason: 'Parse error' };
    }
}

/**
 * Дедупликация решений: если факт уже помечен на удаление в одной паре,
 * не удалять его повторно из другой пары
 */
function deduplicateDecisions(decisions: CleanupDecision[]): Set<number> {
    const toRemove = new Set<number>();
    const toKeep = new Set<number>();

    // Сортируем по убыванию similarity для приоритета
    const sorted = [...decisions].sort((a, b) => b.pair.similarity - a.pair.similarity);

    for (const decision of sorted) {
        // Не удаляем факт, если он уже помечен как "оставить" в более важной паре
        if (toKeep.has(decision.removeId)) continue;
        // Не удаляем факт, если он уже удалён
        if (toRemove.has(decision.removeId)) continue;

        toRemove.add(decision.removeId);
        toKeep.add(decision.keepId);
    }

    return toRemove;
}

function printReport(decisions: CleanupDecision[], uniqueRemovals: Set<number>) {
    console.log('═══════════════════════════════════════════════════');
    console.log('📋 ОТЧЁТ О ДУБЛЯХ');
    console.log('═══════════════════════════════════════════════════');

    const grouped = {
        auto: decisions.filter(d => d.verdict === 'AUTO_DUPLICATE'),
        duplicate: decisions.filter(d => d.verdict === 'DUPLICATE'),
        update: decisions.filter(d => d.verdict === 'UPDATE'),
    };

    if (grouped.auto.length > 0) {
        console.log(`\n🔴 Авто-дубликаты (similarity ≥ ${(AUTO_DUPLICATE_THRESHOLD * 100).toFixed(0)}%): ${grouped.auto.length}`);
        for (const d of grouped.auto.slice(0, 10)) {
            const removed = uniqueRemovals.has(d.removeId) ? '❌' : '⏭️';
            console.log(`   ${removed} #${d.removeId} → #${d.keepId} [${(d.pair.similarity * 100).toFixed(1)}%]`);
            console.log(`      УДАЛ: "${d.pair.content_a.substring(0, 70)}..."`);
            console.log(`      ОСТА: "${d.pair.content_b.substring(0, 70)}..."`);
        }
        if (grouped.auto.length > 10) {
            console.log(`   ... и ещё ${grouped.auto.length - 10}`);
        }
    }

    if (grouped.duplicate.length > 0) {
        console.log(`\n🟡 AI-Judge дубликаты: ${grouped.duplicate.length}`);
        for (const d of grouped.duplicate.slice(0, 15)) {
            const removed = uniqueRemovals.has(d.removeId) ? '❌' : '⏭️';
            console.log(`   ${removed} #${d.removeId} → #${d.keepId} [${(d.pair.similarity * 100).toFixed(1)}%] ${d.reason}`);
            console.log(`      УДАЛ: "${truncate(d.removeId === d.pair.id_a ? d.pair.content_a : d.pair.content_b, 70)}"`);
            console.log(`      ОСТА: "${truncate(d.keepId === d.pair.id_a ? d.pair.content_a : d.pair.content_b, 70)}"`);
        }
        if (grouped.duplicate.length > 15) {
            console.log(`   ... и ещё ${grouped.duplicate.length - 15}`);
        }
    }

    if (grouped.update.length > 0) {
        console.log(`\n🔵 Обновления (старая версия → новая): ${grouped.update.length}`);
        for (const d of grouped.update.slice(0, 10)) {
            const removed = uniqueRemovals.has(d.removeId) ? '❌' : '⏭️';
            console.log(`   ${removed} #${d.removeId} → #${d.keepId} [${(d.pair.similarity * 100).toFixed(1)}%] ${d.reason}`);
        }
    }

    console.log('');
    console.log(`📊 Итого: ${uniqueRemovals.size} фактов к удалению из ${decisions.length} пар`);
}

function truncate(s: string, maxLen: number): string {
    return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

async function applyCleanup(removeIds: Set<number>, decisions: CleanupDecision[]) {
    const ids = Array.from(removeIds);

    // Помечаем как неактуальные поштучно
    let updated = 0;
    for (const id of ids) {
        await db.execute(sql`
            UPDATE facts 
            SET is_current = false, updated_at = NOW()
            WHERE id = ${id}
        `);
        updated++;
        if (updated % 20 === 0) {
            console.log(`   ✅ Помечено ${updated}/${ids.length} фактов`);
        }
    }
    console.log(`   ✅ Помечено ${updated}/${ids.length} фактов (завершено)`);

    // Создаём связи supersedes для прозрачности
    const decisionsByRemoveId = new Map<number, CleanupDecision>();
    for (const d of decisions) {
        if (removeIds.has(d.removeId) && !decisionsByRemoveId.has(d.removeId)) {
            decisionsByRemoveId.set(d.removeId, d);
        }
    }

    let relationsCreated = 0;
    for (const [removeId, decision] of decisionsByRemoveId) {
        try {
            await db.execute(sql`
                INSERT INTO fact_relations (source_fact_id, target_fact_id, relation_type)
                VALUES (${decision.keepId}, ${removeId}, 'supersedes')
                ON CONFLICT DO NOTHING
            `);
            relationsCreated++;
        } catch {
            // Игнорируем ошибки дублирования связей
        }
    }

    console.log(`   🔗 Создано ${relationsCreated} связей supersedes`);
}

// ── Запуск ───────────────────────────────────────────────────
main().catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
