/**
 * Скрипт для возврата конфигов на `antigravity`
 */
import 'dotenv/config';
import { db } from '../server/db';
import { aiModelConfigs } from '../shared/schema';
import { eq, inArray } from 'drizzle-orm';

async function revertConfigs() {
    console.log('🔧 Возврат конфигов на antigravity...\n');

    const taskTypes = [
        'antigravity_test',
        'subagent_execution',
        'default',
        'agent_core',
        'agent_final_answer',
        'agent_reflection',
        'intent_classification'
    ];

    for (const taskType of taskTypes) {
        const model = 'gemini-3-flash';
        
        await db.update(aiModelConfigs)
            .set({
                provider: 'antigravity',
                model: model,
                updatedAt: new Date(),
            })
            .where(eq(aiModelConfigs.taskType, taskType));

        console.log(`  ✅ ${taskType} -> antigravity/${model}`);
    }

    console.log('\n🎉 Все конфиги возвращены на antigravity');
    process.exit(0);
}

revertConfigs().catch((err) => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
