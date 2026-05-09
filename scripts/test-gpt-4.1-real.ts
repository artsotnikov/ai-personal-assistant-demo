
import 'dotenv/config';
import OpenAI from 'openai';

async function testGPT41MiniReal() {
    console.log('Тест РЕАЛЬНОГО вызова gpt-4.1-mini с корректными параметрами...\n');

    const client = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        timeout: 30_000, // 30 секунд как в коде
    });

    try {
        const start = Date.now();

        const response = await client.chat.completions.create({
            model: 'openai/gpt-4.1-mini',
            messages: [{ role: 'user', content: 'Привет! Как дела?' }],
            max_tokens: 100, // >= 16 как требует Azure
            temperature: 0.3,
        });

        const duration = Date.now() - start;

        console.log('✅ УСПЕХ!');
        console.log(`⏱️  Время ответа: ${duration}ms (${(duration / 1000).toFixed(1)}s)`);
        console.log(`📝 Ответ: ${response.choices[0].message.content}`);
        console.log(`🎫 Токены: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}`);

        if (duration < 30000) {
            console.log('\n✅ Модель работает БЫСТРЕЕ таймаута (30s)');
        } else {
            console.log('\n⚠️  Модель медленная, близка к таймауту');
        }

    } catch (error: any) {
        console.error('❌ ОШИБКА:', error.message);
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            console.error('   Причина: TIMEOUT (30 секунд превышен)');
        }
    }
}

testGPT41MiniReal();
