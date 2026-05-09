/**
 * Исправление конфигурации query_planning
 * 
 * Запуск: npx tsx server/scripts/fixQueryPlanningConfig.ts
 */

import 'dotenv/config';
import { db } from "../db";
import { aiModelConfigs } from "@shared/schema";
import { eq } from "drizzle-orm";

async function fix() {
    console.log('🔧 Исправление конфигурации query_planning...\n');

    // Проверяем текущую конфигурацию
    const current = await db.select()
        .from(aiModelConfigs)
        .where(eq(aiModelConfigs.taskType, 'query_planning'));

    if (current.length > 0) {
        console.log('Текущая конфигурация:');
        console.log(`  Provider: ${current[0].provider}`);
        console.log(`  Model: ${current[0].model}`);
        console.log(`  MaxTokens: ${current[0].maxTokens}`);
    }

    // Обновляем на openrouter/gpt-4.1-mini который работает стабильно
    await db.update(aiModelConfigs)
        .set({
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            maxTokens: 800,
            temperature: '0.15',
            updatedAt: new Date(),
        })
        .where(eq(aiModelConfigs.taskType, 'query_planning'));

    console.log('\n✅ Конфигурация обновлена на openrouter/openai/gpt-4.1-mini');
    console.log('   MaxTokens: 800');

    // Проверяем результат
    const updated = await db.select()
        .from(aiModelConfigs)
        .where(eq(aiModelConfigs.taskType, 'query_planning'));

    if (updated.length > 0) {
        console.log('\nНовая конфигурация:');
        console.log(`  Provider: ${updated[0].provider}`);
        console.log(`  Model: ${updated[0].model}`);
        console.log(`  MaxTokens: ${updated[0].maxTokens}`);
    }

    process.exit(0);
}

fix().catch(err => {
    console.error('Ошибка:', err);
    process.exit(1);
});
