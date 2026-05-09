/**
 * AI Task Scheduler — ИИ-управляемые периодические задачи
 * 
 * Позволяет AI создавать задачи по расписанию (cron).
 * При срабатывании — запускает полный пайплайн agentOrchestrator
 * (роли, скиллы, инструменты, контекст), доставляет результат через WebSocket / Telegram.
 *
 * Этап 2 OpenClaw: Consecutive Errors + Exponential Backoff
 *   - После ошибки: backoffUntil = now + min(5мин * 2^N, 6ч)
 *   - После 10 ошибок подряд: status = 'error_paused'
 *   - При успехе: consecutiveErrors = 0, backoffUntil = null
 */

import { db } from "./db";
import { aiScheduledTasks, cronExecutionLog, type InsertAiScheduledTask, type AiScheduledTask, type CronExecutionLog } from "@shared/schema";
import { eq, and, lte, or, isNull, sql, desc, ilike } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { WebSocket } from "ws";
import * as notificationService from "./notificationSettingsService";
import * as agentOrchestrator from "./agentOrchestrator";

// ============================================================================
// WebSocket — ссылка на клиентов (устанавливается из routes.ts)
// ============================================================================

let wsClients: Set<WebSocket> = new Set();

export function setWebSocketClients(clients: Set<WebSocket>) {
    wsClients = clients;
}

// ============================================================================
// CRUD операции
// ============================================================================

/**
 * Создать новую задачу по расписанию
 */
export async function createTask(data: {
    title: string;
    prompt: string;
    cronExpression: string;
    timezone?: string;
    maxRuns?: number;
    createdByAi?: boolean;
    metadata?: Record<string, any>;
}): Promise<AiScheduledTask> {
    // Валидация cron-выражения
    try {
        CronExpressionParser.parse(data.cronExpression, {
            tz: data.timezone || "Europe/Moscow",
        });
    } catch (error) {
        throw new Error(`Невалидное cron-выражение "${data.cronExpression}": ${error}`);
    }

    // Дедупликация — проверяем, нет ли активной задачи с таким же названием
    const existing = await db.select({ id: aiScheduledTasks.id, title: aiScheduledTasks.title })
        .from(aiScheduledTasks)
        .where(
            and(
                eq(aiScheduledTasks.status, "active"),
                ilike(aiScheduledTasks.title, data.title.trim())
            )
        )
        .limit(1);

    if (existing.length > 0) {
        throw new Error(`Активная задача с таким названием уже существует: #${existing[0].id} "${existing[0].title}". Используй update_scheduled_task для обновления или delete_scheduled_task для удаления.`);
    }

    // Рассчитываем nextRunAt
    const nextRunAt = calculateNextRun(data.cronExpression, data.timezone || "Europe/Moscow");

    const [task] = await db.insert(aiScheduledTasks).values({
        title: data.title,
        prompt: data.prompt,
        cronExpression: data.cronExpression,
        timezone: data.timezone || "Europe/Moscow",
        status: "active",
        nextRunAt,
        maxRuns: data.maxRuns || null,
        createdByAi: data.createdByAi ?? true,
        metadata: data.metadata || null,
    }).returning();

    console.log(`📅 [AiCron] Создана задача #${task.id}: "${task.title}" (${task.cronExpression}), след. запуск: ${nextRunAt?.toLocaleString('ru-RU')}`);
    return task;
}

/**
 * Получить список задач
 */
export async function listTasks(filter?: { status?: string }): Promise<AiScheduledTask[]> {
    if (filter?.status) {
        return db.select()
            .from(aiScheduledTasks)
            .where(eq(aiScheduledTasks.status, filter.status))
            .orderBy(desc(aiScheduledTasks.createdAt));
    }
    return db.select()
        .from(aiScheduledTasks)
        .orderBy(desc(aiScheduledTasks.createdAt));
}

/**
 * Получить задачу по ID
 */
export async function getTask(id: number): Promise<AiScheduledTask | null> {
    const [task] = await db.select()
        .from(aiScheduledTasks)
        .where(eq(aiScheduledTasks.id, id))
        .limit(1);
    return task || null;
}

/**
 * Отменить задачу
 */
export async function cancelTask(id: number): Promise<AiScheduledTask | null> {
    const [task] = await db.update(aiScheduledTasks)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(aiScheduledTasks.id, id))
        .returning();
    if (task) {
        console.log(`📅 [AiCron] Задача #${id} отменена`);
    }
    return task || null;
}

/**
 * Приостановить задачу
 */
export async function pauseTask(id: number): Promise<AiScheduledTask | null> {
    const [task] = await db.update(aiScheduledTasks)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(aiScheduledTasks.id, id))
        .returning();
    if (task) {
        console.log(`📅 [AiCron] Задача #${id} приостановлена`);
    }
    return task || null;
}

