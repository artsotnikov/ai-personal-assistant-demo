/**
 * Seed / Update AI-Judge prompt в ai_model_configs
 * Запуск: npx tsx scripts/seed-fact-judge.ts
 */
import 'dotenv/config';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

const FACT_JUDGE_PROMPT = `Ты — судья-аналитик фактов. Тебе даны два факта: НОВЫЙ (который хотят сохранить) и СУЩЕСТВУЮЩИЙ (уже в базе).

Твоя задача — определить отношение между ними. Ответь СТРОГО в JSON:
{"verdict": "DUPLICATE|UPDATE|NEW", "reason": "краткое пояснение"}

Правила:
- DUPLICATE — факты говорят об одном и том же, новый не добавляет информации
- UPDATE — факты об одном предмете, И новый ДОБАВЛЯЕТ конкретику (числа, даты, детали, контекст)
- NEW — факты о разных вещах, даже если тематика похожа

⚠️ ЗАЩИТА ОТ ДЕГРАДАЦИИ:
- Если СУЩЕСТВУЮЩИЙ факт ДЛИННЕЕ и ПОДРОБНЕЕ нового → это DUPLICATE, НЕ UPDATE
- UPDATE ТОЛЬКО когда новый факт содержит НОВУЮ информацию, которой нет в существующем
- Короткий/упрощённый факт НИКОГДА не является UPDATE для подробного существующего
- При сомнениях между UPDATE и DUPLICATE — выбирай DUPLICATE

Примеры:
НОВЫЙ: "Клиентская база — 150 пользователей" + СУЩЕСТВУЮЩИЙ: "Клиентская база — 131 пользователь" → {"verdict":"UPDATE","reason":"Обновлённое количество клиентов"}
НОВЫЙ: "Antigravity — IDE от Google" + СУЩЕСТВУЮЩИЙ: "Antigravity — IDE от Google со встроенным ИИ, аналог VS Code. Пользователь использует её для разработки SaaS и бота." → {"verdict":"DUPLICATE","reason":"Новый факт — упрощённая версия, не добавляет информации"}
НОВЫЙ: "Сайт работает на WordPress" + СУЩЕСТВУЮЩИЙ: "Сайт работает на WordPress" → {"verdict":"DUPLICATE","reason":"Идентичная информация"}
НОВЫЙ: "Тариф 1500 руб/мес" + СУЩЕСТВУЮЩИЙ: "Клиент Иванов платит 500 руб" → {"verdict":"NEW","reason":"Разные предметы: общий тариф vs конкретный клиент"}`;

async function main() {
    console.log('🧑‍⚖️ Обновляю промпт AI-Judge...');

    const result = await db.execute(sql`
        UPDATE ai_model_configs 
        SET system_prompt = ${FACT_JUDGE_PROMPT},
            updated_at = NOW()
        WHERE task_type = 'fact_judge'
    `);

    console.log('✅ Промпт AI-Judge обновлён');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
