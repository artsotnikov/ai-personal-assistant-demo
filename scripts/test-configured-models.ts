
import 'dotenv/config';
import { getAIClientForTask, callWithFallback } from '../server/aiConfigService';

async function testTask(taskType: any) {
  try {
    console.log(`\n--- Testing task: ${taskType} ---`);
    const config = await getAIClientForTask(taskType);
    console.log(`Model: ${config.provider}/${config.model}`);
    
    const messages = [
      { role: 'system' as const, content: 'You are a test assistant.' },
      { role: 'user' as const, content: 'Tell me a joke.' }
    ];
    
    const result = await callWithFallback(config, messages);
    console.log(`Success! Response length: ${result.content.length}`);
    console.log(`Preview: ${result.content.substring(0, 100)}...`);
    console.log(`Tokens used: ${result.tokensUsed}`);
  } catch (error: any) {
    console.error(`Error for ${taskType}:`, error.message);
    if (error.response) {
       console.error('Response data:', error.response.data);
    }
  }
}

async function main() {
  await testTask('agent_core');
  await testTask('agent_final_answer');
}

main().catch(console.error);