/**
 * Возобновить задачу
 */
export async function resumeTask(id: number): Promise<AiScheduledTask | null> {
    const task = await getTask(id);
    if (!task) return null;

    const nextRunAt = calculateNextRun(task.cronExpression, task.timezone);

    const [updated] = await db.update(aiScheduledTasks)
        .set({
            status: "active",
            nextRunAt,
            // Сброс backoff при возобновлении (Этап 2 OpenClaw)
            consecutiveErrors: 0,
            lastErrorAt: null,
            backoffUntil: null,
            updatedAt: new Date(),
        })
        .where(eq(aiScheduledTasks.id, id))
        .returning();

    if (updated) {
        console.log(`📅 [AiCron] Задача #${id} возобновлена (backoff сброшен), след. запуск: ${nextRunAt?.toLocaleString('ru-RU')}`);
    }
    return updated || null;
}

/**
 * Удалить задачу из БД
 */
export async function deleteTask(id: number): Promise<boolean> {
    // Удаляем также журнал выполнений задачи
    await db.delete(cronExecutionLog).where(eq(cronExecutionLog.taskId, id));
    await db.delete(aiScheduledTasks).where(eq(aiScheduledTasks.id, id));
    console.log(`📅 [AiCron] Задача #${id} удалена вместе с журналом`);
    return true;
}

/**
 * Обновить поля задачи (title, prompt, cronExpression, maxRuns)
 */
export async function updateTask(id: number, updates: {
    title?: string;
    prompt?: string;
    cronExpression?: string;
    maxRuns?: number | null;
}): Promise<AiScheduledTask | null> {
    const task = await getTask(id);
    if (!task) return null;

    const setFields: Record<string, any> = { updatedAt: new Date() };

    if (updates.title !== undefined) setFields.title = updates.title;
    if (updates.prompt !== undefined) setFields.prompt = updates.prompt;
    if (updates.maxRuns !== undefined) setFields.maxRuns = updates.maxRuns;

    // Если обновляется cron — пересчитываем nextRunAt
    if (updates.cronExpression !== undefined) {
        try {
            CronExpressionParser.parse(updates.cronExpression, { tz: task.timezone });
        } catch (error) {
            throw new Error(`Невалидное cron-выражение "${updates.cronExpression}": ${error}`);
        }
        setFields.cronExpression = updates.cronExpression;
        setFields.nextRunAt = calculateNextRun(updates.cronExpression, task.timezone);
    }

    const [updated] = await db.update(aiScheduledTasks)
        .set(setFields)
        .where(eq(aiScheduledTasks.id, id))
        .returning();

    if (updated) {
        console.log(`📅 [AiCron] Задача #${id} обновлена: ${Object.keys(updates).join(', ')}`);
    }
    return updated || null;
}

/**
 * Получить журнал выполнений задачи
 */
export async function getExecutionLogs(taskId: number, limit: number = 20): Promise<CronExecutionLog[]> {
    return db.select()
        .from(cronExecutionLog)
        .where(eq(cronExecutionLog.taskId, taskId))
        .orderBy(desc(cronExecutionLog.executedAt))
        .limit(limit);
}

/**
 * Получить последний лог для задачи
 */
export async function getLastExecutionLog(taskId: number): Promise<CronExecutionLog | null> {
    const [log] = await db.select()
        .from(cronExecutionLog)
        .where(eq(cronExecutionLog.taskId, taskId))
        .orderBy(desc(cronExecutionLog.executedAt))
        .limit(1);
    return log || null;
}

// ============================================================================
// Cron-движок
// ============================================================================

/**
 * Рассчитать следующий запуск по cron-выражению
 */
function calculateNextRun(cronExpression: string, timezone: string): Date | null {
    try {
        const interval = CronExpressionParser.parse(cronExpression, {
            tz: timezone,
            currentDate: new Date(),
        });
        return interval.next().toDate();
    } catch (error) {
        console.error(`📅 [AiCron] Ошибка расчёта nextRun для "${cronExpression}":`, error);
        return null;
    }
}

// ============================================================================
// Backoff helpers (Этап 2 OpenClaw)
// ============================================================================

const BACKOFF_BASE_MS = 5 * 60 * 1000;        // 5 минут
const BACKOFF_MAX_MS  = 6 * 60 * 60 * 1000;   // 6 часов
const AUTO_PAUSE_THRESHOLD = 10;               // ошибок подряд → error_paused

/**
 * Рассчитать время следующей попытки: min(baseDelay * 2^N, maxDelay)
 */
