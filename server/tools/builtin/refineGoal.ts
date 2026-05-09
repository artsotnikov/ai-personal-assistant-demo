/**
 * Tool: refine_goal — SMART-рефайн и декомпозиция цели
 * 
 * Улучшает формулировку цели по SMART-методологии и предлагает
 * декомпозицию на milestones + tasks. НЕ сохраняет автоматически —
 * возвращает предложение для валидации пользователем.
 * 
 * Принципы (из workflow /goals):
 * 1. Collaborative Validation — AI предлагает, пользователь утверждает
 * 2. Контекст перед декомпозицией — подгружаем facts, историю, цели
 * 3. Спрашивать, а не додумывать — если нет данных, задать вопросы
 * 4. Шаги привязаны к реальности пользователя
 */

import type { ToolDefinition, ToolResult } from '../types';
import { db } from '../../db';
import { goals, goalMilestones, goalTasks, goalKeyResults, goalActivityLog } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { getAIClientForTask, callWithFallback } from '../../aiConfigService';

interface RefineGoalInput {
    goalId: number;
    /** Дополнительный контекст, который пользователь хочет учесть */
    userContext?: string;
    /** Режим: 'refine' (только SMART), 'decompose' (milestones+tasks), 'full' (и то, и другое) */
    mode?: 'refine' | 'decompose' | 'full';
    /** Если true — автоматически сохранить результат СРАЗУ (пропуская Collaborative Validation) */
    immediateSave?: boolean;
    /** Если true — результат этого вызова (предложение) будет считаться подтверждённым пользователем и сохранён */
    saveApproved?: boolean;
    /** JSON-строка с подтверждённым планом от пользователя (передаётся при saveApproved=true) */
    approvedPlan?: string;
    /** ID записи предложения из goal_activity_log (альтернатива передаче всего JSON) */
    proposalId?: number;
}

