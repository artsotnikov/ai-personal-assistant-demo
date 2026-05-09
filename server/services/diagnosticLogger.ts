/**
 * Diagnostic Logger — Запись системных диагностических событий в БД
 * 
 * Используется для логирования инициализации сервисов, сетевых ошибок,
 * OAuth-событий и другой системной информации, которую нужно анализировать
 * удалённо (из dev-среды для диагностики production).
 * 
 * Fire-and-forget: ошибки записи не ломают основной flow.
 */

import { pool } from '../db';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
    service: string;
    event: string;
    level: DiagnosticLevel;
    message: string;
    details?: Record<string, unknown>;
}

const environment = process.env.NODE_ENV || 'development';

/**
 * Записать диагностическое событие в БД (fire-and-forget)
 */
export function logDiagnostic(
    service: string,
    event: string,
    level: DiagnosticLevel,
    message: string,
    details?: Record<string, unknown>,
): void {
    // Fire-and-forget — не блокируем вызывающий код
    pool.query(
        `INSERT INTO system_diagnostics (service, event, level, message, details, environment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [service, event, level, message, details ? JSON.stringify(details) : null, environment],
    ).catch(err => {
        // Тихо логируем в консоль — если таблица ещё не создана, не падаем
        console.error(`[DiagnosticLogger] ⚠️ Write failed: ${err?.message || err}`);
    });
}

/**
 * Shortcut: логировать info-событие
 */
export function diagInfo(service: string, event: string, message: string, details?: Record<string, unknown>): void {
    logDiagnostic(service, event, 'info', message, details);
}

/**
 * Shortcut: логировать warn-событие
 */
export function diagWarn(service: string, event: string, message: string, details?: Record<string, unknown>): void {
    logDiagnostic(service, event, 'warn', message, details);
}

/**
 * Shortcut: логировать error-событие
 */
export function diagError(service: string, event: string, message: string, details?: Record<string, unknown>): void {
    logDiagnostic(service, event, 'error', message, details);
}

/**
 * Прочитать последние N диагностических записей (для скрипта read-diagnostics)
 */
export async function readDiagnostics(options?: {
    service?: string;
    level?: DiagnosticLevel;
    limit?: number;
    since?: Date;
}): Promise<any[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (options?.service) {
        conditions.push(`service = $${paramIdx++}`);
        params.push(options.service);
    }
    if (options?.level) {
        conditions.push(`level = $${paramIdx++}`);
        params.push(options.level);
    }
    if (options?.since) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(options.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit || 50;

    const result = await pool.query(
        `SELECT * FROM system_diagnostics ${where} ORDER BY created_at DESC LIMIT ${limit}`,
        params,
    );

    return result.rows;
}
