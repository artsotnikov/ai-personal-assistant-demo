/**
 * Простой скрипт для применения SQL миграций
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

async function runMigration(filePath: string) {
    console.log(`📦 Применяю миграцию: ${filePath}\n`);

    const sqlContent = readFileSync(filePath, 'utf-8');

    // Разбиваем на отдельные statements
    const statements = sqlContent
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
        try {
            await db.execute(sql.raw(statement));
            console.log(`✅ ${statement.substring(0, 60)}...`);
        } catch (error: any) {
            // Игнорируем ошибки "already exists"
            if (error.message.includes('already exists') ||
                error.message.includes('does not exist')) {
                console.log(`⏭️ Пропущено: ${statement.substring(0, 50)}...`);
            } else {
                console.error(`❌ Ошибка: ${error.message}`);
                console.error(`   SQL: ${statement.substring(0, 100)}...`);
            }
        }
    }

    console.log('\n✅ Миграция завершена!');
    process.exit(0);
}

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: npx tsx scripts/runMigration.ts <path.sql>');
    process.exit(1);
}

runMigration(filePath);
