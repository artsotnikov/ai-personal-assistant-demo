
import 'dotenv/config';
import { db } from '../server/db';
import { appSettings as settings } from '@shared/schema';
import { eq } from 'drizzle-orm';

async function testSaveConfig() {
    console.log('Тест: Сохранение AI конфигурации в БД\n');

    try {
        // 1. Удаляем существующие настройки (если есть)
        await db.delete(settings).where(eq(settings.key, 'ai_provider'));
        await db.delete(settings).where(eq(settings.key, 'ai_model'));
        console.log('✅ Старые настройки удалены\n');

        // 2. Сохраняем новые
        await db.insert(settings).values({ key: 'ai_provider', value: 'openrouter' });
        await db.insert(settings).values({ key: 'ai_model', value: 'openai/gpt-4.1-mini' });
        console.log('✅ Новые настройки сохранены в БД\n');

        // 3. Читаем обратно
        const provider = await db.select().from(settings).where(eq(settings.key, 'ai_provider'));
        const model = await db.select().from(settings).where(eq(settings.key, 'ai_model'));

        console.log('Результат чтения из БД:');
        console.log('  Provider:', provider[0]?.value || 'НЕТ');
        console.log('  Model:', model[0]?.value || 'НЕТ');

        if (provider[0]?.value === 'openrouter' && model[0]?.value === 'openai/gpt-4.1-mini') {
            console.log('\n✅ СОХРАНЕНИЕ РАБОТАЕТ!');
        } else {
            console.log('\n❌ ОШИБКА: Данные не совпадают!');
        }

    } catch (error) {
        console.error('❌ Ошибка:', error);
    }

    process.exit(0);
}

testSaveConfig();
