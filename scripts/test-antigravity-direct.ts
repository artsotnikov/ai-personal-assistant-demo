/**
 * Тест подключения к Antigravity-Manager (OpenAI-совместимый API)
 * Запуск: npx tsx scripts/test-antigravity-direct.ts
 * 
 * Antigravity-Manager предоставляет стандартный /v1/chat/completions эндпоинт,
 * поэтому используем обычный OpenAI SDK.
 */
import 'dotenv/config';
import OpenAI from 'openai';

async function testAntigravityManager() {
    const baseURL = process.env.ANTIGRAVITY_URL;
    if (!baseURL) {
        console.error('❌ ANTIGRAVITY_URL не задан в .env');
        process.exit(1);
    }
    const apiKey = process.env.ANTIGRAVITY_API_KEY || 'sk-change-me';

    console.log('--- Testing Antigravity-Manager (OpenAI API) ---');
    console.log(`Base URL: ${baseURL}`);
    console.log(`API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

    const client = new OpenAI({ baseURL, apiKey, timeout: 60_000 });

    try {
        // Шаг 1: Проверка списка моделей
        console.log('\nStep 1: Fetching models...');
        try {
            const models = await client.models.list();
            console.log('✅ Available models:');
            for await (const model of models) {
                console.log(`  - ${model.id}`);
            }
        } catch (e: any) {
            console.warn('⚠️ Models endpoint не доступен (это нормально):', e.message);
        }

        // Шаг 2: Non-streaming запрос
        console.log('\nStep 2: Non-streaming chat completion...');
        const res1 = await client.chat.completions.create({
            model: 'gemini-3.1-pro-high',
            messages: [{ role: 'user', content: 'Привет! Ответь одним словом: какой сегодня день недели?' }],
            temperature: 0.3,
            max_tokens: 100,
        });
        console.log('✅ Response:', res1.choices[0]?.message?.content);
        console.log('   Tokens:', res1.usage);

        // Шаг 3: Streaming запрос
        console.log('\nStep 3: Streaming chat completion...');
        const stream = await client.chat.completions.create({
            model: 'gemini-3.1-pro-high',
            messages: [{ role: 'user', content: 'Напиши 3 факта о Москве. Кратко.' }],
            temperature: 0.7,
            max_tokens: 500,
            stream: true,
        });

        let fullText = '';
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                fullText += content;
                process.stdout.write(content);
            }
        }
        console.log('\n✅ Streaming complete, total chars:', fullText.length);

        console.log('\n🎉 ALL TESTS PASSED!');
    } catch (e: any) {
        console.error('\n❌ TEST FAILED:', e.message);
        if (e.status) console.error('   HTTP Status:', e.status);
        process.exit(1);
    }
}

testAntigravityManager();
