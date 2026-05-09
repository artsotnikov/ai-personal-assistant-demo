/**
 * Optimize AI model configs with best practices
 * Run with: npx tsx scripts/optimize-ai-configs.ts
 */

import 'dotenv/config';
import { db } from '../server/db';
import { aiModelConfigs } from '../shared/schema';
import { eq } from 'drizzle-orm';

interface ConfigUpdate {
    taskType: string;
    temperature: string;
    maxTokens: number;
    reason: string;
}

const OPTIMIZATIONS: ConfigUpdate[] = [
    // Служебные задачи — низкая температура, умеренные токены
    {
        taskType: 'query_planning',
        temperature: '0.15',
        maxTokens: 600,
        reason: 'Нужен стабильный JSON, чуть больше токенов для сложных планов'
    },
    {
        taskType: 'agent_routing',
        temperature: '0.15',
        maxTokens: 400,
        reason: 'Детерминированный выбор агента'
    },
    {
        taskType: 'fact_extraction',
        temperature: '0.25',
        maxTokens: 1200,
        reason: 'Больше токенов для извлечения множества фактов'
    },
    {
        taskType: 'goal_extraction',
        temperature: '0.3',
        maxTokens: 800,
        reason: 'Нужно понимание контекста целей'
    },
    {
        taskType: 'profile_extraction',
        temperature: '0.25',
        maxTokens: 800,
        reason: 'Более детальное извлечение профиля'
    },
    {
        taskType: 'insight_analysis',
        temperature: '0.5',
        maxTokens: 800,
        reason: 'Творческий анализ связей, больше токенов для инсайтов'
    },
    {
        taskType: 'conversation_summary',
        temperature: '0.35',
        maxTokens: 1200,
        reason: 'Точность с сохранением деталей'
    },
    {
        taskType: 'topic_detection',
        temperature: '0.2',
        maxTokens: 400,
        reason: 'Стабильное определение тем'
    },

    // Агенты ответа — умеренная/высокая температура, большие токены
    {
        taskType: 'agent_business',
        temperature: '0.7',
        maxTokens: 8000,
        reason: 'Креативные бизнес-советы, развёрнутые ответы'
    },
    {
        taskType: 'agent_finance',
        temperature: '0.5',
        maxTokens: 8000,
        reason: 'Баланс точности и советов'
    },
    {
        taskType: 'agent_psychology',
        temperature: '0.85',
        maxTokens: 8000,
        reason: 'Высокая эмпатия, разнообразие формулировок'
    },
];

async function optimize() {
    console.log('🔧 Optimizing AI model configurations...\n');

    for (const opt of OPTIMIZATIONS) {
        try {
            await db.update(aiModelConfigs)
                .set({
                    temperature: opt.temperature,
                    maxTokens: opt.maxTokens,
                    updatedAt: new Date()
                })
                .where(eq(aiModelConfigs.taskType, opt.taskType as any));

            console.log(`✅ ${opt.taskType}: temp=${opt.temperature}, tokens=${opt.maxTokens}`);
            console.log(`   └─ ${opt.reason}`);
        } catch (error) {
            console.error(`❌ ${opt.taskType}: ${error}`);
        }
    }

    console.log('\n✨ Optimization complete!');
    process.exit(0);
}

optimize();