function calcBackoffUntil(consecutiveErrors: number): Date {
    const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveErrors), BACKOFF_MAX_MS);
    return new Date(Date.now() + delayMs);
}

/**
 * Зафиксировать успешное выполнение: сброс счётчика ошибок
 */
async function recordTaskSuccess(taskId: number): Promise<void> {
    await db.update(aiScheduledTasks)
        .set({
            consecutiveErrors: 0,
            lastErrorAt: null,
            backoffUntil: null,
            updatedAt: new Date(),
        })
        .where(eq(aiScheduledTasks.id, taskId));
}

/**
 * Зафиксировать ошибку выполнения: инкремент счётчика, расчёт backoff, авто-пауза
 */
async function recordTaskError(task: AiScheduledTask, errorMessage: string): Promise<void> {
    const newCount = (task.consecutiveErrors ?? 0) + 1;
    const now = new Date();

    if (newCount >= AUTO_PAUSE_THRESHOLD) {
        // Авто-пауза после AUTO_PAUSE_THRESHOLD ошибок
        await db.update(aiScheduledTasks)
            .set({
                status: "error_paused",
                consecutiveErrors: newCount,
                lastErrorAt: now,
                backoffUntil: null,
                updatedAt: now,
            })
            .where(eq(aiScheduledTasks.id, task.id));

        console.warn(`⚠️ [AiCron] Задача #${task.id} "${task.title}" переведена в error_paused (${newCount} ошибок подряд)`);

        // Уведомление в Telegram (fire-and-forget)
        notificationService.isTelegramEnabled().then(enabled => {
            if (enabled) {
                const text = `⚠️ <b>Cron задача приостановлена</b>\n📌 "${escapeHtml(task.title)}" (#${task.id})\n\n` +
                    `Задача упала <b>${newCount} раз подряд</b> и переведена в паузу.\n` +
                    `Последняя ошибка: <code>${escapeHtml(errorMessage.substring(0, 200))}</code>`;
                notificationService.sendTelegramMessage(text).catch(() => {});
            }
        }).catch(() => {});
        return;
    }

    const backoffUntil = calcBackoffUntil(newCount - 1); // 0-based для 1-й ошибки = 5мин
    await db.update(aiScheduledTasks)
        .set({
            consecutiveErrors: newCount,
            lastErrorAt: now,
            backoffUntil,
            updatedAt: now,
        })
        .where(eq(aiScheduledTasks.id, task.id));

    console.warn(`📅 [AiCron] Задача #${task.id} пропущена (backoff после ${newCount} ошибок подряд, следующая попытка: ${backoffUntil.toLocaleString('ru-RU')})`);
}

/**
 * Найти и выполнить просроченные задачи
 * Вызывается из proactiveScheduler.runProactiveCheck()
 */
export async function checkAndExecuteOverdueTasks(): Promise<number> {
    const now = new Date();

    // Находим активные задачи, у которых nextRunAt <= now
    // Пропускаем задачи в backoff: backoffUntil IS NULL OR backoffUntil <= now
    const overdueTasks = await db.select()
        .from(aiScheduledTasks)
        .where(
            and(
                eq(aiScheduledTasks.status, "active"),
                lte(aiScheduledTasks.nextRunAt, now),
                or(
                    isNull(aiScheduledTasks.backoffUntil),
                    lte(aiScheduledTasks.backoffUntil, now)
                )
            )
        );

    if (overdueTasks.length === 0) return 0;

    console.log(`📅 [AiCron] Найдено ${overdueTasks.length} просроченных задач`);

    let executedCount = 0;
    for (const task of overdueTasks) {
        try {
            const success = await executeTask(task);
            await advanceTask(task, success); // runCount++ только при успехе
            if (success) executedCount++;
        } catch (error) {
            console.error(`📅 [AiCron] Критическая ошибка задачи #${task.id}:`, error);
        }
    }

    return executedCount;
}

/**
 * Принудительный запуск задачи (из UI)
 */
export async function forceRunTask(id: number): Promise<boolean> {
    const task = await getTask(id);
    if (!task) return false;

    await executeTask(task);

    // Обновляем runCount и lastRunAt, но не nextRunAt (чтобы не сбить расписание)
    await db.update(aiScheduledTasks)
        .set({
            runCount: sql`${aiScheduledTasks.runCount} + 1`,
            lastRunAt: new Date(),
            updatedAt: new Date(),
        })
        .where(eq(aiScheduledTasks.id, id));

    return true;
}

/**
 * Выполнить задачу — запустить полный пайплайн agentOrchestrator и сохранить лог
 * @returns true при успехе, false при ошибке
 */
