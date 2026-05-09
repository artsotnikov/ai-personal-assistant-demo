
import 'dotenv/config';

async function checkPricing() {
    console.log('Fetching OpenRouter models with pricing...\n');
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            },
        });

        const data = await response.json();

        // Filter for GPT-4o-mini models
        const gpt4oMiniModels = data.data.filter((m: any) =>
            m.id.includes('gpt-4o-mini')
        );

        console.log('=== GPT-4o-mini models ===\n');
        gpt4oMiniModels.forEach((m: any) => {
            console.log(`ID: ${m.id}`);
            console.log(`Name: ${m.name}`);
            console.log(`Prompt: $${m.pricing?.prompt || 'N/A'} / 1M tokens`);
            console.log(`Completion: $${m.pricing?.completion || 'N/A'} / 1M tokens`);
            console.log(`Context: ${m.context_length?.toLocaleString()} tokens`);
            console.log('---\n');
        });

        // Also check o1-mini for comparison
        const o1Models = data.data.filter((m: any) =>
            m.id.includes('o1-mini')
        );

        if (o1Models.length > 0) {
            console.log('=== O1-mini models (for comparison) ===\n');
            o1Models.forEach((m: any) => {
                console.log(`ID: ${m.id}`);
                console.log(`Prompt: $${m.pricing?.prompt || 'N/A'} / 1M tokens`);
                console.log(`Completion: $${m.pricing?.completion || 'N/A'} / 1M tokens`);
                console.log('---\n');
            });
        } else {
            console.log('o1-mini models: NOT AVAILABLE\n');
        }

    } catch (e) {
        console.error('Error:', e);
    }
}

checkPricing();