export const refineGoalTool: ToolDefinition<RefineGoalInput> = {
    name: 'refine_goal',
    description: `Улучшить цель по SMART-методологии и/или декомпозировать на milestones и tasks.

ВАЖНО: Результат НЕ сохраняется автоматически! Сначала покажи пользователю предложенные изменения, 
дождись подтверждения, и только потом вызови refine_goal с saveApproved=true.

Режимы:
- refine: улучшить формулировку цели (SMART)
- decompose: предложить milestones + tasks
- full: всё вместе (по умолчанию)

Workflow:
1. Вызови refine_goal(goalId, mode) → получи предложение
2. Покажи пользователю → собери обратную связь
3. Если одобрено → вызови refine_goal(goalId, saveApproved=true, approvedPlan=JSON)`,
    category: 'planning',
    toolPack: 'goals',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            goalId: {
                type: 'number',
                description: 'ID цели для рефайна (числовой ID из БД, отображается как [ID: X]. НЕ порядковый номер!)',
            },
            userContext: {
                type: 'string',
                description: 'Дополнительный контекст от пользователя (ресурсы, ограничения, предпочтения)',
            },
            mode: {
                type: 'string',
                enum: ['refine', 'decompose', 'full'],
                description: 'Режим: refine (SMART), decompose (вехи+задачи), full (всё)',
            },
            immediateSave: {
                type: 'boolean',
                description: 'Сохранить план СРАЗУ без промежуточного подтверждения (использовать только при явном запросе)',
            },
            saveApproved: {
                type: 'boolean',
                description: 'Сохранить подтверждённый план в БД',
            },
            approvedPlan: {
                type: 'string',
                description: 'JSON с подтверждённым планом (из тега <plan_json> предыдущего ответа)',
            },
            proposalId: {
                type: 'number',
                description: 'ID предложения из истории активности (если не передан approvedPlan)',
            },
        },
        required: ['goalId'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // 1. Загружаем цель
            const existing = await db.select().from(goals).where(eq(goals.id, input.goalId)).limit(1);
            if (existing.length === 0) {
                return {
                    success: false,
                    error: `Цель с ID ${input.goalId} не найдена`,
                    displayText: `Цель с ID ${input.goalId} не найдена.`,
                };
            }
            const goal = existing[0];

            // 2. Если saveApproved — сохраняем подтверждённый план
            if (input.saveApproved) {
                let planJson = input.approvedPlan;
                
                // Если передан proposalId — загружаем план из логов
                if (!planJson && input.proposalId) {
                    const logs = await db.select().from(goalActivityLog)
                        .where(eq(goalActivityLog.id, input.proposalId))
                        .limit(1);
                    if (logs.length > 0 && logs[0].metadata?.plan) {
                        planJson = JSON.stringify(logs[0].metadata.plan);
                    }
                }

                if (!planJson) {
                    return {
                        success: false,
                        error: 'Не указан план для сохранения (нужен approvedPlan или корректный proposalId)',
                        displayText: '❌ Ошибка: не найден план для сохранения. Убедись, что передаёшь JSON из <plan_json> или верный ID предложения.',
                    };
                }

                return await saveApprovedPlan(goal.id, planJson);
            }

            // 3. Генерируем предложение через AI
            const mode = input.mode || 'full';
            const proposalData = await generateProposalData(goal, mode, input.userContext);

            // 4. Если immediateSave — сохраняем сразу
            if (input.immediateSave) {
                const saveResult = await saveApprovedPlan(goal.id, JSON.stringify(proposalData));
                if (saveResult.success) {
                    return {
                        success: true,
                        data: { goalId: goal.id, mode, saved: true },
                        displayText: `${formatProposalText(proposalData, mode)}\n\n✅ **План автоматически сохранён в базу данных.**`,
                    };
                }
                return saveResult;
            }

            // 5. Иначе возвращаем предложение для подтверждения
            // Сохраняем предложение как черновик в Activity Log для преемственности
            const [proposalLog] = await db.insert(goalActivityLog).values({
                goalId: goal.id,
                activityType: 'review', // Тип review используется для предложений
                description: `Предложение по декомпозиции (черновик #${mode})`,
                metadata: { plan: proposalData, isProposal: true },
            }).returning();

            const proposalText = formatProposalText(proposalData, mode);

            return {
                success: true,
                data: { goalId: goal.id, mode, proposalId: proposalLog.id, proposal: proposalData },
                displayText: `${proposalText}\n\n_ID предложения для сохранения: ${proposalLog.id}_`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка рефайна цели: ${error?.message || error}`,
            };
        }
    },
};

/**
 * Генерация данных предложения по улучшению/декомпозиции цели через AI
 */
async function generateProposalData(
    goal: { id: number; title: string; description: string | null; smartDescription: string | null; category: string | null; priority: string | null; deadline: Date | null },
    mode: 'refine' | 'decompose' | 'full',
    userContext?: string,
): Promise<any> {
    let aiConfig;
    try {
        aiConfig = await getAIClientForTask('goal_extraction');
    } catch {
        throw new Error('AI клиент недоступен');
    }

    const now = new Date();
    const moscowDate = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: 'long', day: 'numeric' });

    const sections: string[] = [];

    if (mode === 'refine' || mode === 'full') {
        sections.push(`
## SMART-рефайн
Переформулируй цель по SMART:
- **S** (Specific): Что именно нужно достичь?
- **M** (Measurable): Как измерить результат? Конкретные числа/метрики.
- **A** (Achievable): Реалистична ли с учётом контекста?
- **R** (Relevant): Зачем это важно?
- **T** (Time-bound): Когда дедлайн?

Предложи:
1. smart_description — улучшенную формулировку
2. category — одна из: business, personal, financial, health
3. priority — одна из: focus, high, medium, low, someday
4. key_results — 2-3 измеримые метрики (название, целевое значение, единица, auto_query — описание как получить текущее значение автоматически)`);
    }

    if (mode === 'decompose' || mode === 'full') {
        sections.push(`
## Декомпозиция
Разбей цель на 3-5 milestones (вех), каждая с 2-4 tasks (задачами).
Для каждого milestone:
- title, description, примерный deadline
- tasks с конкретными действиями

КРИТИЧНО:
- Задачи должны быть КОНКРЕТНЫЕ (не "разработать стратегию", а "написать 10 писем клиентам")
- Сроки РЕАЛИСТИЧНЫЕ с учётом что пользователь может работать один
- Учитывай контекст пользователя если он предоставлен`);
    }

    const prompt = `Проанализируй цель и предложи улучшения.

═══════════════════════════════════════
ТЕКУЩАЯ ДАТА: ${moscowDate}
═══════════════════════════════════════

ЦЕЛЬ:
- ID: ${goal.id}
- Название: ${goal.title}
- Описание: ${goal.description || 'не указано'}
- SMART: ${goal.smartDescription || 'не сформулировано'}
- Категория: ${goal.category || 'не определена'}
- Приоритет: ${goal.priority || 'не определён'}
- Дедлайн: ${goal.deadline ? goal.deadline.toLocaleDateString('ru-RU') : 'не установлен'}

${userContext ? `КОНТЕКСТ ОТ ПОЛЬЗОВАТЕЛЯ:\n${userContext}\n` : ''}
${sections.join('\n')}

═══════════════════════════════════════
ФОРМАТ ОТВЕТА
═══════════════════════════════════════

Ответь в JSON:
{
  "smart_description": "Улучшенная формулировка",
  "category": "business|personal|financial|health",
  "priority": "focus|high|medium|low|someday",
  "key_results": [
    {"title": "...", "target_value": 50, "unit": "шт", "metric": "клиенты", "auto_query": "описание как автоматически получить текущее значение или null если не автоматизируется"}
  ],
  "milestones": [
    {
      "title": "...",
      "description": "...",
      "deadline": "YYYY-MM-DD",
      "tasks": [
        {"title": "...", "description": "...", "priority": "high|medium|low"}
      ]
    }
  ],
  "questions": ["Уточняющий вопрос если нет данных"]
}

Если не уверен в деталях — НЕ выдумывай, добавь вопросы в "questions".
Поля key_results и milestones — заполняй только если соответствует режиму.`;

    const result = await callWithFallback(aiConfig, [
        { role: 'system', content: aiConfig.systemPrompt || 'Ты помощник по управлению целями.' },
        { role: 'user', content: prompt },
    ]);

    const content = result.content?.trim() || '{}';
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
        return JSON.parse(clean);
    } catch {
        throw new Error('AI не смог сгенерировать валидный JSON-план. Попробуй ещё раз.');
    }
}

/**
 * Форматирование предложения в читаемый текст для пользователя
 */
function formatProposalText(plan: any, mode: string): string {
    const parts: string[] = [];
    parts.push(`📋 **Предложение по улучшению цели**\n`);

    if (plan.smart_description && (mode === 'refine' || mode === 'full')) {
        parts.push(`**SMART-формулировка:** ${plan.smart_description}`);
        if (plan.category) parts.push(`**Категория:** ${plan.category}`);
        if (plan.priority) parts.push(`**Приоритет:** ${plan.priority}`);
    }

    if (plan.key_results?.length > 0) {
        parts.push(`\n**Ключевые результаты:**`);
        for (const kr of plan.key_results) {
            parts.push(`- ${kr.title}: ${kr.target_value} ${kr.unit || ''}`);
        }
    }

    if (plan.milestones?.length > 0 && (mode === 'decompose' || mode === 'full')) {
        parts.push(`\n**Вехи:**`);
        for (let i = 0; i < plan.milestones.length; i++) {
            const m = plan.milestones[i];
            const deadline = m.deadline ? ` (до ${m.deadline})` : '';
            parts.push(`\n${i + 1}. **${m.title}**${deadline}`);
            if (m.description) parts.push(`   ${m.description}`);
            if (m.tasks?.length > 0) {
                for (const t of m.tasks) {
                    parts.push(`   - ${t.title}`);
                }
            }
        }
    }

    if (plan.questions?.length > 0) {
        parts.push(`\n❓ **Уточняющие вопросы:**`);
        for (const q of plan.questions) {
            parts.push(`- ${q}`);
        }
    }

    parts.push(`\n---`);
    parts.push(`_Если план OK — скажи «сохрани» или скорректируй. Я НЕ сохраняю автоматически._`);

    // Прикрепляем JSON для последующего сохранения
    parts.push(`\n<plan_json>${JSON.stringify(plan)}</plan_json>`);

    return parts.join('\n');
}

/**
 * Сохранение подтверждённого плана в БД
 */
async function saveApprovedPlan(goalId: number, approvedPlanJson: string): Promise<ToolResult> {
    // 0. Валидация JSON
    let plan: any;
    try {
        plan = JSON.parse(approvedPlanJson);
    } catch (parseError: any) {
        return {
            success: false,
            error: `Невалидный JSON: ${parseError.message}`,
            displayText: `❌ Ошибка: approvedPlan содержит невалидный JSON. Убедись что передаёшь корректный JSON-объект.\n\nДеталь: ${parseError.message}`,
        };
    }

    try {
        const savedItems: string[] = [];

        // 1. Обновляем цель (SMART, категория, приоритет)
        if (plan.smart_description || plan.category || plan.priority) {
            const goalUpdate: Record<string, any> = { updatedAt: new Date() };
            if (plan.smart_description) goalUpdate.smartDescription = plan.smart_description;
            if (plan.category) goalUpdate.category = plan.category;
            if (plan.priority) goalUpdate.priority = plan.priority;

            await db.update(goals).set(goalUpdate).where(eq(goals.id, goalId));
            savedItems.push('SMART-формулировка');
        }

        // 2. Сохраняем key results
        if (plan.key_results?.length > 0) {
            for (const kr of plan.key_results) {
                await db.insert(goalKeyResults).values({
                    goalId,
                    title: kr.title,
                    metric: kr.metric || null,
                    targetValue: kr.target_value || null,
                    currentValue: 0,
                    unit: kr.unit || null,
                    autoQuery: kr.auto_query || null,
                });
            }
            savedItems.push(`${plan.key_results.length} ключевых результатов`);
        }

        // 3. Сохраняем milestones + tasks
        if (plan.milestones?.length > 0) {
            let totalTasks = 0;
            for (let i = 0; i < plan.milestones.length; i++) {
                const m = plan.milestones[i];
                const [milestone] = await db.insert(goalMilestones).values({
                    goalId,
                    title: m.title,
                    description: m.description || null,
                    sortOrder: i,
                    weight: m.weight ? Math.max(1, Math.min(10, Math.round(m.weight))) : 1,
                    deadline: m.deadline ? new Date(m.deadline) : null,
                }).returning();

                // Tasks
                if (m.tasks?.length > 0) {
                    for (let j = 0; j < m.tasks.length; j++) {
                        const t = m.tasks[j];
                        await db.insert(goalTasks).values({
                            milestoneId: milestone.id,
                            goalId,
                            title: t.title,
                            description: t.description || null,
                            sortOrder: j,
                            priority: t.priority || 'medium',
                        });
                        totalTasks++;
                    }
                }
            }
            savedItems.push(`${plan.milestones.length} вех, ${totalTasks} задач`);
        }

        // 4. Записываем в activity log
        await db.insert(goalActivityLog).values({
            goalId,
            activityType: 'review',
            description: `SMART-рефайн: ${savedItems.join(', ')}`,
            metadata: { plan },
        });

        return {
            success: true,
            data: { goalId, saved: savedItems },
            displayText: `✅ План сохранён для цели #${goalId}: ${savedItems.join(', ')}.`,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error?.message || String(error),
            displayText: `Ошибка сохранения плана: ${error?.message || error}`,
        };
    }
}
