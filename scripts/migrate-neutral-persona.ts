/**
 * Migration: Replace business-mentor persona with neutral adaptive persona
 * 
 * This updates the system_prompt in ai_model_configs for task_type='agent_core'.
 * The old prompt forced a rigid "business coach" on ALL roles (including psychology, leisure).
 * The new prompt is neutral and adapts to the active role.
 * 
 * Run with: npx tsx scripts/migrate-neutral-persona.ts
 * Dry-run:  npx tsx scripts/migrate-neutral-persona.ts --dry-run
 */

import 'dotenv/config';
import { db } from '../server/db';
import { aiModelConfigs } from '../shared/schema';
import { eq } from 'drizzle-orm';

const NEW_PERSONA = `Ты — персональный AI-ассистент Артёма.

Стиль: прямой, без воды, конкретный. Не нужно извинений, реверансов и «как я могу помочь?». Просто делай дело.

Язык: русский. Используй нецензурную лексику только если пользователь сам так общается в текущем сообщении.

Адаптивность: подстраивай тон под текущую роль (экспертизу).
- Бизнес → деловой, конкретный, с цифрами
- Психология → мягкий, поддерживающий, безоценочный
- Досуг → вдохновляющий, с практичными деталями
- Финансы → осторожный, с расчётами
- Ассистент → лаконичный, исполнительный

Метаправило: ты многоцелевой ассистент — бизнес, досуг, психология, быт, финансы. Отвечай в контексте ТЕКУЩЕГО запроса. Бизнес-тематика важна и уместна в любой роли, но не навязывай её, если контекст не требует.`;

async function main() {
    const isDryRun = process.argv.includes('--dry-run');
    
    console.log('🔄 Migration: Neutral Persona for agent_core');
    console.log(`   Mode: ${isDryRun ? '🧪 DRY RUN (без записи)' : '🚀 LIVE (запись в БД)'}`);
    console.log('');

    // 1. Read current prompt
    const [currentConfig] = await db.select()
        .from(aiModelConfigs)
        .where(eq(aiModelConfigs.taskType, 'agent_core'))
        .limit(1);

    if (!currentConfig) {
        console.error('❌ Конфиг agent_core не найден в ai_model_configs!');
        process.exit(1);
    }

    console.log('📋 ТЕКУЩИЙ промпт (первые 200 символов):');
    console.log(`   "${(currentConfig.systemPrompt || '').substring(0, 200)}..."`);
    console.log(`   Длина: ${(currentConfig.systemPrompt || '').length} символов`);
    console.log('');

    console.log('📋 НОВЫЙ промпт:');
    console.log('---');
    console.log(NEW_PERSONA);
    console.log('---');
    console.log(`   Длина: ${NEW_PERSONA.length} символов`);
    console.log('');

    if (isDryRun) {
        console.log('🧪 Dry run завершён. Для применения запустите без --dry-run');
        process.exit(0);
    }

    // 2. Update
    await db.update(aiModelConfigs)
        .set({ systemPrompt: NEW_PERSONA })
        .where(eq(aiModelConfigs.taskType, 'agent_core'));

    console.log('✅ Промпт agent_core обновлён!');
    console.log('');
    console.log('📌 Следующие шаги:');
    console.log('   1. Перезапустите приложение (промпты ролей обновятся автоматически)');
    console.log('   2. Отправьте тестовое сообщение в каждую роль:');
    console.log('      - Бизнес: "Какой тариф поставить новому клиенту?"');
    console.log('      - Психология: "Я чувствую себя выгоревшим"');
    console.log('      - Досуг: "Куда сходить в выходные?"');

    process.exit(0);
}

main().catch(err => {
    console.error('❌ Ошибка миграции:', err);
    process.exit(1);
});
