/**
 * Backfill: генерация embeddings для существующих сообщений
 * 
 * Запуск: node server/migrations/backfill_message_embeddings.mjs
 * 
 * Стратегия: OpenRouter (primary) → OpenAI+proxy (fallback)
 * Точно повторяет логику embeddingService.ts
 */
import pg from 'pg';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PROXY_URL = process.env.OPENAI_PROXY;

if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL не найден в .env');
    process.exit(1);
}

if (!OPENROUTER_API_KEY && !OPENAI_API_KEY) {
    console.error('❌ Нужен OPENROUTER_API_KEY или OPENAI_API_KEY');
    process.exit(1);
}

const BATCH_SIZE = 10;
const DELAY_MS = 500;

// ========== Clients ==========

// OpenRouter client
function getOpenRouterClient() {
    if (!OPENROUTER_API_KEY) return null;
    return new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: OPENROUTER_API_KEY,
        timeout: 30000,
        defaultHeaders: {
            'HTTP-Referer': process.env.APP_URL || 'https://ai-assistant.app',
            'X-Title': 'AI Personal Assistant',
        },
    });
}

// OpenAI direct client (через прокси)
function getOpenAIClient() {
    if (!OPENAI_API_KEY) return null;

    const opts = { apiKey: OPENAI_API_KEY, timeout: 30000 };

    if (PROXY_URL) {
        let agent;
        if (PROXY_URL.startsWith('socks')) {
            agent = new SocksProxyAgent(PROXY_URL);
        } else {
            agent = new HttpsProxyAgent(PROXY_URL);
        }

        // Используем httpAgent для проксирования
        return new OpenAI({
            ...opts,
            fetch: async (url, init) => {
                const nodeFetch = (await import('node-fetch')).default;
                const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
                return nodeFetch(urlStr, { ...init, agent });
            },
        });
    }

    return new OpenAI(opts);
}

// ========== Embedding ==========

let usedProvider = null;

async function createEmbedding(text) {
    const cleanedText = text.trim().replace(/\n+/g, ' ').slice(0, 8000);

    // 1. OpenRouter
    const orClient = getOpenRouterClient();
    if (orClient) {
        try {
            const resp = await orClient.embeddings.create({
                model: 'openai/text-embedding-3-small',
                input: cleanedText,
            });
            if (resp.data?.[0]?.embedding) {
                if (usedProvider !== 'openrouter') {
                    usedProvider = 'openrouter';
                    console.log('🔗 Provider: OpenRouter');
                }
                return resp.data[0].embedding;
            }
        } catch (e) {
            // fallback
        }
    }

    // 2. OpenAI + proxy
    const oaiClient = getOpenAIClient();
    if (oaiClient) {
        const resp = await oaiClient.embeddings.create({
            model: 'text-embedding-3-small',
            input: cleanedText,
        });
        if (usedProvider !== 'openai') {
            usedProvider = 'openai';
            console.log('🔗 Provider: OpenAI' + (PROXY_URL ? ' (через прокси)' : ''));
        }
        return resp.data[0].embedding;
    }

    throw new Error('Нет доступного провайдера для embeddings');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Main ==========

const client = new pg.Client({ connectionString: DATABASE_URL });

async function main() {
    await client.connect();
    console.log('✅ Подключено к БД');

    const { rows } = await client.query(`
        SELECT id, content, sender 
        FROM messages 
        WHERE embedding_vector IS NULL
          AND sender IN ('user', 'ai')
          AND length(content) >= 30
        ORDER BY id ASC
    `);

    console.log(`📝 Найдено ${rows.length} сообщений для backfill`);

    if (rows.length === 0) {
        console.log('✅ Все сообщения уже имеют embeddings');
        await client.end();
        return;
    }

    let processed = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        for (const row of batch) {
            try {
                const embedding = await createEmbedding(row.content);
                const embeddingStr = `[${embedding.join(',')}]`;

                await client.query(
                    `UPDATE messages SET embedding_vector = $1::vector WHERE id = $2`,
                    [embeddingStr, row.id]
                );
                processed++;
            } catch (err) {
                errors++;
                console.error(`❌ ID ${row.id}: ${err.message?.slice(0, 120)}`);
                if (errors <= 3) {
                    console.error('  Detail:', JSON.stringify(err.error || err.cause || err.code, null, 2)?.slice(0, 300));
                }
                // Если > 5 ошибок подряд — прерываем
                if (errors > 5 && processed === 0) {
                    console.error('🛑 Слишком много ошибок подряд, прерываем.');
                    await client.end();
                    process.exit(1);
                }
            }
        }

        const pct = Math.round(((i + batch.length) / rows.length) * 100);
        console.log(`📊 ${i + batch.length}/${rows.length} (${pct}%) — ✅ ${processed} | ❌ ${errors}`);

        if (i + BATCH_SIZE < rows.length) {
            await sleep(DELAY_MS);
        }
    }

    console.log(`\n✅ Backfill завершён: ${processed} embeddings создано, ${errors} ошибок`);
    await client.end();
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
