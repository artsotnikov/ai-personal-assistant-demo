import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../server/db';
import { expertises } from '../shared/schema';

async function main() {
    console.log('🔄 Запуск скрипта: обновление доступных инструментов для экспертиз...');

    // Получаем все экспертизы
    const allExpertises = await db.select().from(expertises);

    let updatedCount = 0;

    for (const exp of allExpertises) {
        let toolPacks = exp.toolPacks;

        if (!toolPacks) {
            toolPacks = ['core'];
        }

        // Если delegation еще нет — добавляем
        if (!toolPacks.includes('delegation')) {
            toolPacks.push('delegation');
            console.log(`🔧 Обновление экспертизы "${exp.name}" (${exp.slug}): добавлен инструмент "delegation"`);

            await db.update(expertises)
                .set({ toolPacks, updatedAt: new Date() })
                .where(eq(expertises.id, exp.id));

            updatedCount++;
        } else {
            console.log(`✅ Экспертиза "${exp.name}" (${exp.slug}) уже содержит инструмент "delegation"`);
        }
    }

    console.log(`✅ Готово! Обновлено экспертиз: ${updatedCount}`);
    process.exit(0);
}

main().catch(error => {
    console.error('❌ Ошибка при обновлении:', error);
    process.exit(1);
});
