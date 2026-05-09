/**
 * Скрипт очистки user_profile от мусорных записей
 * Запуск: npx tsx scripts/cleanup-profile.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const keysToDelete = [
    // Кадровые события — не черта личности
    'приоритизация_кандидатов_по_формальным_признакам',
    'страх_отсева_кандидатов_сложностью_отбора',
    'готовность_инвестировать_в_обучение_персонала',
    'склонность_к_практическому_тестированию_навыков',
    'ценностное_отношение_к_внимательности_и_исполнительности',
    'стратегический_подход_к_привлечению_персонала',
    'склонность_к_анализу_восприятия_текстов_соискателями',
    'склонность_к_систематизации_кадровых_процессов',
    'критическое_отношение_к_формальным_тестам',

    // Рабочие методы — не personality
    'ориентация_на_семантическую_эффективность',
    'мониторинг_качества_структурирования_данных_ии',
    'склонность_к_самостоятельному_расширению_инструментария_ии',
    'ориентация_на_будущие_тренды',
    'склонность_к_ретроспективному_анализу',
    'склонность_к_уточнению_технических_возможностей_инструментов',
    'склонность_к_уточнению_формата_взаимодействия',
    'склонность_к_систематизации_бытовых_задач',

    // goals_preferences мусор
    'goal_26_status',

    // Дубли с preferences
    'response_style_preference',
    'предпочтение_устного_формата_ввода',
    'неприятие_нравоучительного_тона',
    'предпочтение_удаленной_работы_сотрудников',

    // Спорные values
    'ценность_баланса_между_требованиями_и_привлекательностью_вакансии',
    'ценность_чётких_форматов_отчётности',
    'ценность_кроссплатформенной_синхронизации_и_владения_данными',
    'осторожность в маркетинге и продвижении из-за сомнений в конкурентоспособности продукта',
];

async function main() {
    const client = await pool.connect();
    try {
        const placeholders = keysToDelete.map((_, i) => `$${i + 1}`).join(', ');

        // Preview
        const preview = await client.query(
            `SELECT id, key, category FROM user_profile WHERE key IN (${placeholders})`,
            keysToDelete
        );
        console.log(`\n🔍 Найдено записей для удаления: ${preview.rows.length}`);
        for (const row of preview.rows) {
            console.log(`  ❌ [${row.category}] ${row.key} (id: ${row.id})`);
        }

        const beforeCount = await client.query('SELECT count(*) as total FROM user_profile');
        console.log(`\n📊 До чистки: ${beforeCount.rows[0].total} записей`);

        // Delete
        const result = await client.query(
            `DELETE FROM user_profile WHERE key IN (${placeholders}) RETURNING key`,
            keysToDelete
        );
        console.log(`\n✅ Удалено: ${result.rowCount} записей`);

        const afterCount = await client.query('SELECT count(*) as total FROM user_profile');
        console.log(`📊 После чистки: ${afterCount.rows[0].total} записей`);

        // Show remaining communication records
        const comm = await client.query(
            `SELECT key, value FROM user_profile WHERE category = 'communication'`
        );
        console.log(`\n📌 Оставшиеся communication записи: ${comm.rows.length}`);
        for (const row of comm.rows) {
            console.log(`  📝 ${row.key}: ${row.value.substring(0, 80)}...`);
        }
    } finally {
        client.release();
        await pool.end();
    }
    console.log('\n🏁 Готово!');
}

main().catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
});
