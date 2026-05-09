
import 'dotenv/config';
import { db } from '../server/db';
import { appSettings as settings } from '@shared/schema';
import { eq, inArray } from 'drizzle-orm';

async function getCurrentConfig() {
    console.log('Fetching active AI settings from DB...');
    try {
        const results = await db.select()
            .from(settings)
            .where(inArray(settings.key, ['ai_provider', 'ai_model', 'ai_system_prompt']));

        console.log('\nCurrent Settings:');
        results.forEach(r => {
            console.log(`${r.key}: ${r.value}`);
        });
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}

getCurrentConfig();
