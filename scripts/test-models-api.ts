import 'dotenv/config';

async function testModelsAPI() {
    const testCases = [
        { provider: 'deepseek', name: 'DeepSeek' },
        { provider: 'openrouter', name: 'OpenRouter' },
        { provider: 'openai', name: 'OpenAI' },
        { provider: 'custom', name: 'Custom' },
    ];

    for (const { provider, name } of testCases) {
        console.log(`\n=== Testing ${name} (${provider}) ===`);
        try {
            const response = await fetch(`http://localhost:5000/api/ai/models?provider=${provider}`);

            if (!response.ok) {
                console.error(`❌ HTTP ${response.status}: ${response.statusText}`);
                continue;
            }

            const models = await response.json();
            console.log(`✅ Получено моделей: ${models.length}`);

            if (models.length > 0) {
                console.log(`Первые 5: ${models.slice(0, 5).map((m: any) => m.id).join(', ')}`);
            }
        } catch (error: any) {
            console.error(`❌ Ошибка: ${error.message}`);
        }
    }
}

testModelsAPI();
