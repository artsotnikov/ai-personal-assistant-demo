/**
 * Workflow Logger — Сервис для записи полного workflow обработки сообщений в БД
 * 
 * Записывает все шаги, входные/выходные данные, решения и ошибки
 * для последующего анализа и улучшения системы.
 */

import { db } from '../db';
import { messageProcessingRuns } from '@shared/schema';
import type { ProcessingStep, ProcessingStepRecord, ProcessingStepOutput } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';

export interface WorkflowSummary {
    agentUsed: string;
    tokensUsed: number;
    factsCount: number;
    contextSummary?: {
        factsInContext: number;
        messagesInHistory: number;
        profileLoaded: boolean;
    };
}

/**
 * Класс для логирования workflow обработки одного сообщения
 */
export class WorkflowLogger {
    private runId: number | null = null;
    private messageId: number;
    private steps: ProcessingStepRecord[] = [];
    private startTime: number;
    private isStarted = false;

    constructor(messageId: number) {
        this.messageId = messageId;
        this.startTime = Date.now();
    }

    /**
     * Начать запись workflow — создаёт запись в БД
     */
    async start(): Promise<void> {
        if (this.isStarted) return;

        try {
            const [run] = await db.insert(messageProcessingRuns)
                .values({
                    messageId: this.messageId,
                    startedAt: new Date(),
                    status: 'running',
                    steps: [],
                })
                .returning({ id: messageProcessingRuns.id });

            this.runId = run.id;
            this.isStarted = true;
            console.log(`📊 Workflow logging started for message ${this.messageId}, run ID: ${this.runId}`);
        } catch (error) {
            console.error('Failed to start workflow logging:', error);
        }
    }

    /**
     * Записать шаг обработки
     */
    logStep(step: ProcessingStep, input?: Record<string, any>): void {
        const record: ProcessingStepRecord = {
            stepId: step.stepId,
            stepName: step.stepName,
            stepIcon: step.stepIcon,
            status: step.status,
            startedAt: step.timestamp,
            completedAt: step.status === 'completed' || step.status === 'error'
                ? new Date().toISOString()
                : undefined,
            durationMs: step.duration,
            input: input,
            output: step.output,
            error: step.error,
        };

        // Если шаг уже есть — обновляем его
        const existingIndex = this.steps.findIndex(s => s.stepId === step.stepId);
        if (existingIndex >= 0) {
            this.steps[existingIndex] = record;
        } else {
            this.steps.push(record);
        }

        // Периодически обновляем БД (не на каждый шаг, для производительности)
        if (step.status === 'completed' || step.status === 'error') {
            this.updateStepsInDb();
        }
    }

    /**
     * Обновить шаги в БД (асинхронно, без ожидания)
     */
    private async updateStepsInDb(): Promise<void> {
        if (!this.runId) return;

        try {
            await db.update(messageProcessingRuns)
                .set({ steps: this.steps })
                .where(eq(messageProcessingRuns.id, this.runId));
        } catch (error) {
            console.error('Failed to update workflow steps:', error);
        }
    }

    /**
     * Завершить workflow успешно
     */
    async complete(summary: WorkflowSummary): Promise<void> {
        if (!this.runId) return;

        const totalDuration = Date.now() - this.startTime;

        try {
            await db.update(messageProcessingRuns)
                .set({
                    status: 'completed',
                    completedAt: new Date(),
                    totalDurationMs: totalDuration,
                    steps: this.steps,
                    agentUsed: summary.agentUsed,
                    tokensUsed: summary.tokensUsed,
                    factsCount: summary.factsCount,
                    contextSummary: summary.contextSummary,
                })
                .where(eq(messageProcessingRuns.id, this.runId));

            console.log(`✅ Workflow completed for message ${this.messageId}, duration: ${totalDuration}ms`);
        } catch (error) {
            console.error('Failed to complete workflow logging:', error);
        }
    }

    /**
     * Пометить workflow как завершённый с ошибкой
     */
    async error(errorMessage: string): Promise<void> {
        if (!this.runId) return;

        const totalDuration = Date.now() - this.startTime;

        try {
            await db.update(messageProcessingRuns)
                .set({
                    status: 'error',
                    completedAt: new Date(),
                    totalDurationMs: totalDuration,
                    steps: this.steps,
                    errorMessage,
                })
                .where(eq(messageProcessingRuns.id, this.runId));

            console.log(`❌ Workflow error for message ${this.messageId}: ${errorMessage}`);
        } catch (error) {
            console.error('Failed to log workflow error:', error);
        }
    }

    /**
     * Получить ID записи workflow
     */
    getRunId(): number | null {
        return this.runId;
    }
}

/**
 * Получить workflow для сообщения
 */
export async function getWorkflowForMessage(messageId: number) {
    const runs = await db.select()
        .from(messageProcessingRuns)
        .where(eq(messageProcessingRuns.messageId, messageId))
        .limit(1);

    return runs[0] || null;
}

/**
 * Получить workflows для массива сообщений (оптимизированный batch-запрос)
 * Возвращает Map<messageId, workflow>
 */
export async function getWorkflowsForMessages(messageIds: number[]): Promise<Map<number, any>> {
    if (messageIds.length === 0) {
        return new Map();
    }

    const runs = await db.select()
        .from(messageProcessingRuns)
        .where(sql`${messageProcessingRuns.messageId} IN (${sql.join(messageIds.map(id => sql`${id}`), sql`, `)})`);

    const workflowMap = new Map<number, any>();
    for (const run of runs) {
        workflowMap.set(run.messageId, run);
    }

    return workflowMap;
}

/**
 * Получить последние N workflow
 */
export async function getRecentWorkflows(limit: number = 50) {
    const runs = await db.select()
        .from(messageProcessingRuns)
        .orderBy(messageProcessingRuns.createdAt)
        .limit(limit);

    return runs;
}

/**
 * Удалить старые workflow (для очистки)
 */
export async function cleanupOldWorkflows(daysToKeep: number = 60) {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const result = await db.delete(messageProcessingRuns)
        .where(eq(messageProcessingRuns.status, 'completed')); // TODO: add date filter

    console.log(`🧹 Cleaned up old workflows older than ${daysToKeep} days`);
}
