/**
 * Seed: добавить browser_agent в ai_model_configs
 */
import { db } from "../db";
import { aiModelConfigs } from "@shared/schema";
import { eq } from "drizzle-orm";

async function seedBrowserAgent() {
    // Проверяем, существует ли уже
    const [existing] = await db.select()
        .from(aiModelConfigs)
        .where(eq(aiModelConfigs.taskType, 'browser_agent'))
        .limit(1);

    if (existing) {
        console.log('✅ browser_agent уже существует в ai_model_configs');
        process.exit(0);
    }

    await db.insert(aiModelConfigs).values({
        taskType: 'browser_agent',
        provider: 'openrouter',
        model: 'google/gemini-3-flash-preview',
        temperature: '0.3',
        maxTokens: 8000,
        description: 'Веб-агент — работа с браузером (скрапинг, навигация, формы)',
        isActive: true,
    });

    console.log('✅ browser_agent добавлен в ai_model_configs');
    process.exit(0);
}

seedBrowserAgent().catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
