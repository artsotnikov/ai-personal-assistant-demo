
import 'dotenv/config';

async function testOpenRouterModels() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('❌ OPENROUTER_API_KEY not found in .env');
        process.exit(1);
    }

    console.log('Fetching OpenRouter models...');
    const start = Date.now();
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
        });

        if (!response.ok) {
            console.error(`❌ API Error: ${response.status} ${response.statusText}`);
            console.log(await response.text());
            process.exit(1);
        }

        const data = await response.json();
        const duration = Date.now() - start;
        console.log(`✅ Success in ${duration}ms`);

        const models = data.data || [];
        console.log(`Total models found: ${models.length}`);

        // Filter for OpenAI specific models
        const openaiModels = models.filter((m: any) =>
            m.id.includes('openai') ||
            m.id.includes('gpt') ||
            (m.name && (m.name.toLowerCase().includes('gpt') || m.name.toLowerCase().includes('openai')))
        );

        console.log(`\nFound ${openaiModels.length} OpenAI-related models.`);
        console.log('Top 20 OpenAI models:');
        openaiModels.slice(0, 20).forEach((m: any) => {
            console.log(`- ${m.id} (${m.name})`);
        });

    } catch (error: any) {
        console.error('❌ Network Error:', error.message);
    }
}

testOpenRouterModels();
