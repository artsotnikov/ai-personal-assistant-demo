
import 'dotenv/config';

async function checkGPT41Mini() {
    console.log('Checking gpt-4.1-mini model...\n');
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            },
        });

        const data = await response.json();

        // Find exact model
        const model41 = data.data.find((m: any) => m.id === 'openai/gpt-4.1-mini');

        if (model41) {
            console.log('✅ МОДЕЛЬ НАЙДЕНА!\n');
            console.log('ID:', model41.id);
            console.log('Name:', model41.name);
            console.log('Description:', model41.description || 'N/A');
            console.log('\nPricing:');
            console.log('  Prompt: $' + model41.pricing?.prompt + ' / 1M tokens');
            console.log('  Completion: $' + model41.pricing?.completion + ' / 1M tokens');
            console.log('\nContext:', model41.context_length?.toLocaleString(), 'tokens');
            console.log('\nArchitecture:', JSON.stringify(model41.architecture, null, 2));
        } else {
            console.log('❌ Модель openai/gpt-4.1-mini НЕ НАЙДЕНА в API');

            // Search for similar
            const similar = data.data.filter((m: any) =>
                m.id.includes('4.1') || m.id.includes('o1')
            );
            console.log('\nПохожие модели:');
            similar.forEach((m: any) => {
                console.log(`  - ${m.id} (${m.name})`);
            });
        }

        // Test if model is actually callable
        console.log('\n\n=== ТЕСТ ВЫЗОВА МОДЕЛИ ===\n');

        const testResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'openai/gpt-4.1-mini',
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 10,
            }),
        });

        if (testResponse.ok) {
            const result = await testResponse.json();
            console.log('✅ Модель РАБОТАЕТ!');
            console.log('Response:', result.choices[0].message.content);
        } else {
            console.log('❌ Ошибка вызова модели:');
            console.log('Status:', testResponse.status, testResponse.statusText);
            const errorText = await testResponse.text();
            console.log('Error:', errorText);
        }

    } catch (e) {
        console.error('Error:', e);
    }
}

checkGPT41Mini();
