import 'dotenv/config';
import { getModelsByProvider, getAvailableProviders } from '../server/aiModelsApi';

async function testModels() {
    // Проверяем доступность провайдеров
    console.log('=== Доступные провайдеры ===\n');
    const providers = getAvailableProviders();
    providers.forEach(p => {
        console.log(`${p.id}: ${p.name} - ${p.available ? '✅ Доступен' : '❌ Не настроен'}`);
    });

    // Тестируем DeepSeek
    console.log('\n=== Модели DeepSeek ===\n');
    try {
        const models = await getModelsByProvider('deepseek');
        console.log(`Получено моделей: ${models.length}`);
        if (models.length > 0) {
            models.forEach(m => console.log(`  - ${m.id}`));
        } else {
            console.log('❌ Модели не получены (проверьте DEEPSEEK_API_KEY)');
        }
    } catch (error: any) {
        console.error('❌ Ошибка:', error.message);
    }

    // Тестируем OpenRouter
    console.log('\n=== Модели OpenRouter (первые 10) ===\n');
    try {
        const models = await getModelsByProvider('openrouter');
        console.log(`Получено моделей: ${models.length}`);
        if (models.length > 0) {
            models.slice(0, 10).forEach(m => console.log(`  - ${m.id}`));
        } else {
            console.log('❌ Модели не получены (проверьте OPENROUTER_API_KEY)');
        }
    } catch (error: any) {
        console.error('❌ Ошибка:', error.message);
    }
}

testModels();
