
import { db } from '../server/db';
import { aiModelConfigs } from '../shared/schema';
import { eq } from 'drizzle-orm';
import 'dotenv/config';

async function seed() {
    console.log('--- Seeding Anti-Gravity Config ---');
    try {
        await db.insert(aiModelConfigs).values({
            taskType: 'antigravity_test' as any,
            provider: 'antigravity' as any,
            model: 'gemini-3.1-pro-low',
            temperature: '0.7',
            maxTokens: 1000,
            isActive: true,
            description: 'Тестовый конфиг для Anti-Gravity прокси (спецификация 2026)'
        }).onConflictDoUpdate({
            target: aiModelConfigs.taskType,
            set: {
                provider: 'antigravity' as any,
                model: 'gemini-3.1-pro-low',
                description: 'Тестовый конфиг для Anti-Gravity прокси (спецификация 2026)'
            }
        });
        console.log('✅ Config seeded/updated successfully');
    } catch (error: any) {
        console.error('❌ Error seeding config:', error.message);
    }
}

seed();
