import { getAIClientForTask, callWithFallback } from "../server/aiConfigService";

async function run() {
    console.log('Testing default config routing in Personal Assistant...');
    const config = await getAIClientForTask('personal_assistant' as any); // Or just 'default'
    console.log(`Resolved Provider: ${config.provider}`);
    console.log(`Resolved Model: ${config.model}`);

    console.log('Sending message: "Say the exact phrase: HELLO WORLD"');
    const result = await callWithFallback(config, [
        { role: 'user', content: 'Say the exact phrase: HELLO WORLD' }
    ]);

    console.log(`Response Model: ${result.model}`);
    console.log(`Response Provider: ${result.provider}`);
    console.log(`Content:\n${result.content}`);
    process.exit(0);
}

run().catch(console.error);