async function executeTask(task: AiScheduledTask): Promise<boolean> {
    console.log(`📅 [AiCron] Выполняю задачу #${task.id}: "${task.title}" через оркестратор`);

    const startTime = Date.now();

    try {
        // Полный пайплайн: роли, скиллы, инструменты, контекст, факты
        const sessionId = `cron-task-${task.id}`;
        const cronPrompt = `[Cron-задача "${task.title}"]\n\n${task.prompt}`;

        const result = await agentOrchestrator.processMessage(
            cronPrompt,
            sessionId,
        );

        const durationMs = Date.now() - startTime;
        const responseContent = result.response?.trim() || "Не удалось получить ответ";

        // Сохраняем лог выполнения
        await db.insert(cronExecutionLog).values({
            taskId: task.id,
            status: "success",
            response: responseContent,
            agentUsed: result.agentUsed || null,
            agentName: result.agentName || null,
            tokensUsed: result.tokensUsed || 0,
            toolCalls: result.toolCalls || null,
            durationMs,
            executedAt: new Date(),
        });

        // Сброс счётчика ошибок при успехе (Этап 2 OpenClaw)
        if ((task.consecutiveErrors ?? 0) > 0) {
            await recordTaskSuccess(task.id);
            console.log(`📅 [AiCron] Задача #${task.id}: счётчик ошибок сброшен (было: ${task.consecutiveErrors})`);
        }

        // Доставляем через WebSocket
        const delivered = sendCronResultToWebSocket(task, responseContent, durationMs, result.agentName);

        // Fallback на Telegram
        if (!delivered && await notificationService.isTelegramEnabled()) {
            try {
                const text = `📅 <b>Cron: ${escapeHtml(task.title)}</b>\n🤖 ${escapeHtml(result.agentName || 'AI')}\n\n${escapeHtml(responseContent)}`;
                await notificationService.sendTelegramMessage(text);
                console.log(`📱 [AiCron] Telegram fallback для задачи #${task.id}`);
            } catch (tgError) {
                console.error(`📱 [AiCron] Telegram fallback ошибка:`, tgError);
            }
        }

        console.log(`📅 [AiCron] Задача #${task.id} выполнена за ${durationMs}мс (агент: ${result.agentName}, токены: ${result.tokensUsed}, delivered: ${delivered})`);
        return true;
    } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Сохраняем лог ошибки
        await db.insert(cronExecutionLog).values({
            taskId: task.id,
            status: errorMessage.includes('timeout') ? "timeout" : "error",
            error: errorMessage,
            durationMs,
            executedAt: new Date(),
        });

        // Обновляем backoff (Этап 2 OpenClaw)
        try {
            await recordTaskError(task, errorMessage);
        } catch (backoffError) {
            console.error(`📅 [AiCron] Не удалось записать backoff для задачи #${task.id}:`, backoffError);
        }

        console.error(`📅 [AiCron] Ошибка выполнения задачи #${task.id} (${durationMs}мс):`, error);
        return false;
    }
}

/**
 * Продвинуть задачу — рассчитать следующий запуск, инкрементировать счётчик
 * @param countAsRun — увеличивать runCount (false при ошибке, чтобы не исчерпать maxRuns)
 */
async function advanceTask(task: AiScheduledTask, countAsRun: boolean = true): Promise<void> {
    const newRunCount = countAsRun ? task.runCount + 1 : task.runCount;

    // Проверяем лимит запусков (только при успешном выполнении)
    if (countAsRun && task.maxRuns && newRunCount >= task.maxRuns) {
        await db.update(aiScheduledTasks)
            .set({
                status: "cancelled",
                runCount: newRunCount,
                lastRunAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(aiScheduledTasks.id, task.id));
        console.log(`📅 [AiCron] Задача #${task.id} завершена (достигнут лимит ${task.maxRuns} запусков)`);
        return;
    }

    const nextRunAt = calculateNextRun(task.cronExpression, task.timezone);

    await db.update(aiScheduledTasks)
        .set({
            runCount: newRunCount,
            lastRunAt: new Date(),
            nextRunAt,
            updatedAt: new Date(),
        })
        .where(eq(aiScheduledTasks.id, task.id));
}

// ============================================================================
// Доставка результатов
// ============================================================================

/**
 * Отправить результат cron-задачи через WebSocket
 */
function sendCronResultToWebSocket(task: AiScheduledTask, content: string, durationMs?: number, agentName?: string): boolean {
    if (wsClients.size === 0) return false;

    const payload = JSON.stringify({
        type: 'ai_cron_result',
        data: {
            taskId: task.id,
            taskTitle: task.title,
            content,
            agentName: agentName || null,
            durationMs: durationMs || null,
            executedAt: new Date().toISOString(),
        },
    });

    let sent = false;
    for (const client of Array.from(wsClients)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
            sent = true;
        }
    }

    return sent;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}


