import 'dotenv/config';
import OpenAI from 'openai';

async function testFallback() {
    const baseURL = process.env.CUSTOM_API_URL;
    const apiKey = process.env.CUSTOM_API_KEY;
    const model = 'gemini-3-flash';

    console.log('Testing Fallback Configuration:');
    console.log(`URL: ${baseURL}`);
    console.log(`Key: ${apiKey ? 'Found (starts with ' + apiKey.substring(0, 3) + '...)' : 'Missing'}`);
    console.log(`Model: ${model}`);

    if (!baseURL || !apiKey) {
        console.error('❌ Missing CUSTOM_API_URL or CUSTOM_API_KEY in .env');
        process.exit(1);
    }

    const client = new OpenAI({
        baseURL,
        apiKey,
    });

    try {
        console.log('\nSending test request...');
        const start = Date.now();
        const response = await client.chat.completions.create({
            model,
            messages: [
                { role: 'user', content: 'Hello! Are you working? Reply with "Yes, I am Gemini".' }
            ],
            max_tokens: 50,
        });
        const duration = Date.now() - start;

        console.log(`\n✅ Success! (${duration}ms)`);
        console.log('Response:', response.choices[0]?.message?.content);
    } catch (error: any) {
        console.error('\n❌ Request failed:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
        process.exit(1);
    }
}

testFallback();
