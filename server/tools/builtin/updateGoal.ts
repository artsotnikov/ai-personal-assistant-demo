/**
 * Tool: update_goal — Обновить любые поля цели
 * 
 * Прямой SQL через drizzle к таблице goals.
 * Поддерживает обновление: progress, status, notes, title, description,
 * category, priority, targetDate.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals } from '@shared/schema';
import { eq, and, not } from 'drizzle-orm';

interface UpdateGoalInput {
    goalId: number;
    progress?: number;
    status?: string;
    notes?: string;
    title?: string;
    description?: string;
    category?: 'business' | 'personal' | 'financial' | 'health' | 'career' | 'lifestyle';
    priority?: 'focus' | 'high' | 'medium' | 'low' | 'someday';
    targetDate?: string;
    resumeDate?: string;
    blockedReason?: string;
    blockedByGoalId?: number;
}

export const updateGoalTool: ToolDefinition<UpdateGoalInput> = {
    name: 'update_goal',
    description: `Обновить любые поля цели пользователя.

⚠️ ВАЖНО — РАЗЛИЧИЕ МЕЖДУ СТАТУСОМ И ПРИОРИТЕТОМ:
- STATUS (жизненный цикл): active → paused/deferred → completed/abandoned
  • active    — в работе, есть следующий шаг
  • paused    — приостановлена (есть блокер). Укажи blockedReason!
  • deferred  — сознательно отложена до конкретной даты. Укажи resumeDate!
  • completed — цель достигнута
  • abandoned — цель отменена навсегда
- PRIORITY (важность): focus > high > medium > low > someday
  • someday — это ПРИОРИТЕТ (хочу когда-нибудь), НЕ статус!

Когда пользователь говорит "отложи цель" → используй status: "deferred" + resumeDate
Когда говорит "поставь на паузу" → используй status: "paused" + blockedReason
Когда говорит "это не срочно" → используй priority: "someday" (status остаётся active)

Поддерживаемые поля:
- progress (0-100), status, priority, title, description
- category: business/personal/financial/health/career/lifestyle
- targetDate (дедлайн ISO 8601)
- resumeDate (дата возврата из deferred, ISO 8601)
- blockedReason (причина паузы)
- blockedByGoalId (ID цели-блокера)
- notes (дописывается к описанию)

При изменении priority на 'focus' — проверяется лимит (макс 3 focus-целей).`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели для обновления (числовой ID из БД, который отображается как [ID: X] в списке целей. НЕ порядковый номер!)',
            },
            progress: {
                type: 'number',
                description: 'Новый прогресс (0-100)',
            },
            status: {
                type: 'string',
                description: 'Новый статус цели. active=в работе, paused=блокер, deferred=отложена до даты, completed=достигнута, abandoned=отменена',
                enum: ['active', 'completed', 'abandoned', 'paused', 'deferred'],
            },
            notes: {
                type: 'string',
                description: 'Заметка о прогрессе (добавляется к описанию)',
            },
            title: {
                type: 'string',
                description: 'Новое название цели',
            },
            description: {
                type: 'string',
                description: 'Новое описание цели (перезаписывает полностью)',
            },
            category: {
                type: 'string',
                enum: ['business', 'personal', 'financial', 'health', 'career', 'lifestyle'],
                description: 'Категория цели',
            },
            priority: {
                type: 'string',
                enum: ['focus', 'high', 'medium', 'low', 'someday'],
                description: 'Приоритет (focus — макс 3 активных!). someday = низкий приоритет, НЕ статус паузы',
            },
            targetDate: {
                type: 'string',
                description: 'Дедлайн в формате ISO 8601',
            },
            resumeDate: {
                type: 'string',
                description: 'Дата автоматического возврата в active (для status=deferred). ISO 8601',
            },
            blockedReason: {
                type: 'string',
                description: 'Причина приостановки (для status=paused). Например: "Жду выход на доход 300к"',
            },
            blockedByGoalId: {
                type: 'number',
                description: 'ID цели-блокера. Когда блокер будет завершён, эта цель автоматически вернётся в active',
            },
        },
        required: ['goalId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Проверяем существование цели
            const existing = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);

            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `Цель с ID ${input.goalId} не найдена.`,
                };
            }

            const goal = existing[0];
            const updates: Record<string, any> = { updatedAt: new Date() };

            // ── Собираем diff: before → after для каждого изменяемого поля ──
            const diffs: Array<{ field: string; label: string; before: any; after: any }> = [];

            if (input.progress !== undefined) {
                updates.progress = Math.max(0, Math.min(100, input.progress));
                diffs.push({ field: 'progress', label: 'Прогресс', before: `${goal.progress}%`, after: `${updates.progress}%` });
            }

            if (input.status) {
                updates.status = input.status;
                diffs.push({ field: 'status', label: 'Статус', before: goal.status, after: input.status });
            }

            if (input.title) {
                updates.title = input.title;
                diffs.push({ field: 'title', label: 'Название', before: goal.title, after: input.title });
            }

            if (input.description !== undefined) {
                updates.description = input.description;
                diffs.push({ field: 'description', label: 'Описание', before: '(старое)', after: '(обновлено)' });
            }

            if (input.category) {
                updates.category = input.category;
                diffs.push({ field: 'category', label: 'Категория', before: goal.category, after: input.category });
            }

            if (input.priority) {
                // Проверка лимита focus-целей
                if (input.priority === 'focus' && goal.priority !== 'focus') {
                    const focusGoals = await db.select().from(goals)
                        .where(and(
                            eq(goals.priority, 'focus'),
                            eq(goals.status, 'active'),
                            not(eq(goals.id, input.goalId)),
                        ));
                    if (focusGoals.length >= 3) {
                        return {
                            success: false,
                            error: 'Достигнут лимит focus-целей (макс 3)',
                            displayText: `⚠️ Уже есть 3 цели в фокусе: ${focusGoals.map(g => `"${g.title}"`).join(', ')}. Сначала снизь приоритет одной из них.`,
                        };
                    }
                }
                updates.priority = input.priority;
                diffs.push({ field: 'priority', label: 'Приоритет', before: goal.priority, after: input.priority });

                // ── Адаптивный review_frequency при смене приоритета ──
                const reviewMap: Record<string, string> = {
                    focus: 'daily', high: 'weekly', medium: 'weekly', low: 'monthly', someday: 'monthly',
                };
                const newReviewFreq = reviewMap[input.priority];
                if (newReviewFreq && newReviewFreq !== goal.reviewFrequency) {
                    updates.reviewFrequency = newReviewFreq;
                    diffs.push({ field: 'reviewFrequency', label: 'Частота ревью', before: goal.reviewFrequency, after: newReviewFreq });
                }
            }

            if (input.targetDate) {
                updates.deadline = new Date(input.targetDate);
                diffs.push({ field: 'deadline', label: 'Дедлайн', before: goal.deadline ? goal.deadline.toLocaleDateString('ru-RU') : 'не установлен', after: new Date(input.targetDate).toLocaleDateString('ru-RU') });
            }

            // ── Новые поля жизненного цикла ──
            if (input.resumeDate) {
                updates.resumeDate = new Date(input.resumeDate);
                diffs.push({ field: 'resumeDate', label: 'Дата возврата', before: 'не установлена', after: new Date(input.resumeDate).toLocaleDateString('ru-RU') });
            }

            if (input.blockedReason !== undefined) {
                updates.blockedReason = input.blockedReason || null;
                diffs.push({ field: 'blockedReason', label: 'Причина блокировки', before: goal.blockedReason || 'нет', after: input.blockedReason || 'снята' });
            }

            if (input.blockedByGoalId !== undefined) {
                updates.blockedByGoalId = input.blockedByGoalId || null;
                diffs.push({ field: 'blockedByGoalId', label: 'Заблокировано целью', before: goal.blockedByGoalId ? `#${goal.blockedByGoalId}` : 'нет', after: input.blockedByGoalId ? `#${input.blockedByGoalId}` : 'снято' });
            }

            // ── Автоматическая очистка при переходе из paused/deferred → active ──
            if (input.status === 'active' && (goal.status === 'paused' || goal.status === 'deferred')) {
                if (!input.blockedReason) updates.blockedReason = null;
                if (!input.blockedByGoalId) updates.blockedByGoalId = null;
                if (!input.resumeDate) updates.resumeDate = null;
            }

            if (input.notes) {
                const currentDesc = goal.description || '';
                const timestamp = new Date().toLocaleDateString('ru-RU');
                updates.description = currentDesc
                    ? `${currentDesc}\n\n[${timestamp}] ${input.notes}`
                    : `[${timestamp}] ${input.notes}`;
                diffs.push({ field: 'notes', label: 'Заметка', before: '', after: `[${timestamp}] ${input.notes}` });
            }

            // Если прогресс 100 — автоматически ставим completed
            if (updates.progress === 100 && !input.status) {
                updates.status = 'completed';
                diffs.push({ field: 'status', label: 'Статус (авто)', before: goal.status, after: 'completed' });
            }

            // ── Выполняем UPDATE ──
            await db.update(goals).set(updates).where(eq(goals.id, input.goalId));

            // ── ВЕРИФИКАЦИЯ: перечитываем цель из БД, чтобы подтвердить запись ──
            const verified = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);

            if (verified.length === 0) {
                return {
                    success: false,
                    error: `Верификация не удалась: цель ID ${input.goalId} не найдена после UPDATE`,
                    displayText: `❌ Ошибка верификации: цель исчезла из БД после обновления.`,
                };
            }

            const verifiedGoal = verified[0];

            // ── Проверяем, что все изменения действительно записались ──
            const verificationErrors: string[] = [];
            for (const diff of diffs) {
                if (diff.field === 'description' || diff.field === 'notes') continue; // слишком длинные для сравнения
                if (diff.field === 'deadline') continue; // формат может отличаться

                const actualValue = (verifiedGoal as any)[diff.field];
                const expectedValue = updates[diff.field];

                if (expectedValue !== undefined && actualValue !== expectedValue) {
                    verificationErrors.push(`${diff.label}: ожидалось "${expectedValue}", в БД "${actualValue}"`);
                }
            }

            if (verificationErrors.length > 0) {
                console.error(`[update_goal] ⚠️ Верификация обнаружила расхождения для цели #${input.goalId}:`, verificationErrors);
                return {
                    success: false,
                    error: `Данные не были записаны корректно: ${verificationErrors.join('; ')}`,
                    displayText: `❌ ОШИБКА ЗАПИСИ: Обновление цели "${goal.title}" не прошло верификацию.\n` +
                        verificationErrors.map(e => `  • ${e}`).join('\n') +
                        `\nПопробуй вызвать update_goal повторно.`,
                };
            }

            // ── Формируем подробный displayText с diff и верификацией ──
            const diffLines = diffs.map(d => {
                if (d.field === 'notes') return `  • ${d.label}: добавлена`;
                if (d.field === 'description' && !input.notes) return `  • ${d.label}: перезаписано`;
                return `  • ${d.label}: ${d.before} → ${d.after}`;
            });

            const displayText = [
                `✅ Цель [ID: ${input.goalId}] "${verifiedGoal.title}" обновлена.`,
                ``,
                `Изменения:`,
                ...diffLines,
                ``,
                `── Верификация (актуальное состояние в БД) ──`,
                `  Статус: ${verifiedGoal.status}`,
                `  Приоритет: ${verifiedGoal.priority}`,
                `  Прогресс: ${verifiedGoal.progress}%`,
                `  Категория: ${verifiedGoal.category}`,
                verifiedGoal.deadline ? `  Дедлайн: ${verifiedGoal.deadline.toLocaleDateString('ru-RU')}` : `  Дедлайн: не установлен`,
                `── Конец верификации ──`,
                ``,
                `⚠️ ВАЖНО: Сообщай пользователю ТОЛЬКО те поля, которые были ФАКТИЧЕСКИ изменены (см. "Изменения" выше).`,
                `Если пользователь просил изменить статус, а ты изменил только приоритет — это РАЗНЫЕ вещи! Уточни у пользователя.`,
            ].join('\n');

            return {
                success: true,
                data: {
                    goalId: input.goalId,
                    verified: true,
                    changes: diffs.map(d => ({ field: d.field, before: d.before, after: d.after })),
                    currentState: {
                        status: verifiedGoal.status,
                        priority: verifiedGoal.priority,
                        progress: verifiedGoal.progress,
                        category: verifiedGoal.category,
                        title: verifiedGoal.title,
                    },
                },
                displayText,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка обновления цели: ${error?.message || error}`,
            };
        }
    },
};
