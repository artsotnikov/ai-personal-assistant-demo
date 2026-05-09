/**
 * Read Diagnostics — Чтение системных диагностических логов из БД
 * 
 * Используйте из dev-среды для анализа проблем на продакшене:
 *   npx tsx scripts/read-diagnostics.ts                  # все логи (лимит 20)
 *   npx tsx scripts/read-diagnostics.ts ticktick         # только TickTick
 *   npx tsx scripts/read-diagnostics.ts ticktick 50      # с увеличенным лимитом
 *   npx tsx scripts/read-diagnostics.ts --errors         # только ошибки
 *   npx tsx scripts/read-diagnostics.ts ticktick --errors # TickTick ошибки
 */
import "dotenv/config";
import { readDiagnostics, type DiagnosticLevel } from "../server/services/diagnosticLogger";

async function main() {
    const args = process.argv.slice(2);
    
    let service: string | undefined;
    let level: DiagnosticLevel | undefined;
    let limit = 20;

    for (const arg of args) {
        if (arg === '--errors') {
            level = 'error';
        } else if (arg === '--warn') {
            level = 'warn';
        } else if (/^\d+$/.test(arg)) {
            limit = parseInt(arg, 10);
        } else if (!arg.startsWith('--')) {
            service = arg;
        }
    }

    console.log(`\n=== System Diagnostics ===`);
    console.log(`Filter: service=${service || 'ALL'}, level=${level || 'ALL'}, limit=${limit}\n`);

    const entries = await readDiagnostics({ service, level, limit });

    if (entries.length === 0) {
        console.log('📭 Нет записей.\n');
        process.exit(0);
    }

    for (const entry of entries.reverse()) { // chronological order
        const ts = new Date(entry.created_at).toISOString().replace('T', ' ').substring(0, 19);
        const icon = entry.level === 'error' ? '❌' : entry.level === 'warn' ? '⚠️' : '✅';
        const env = entry.environment === 'production' ? '🏭' : '🛠️';

        console.log(`${env} ${icon} [${ts}] ${entry.service}/${entry.event}: ${entry.message}`);
        if (entry.details) {
            const details = typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details;
            for (const [key, value] of Object.entries(details)) {
                console.log(`      ${key}: ${JSON.stringify(value)}`);
            }
        }
        console.log('');
    }

    console.log(`Total: ${entries.length} entries\n`);
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
