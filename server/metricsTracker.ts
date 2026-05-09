/**
 * Metrics Tracker — Снэпшоты бизнес-метрик
 * 
 * Отвечает за:
 * - Сохранение пакетов метрик за период
 * - Автоматический расчёт changes (дельта с предыдущим периодом)
 * - AI-парсинг метрик из текста
 * - Получение истории и динамики
 */

import { db } from "./db";
import { metricSnapshots, type InsertMetricSnapshot, type MetricSnapshot } from "@shared/schema";
import { desc, eq, and, sql } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ============================================================================
// Типы
// ============================================================================

export interface ParsedMetricsData {
    period: string;          // "2026-01", "2026-01-15"
    periodType: string;      // "monthly", "daily", "instant"
    metrics: Record<string, number>;
}

export interface SaveMetricsResult {
    snapshotId: number;
    period: string;
    metricsCount: number;
    changes: Record<string, { prev: number; curr: number; delta: number; pct: number }> | null;
}

// ============================================================================
// AI: Парсинг метрик из текста
// ============================================================================

export async function parseMetricsData(text: string): Promise<ParsedMetricsData | null> {
    try {
        const aiConfig = await getAIClientForTask('data_ingestion');
        const result = await callWithFallback(
            { ...aiConfig, temperature: 0.1, maxTokens: 400 },
            [
                {
                    role: 'system',
                    content: `Извлеки из текста бизнес-метрики. Верни JSON:
{
  "period": "2026-01",
  "periodType": "monthly",
  "metrics": {
    "revenue": 294000,
    "expenses": 81000,
    "mrr": 196000,
    "clients": 196,
    "ebitda": 195000
  }
}

Правила:
- period: формат "YYYY-MM" для месячных, "YYYY-MM-DD" для дневных
- periodType: "monthly" | "daily" | "instant"
- metrics: ключи на английском (revenue, expenses, mrr, clients, ebitda, profit, arpu и т.д.)
- Значения — только числа (без валют, знаков %, пробелов)
- Если период не указан явно, используй текущий месяц
- Если метрики не найдены, верни null`
                },
                { role: 'user', content: text }
            ],
        );

        const raw = result.content || '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        if (cleaned === 'null' || !cleaned) return null;

        const parsed = JSON.parse(cleaned);
        if (!parsed.metrics || Object.keys(parsed.metrics).length === 0) return null;

        return {
            period: parsed.period || new Date().toISOString().substring(0, 7),
            periodType: parsed.periodType || 'monthly',
            metrics: parsed.metrics,
        };
    } catch (error) {
        console.error('[MetricsTracker] Ошибка AI-парсинга:', error);
        return null;
    }
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Сохранить снэпшот метрик с автоматическим расчётом дельт
 */
export async function saveMetricSnapshot(
    data: ParsedMetricsData,
    rawContent: string,
    sourceMessageId?: number,
): Promise<SaveMetricsResult> {
    console.log(`[MetricsTracker] 📊 Сохранение метрик за ${data.period} (${data.periodType})`);

    // 1. Найти предыдущий снэпшот того же periodType
    const [prevSnapshot] = await db.select()
        .from(metricSnapshots)
        .where(eq(metricSnapshots.periodType, data.periodType))
        .orderBy(desc(metricSnapshots.createdAt))
        .limit(1);

    // 2. Рассчитать changes
    let changes: Record<string, { prev: number; curr: number; delta: number; pct: number }> | null = null;

    if (prevSnapshot && prevSnapshot.metrics) {
        changes = {};
        const prevMetrics = prevSnapshot.metrics as Record<string, number>;

        for (const [key, curr] of Object.entries(data.metrics)) {
            const prev = prevMetrics[key];
            if (typeof prev === 'number' && typeof curr === 'number') {
                const delta = curr - prev;
                const pct = prev !== 0 ? Math.round((delta / prev) * 10000) / 100 : 0;
                changes[key] = { prev, curr, delta, pct };
            }
        }

        if (Object.keys(changes).length === 0) changes = null;
    }

    // 3. Генерируем summary
    let summary = `Метрики за ${data.period}: ${Object.entries(data.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    if (changes) {
        const changesStr = Object.entries(changes)
            .map(([k, c]) => `${k}: ${c.pct > 0 ? '+' : ''}${c.pct}%`)
            .join(', ');
        summary += `. Изменения: ${changesStr}`;
    }

    // 4. Сохраняем
    const insertData: InsertMetricSnapshot = {
        period: data.period,
        periodType: data.periodType,
        metrics: data.metrics,
        rawContent: rawContent || null,
        changes: changes,
        summary,
        sourceMessageId: sourceMessageId || null,
    };

    const [saved] = await db.insert(metricSnapshots).values(insertData).returning();

    console.log(`[MetricsTracker] ✅ Снэпшот #${saved.id} сохранён (${Object.keys(data.metrics).length} метрик)`);

    return {
        snapshotId: saved.id,
        period: data.period,
        metricsCount: Object.keys(data.metrics).length,
        changes,
    };
}

/**
 * Последний снэпшот
 */
export async function getLatestSnapshot(): Promise<MetricSnapshot | null> {
    const [snapshot] = await db.select()
        .from(metricSnapshots)
        .orderBy(desc(metricSnapshots.createdAt))
        .limit(1);
    return snapshot || null;
}

/**
 * Снэпшот за конкретный период
 */
export async function getSnapshotByPeriod(period: string): Promise<MetricSnapshot | null> {
    const [snapshot] = await db.select()
        .from(metricSnapshots)
        .where(eq(metricSnapshots.period, period))
        .orderBy(desc(metricSnapshots.createdAt))
        .limit(1);
    return snapshot || null;
}

/**
 * История снэпшотов
 */
export async function getMetricHistory(limit: number = 12): Promise<MetricSnapshot[]> {
    return db.select()
        .from(metricSnapshots)
        .orderBy(desc(metricSnapshots.createdAt))
        .limit(limit);
}

/**
 * Динамика конкретной метрики
 */
export async function getMetricTrend(metricKey: string, limit: number = 12): Promise<Array<{
    period: string;
    value: number;
    createdAt: Date;
}>> {
    const snapshots = await getMetricHistory(limit);

    return snapshots
        .filter(s => {
            const metrics = s.metrics as Record<string, number>;
            return typeof metrics[metricKey] === 'number';
        })
        .map(s => ({
            period: s.period,
            value: (s.metrics as Record<string, number>)[metricKey],
            createdAt: s.createdAt,
        }))
        .reverse(); // Хронологический порядок
}
