
import 'dotenv/config';

async function checkModelAvailability() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('❌ OPENROUTER_API_KEY not found');
        process.exit(1);
    }

    console.log('Fetching OpenRouter models...');
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });

        if (!response.ok) process.exit(1);

        const data = await response.json();
        const models = data.data || [];

        const targets = [
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'openai/gpt-4-turbo',
            'openai/gpt-3.5-turbo',
            'openai/o1-preview',
            'openai/o1-mini'
        ];

        console.log('\nChecking specific models:');
        targets.forEach(target => {
            const found = models.find((m: any) => m.id === target);
            console.log(`${found ? '✅' : '❌'} ${target}`);
        });

    } catch (error) {
        console.error('Error:', error);
    }
}

checkModelAvailability();
