
import 'dotenv/config';
import { db } from '../server/db';
import { aiModelConfigs } from '@shared/schema';
import { eq } from 'drizzle-orm';

async function checkDefaultConfig() {
    console.log('Проверка конфигураций в таблице ai_model_configs...\n');

    try {
        // Читаем все конфигурации
        const allConfigs = await db.select().from(aiModelConfigs);

        console.log(`Всего конфигураций в БД: ${allConfigs.length}\n`);

        // Ищем default
        const defaultConfig = allConfigs.find(c => c.taskType === 'default');

        if (defaultConfig) {
            console.log('✅ DEFAULT конфигурация НАЙДЕНА:');
            console.log('  Provider:', defaultConfig.provider);
            console.log('  Model:', defaultConfig.model);
            console.log('  Temperature:', defaultConfig.temperature);
            console.log('  MaxTokens:', defaultConfig.maxTokens);
        } else {
            console.log('❌ DEFAULT конфигурация НЕ НАЙДЕНА в БД!');
            console.log('   Система будет использовать hardcoded DEFAULT_CONFIG из кода.\n');
        }

        console.log('\nВсе конфигурации в БД:');
        allConfigs.forEach(c => {
            console.log(`  ${c.taskType}: ${c.provider}/${c.model}`);
        });

    } catch (error) {
        console.error('❌ Ошибка:', error);
    }

    process.exit(0);
}

checkDefaultConfig();
