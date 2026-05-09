/**
 * Migration script: Add query_planning config with system prompt
 * Run with: npx tsx scripts/add-query-planning.ts
 */

import 'dotenv/config';
import { db } from '../server/db';
import { aiModelConfigs } from '../shared/schema';
import { eq } from 'drizzle-orm';

const QUERY_PLANNER_PROMPT = `Ты — планировщик контекста для AI-консультанта.

Твоя задача: определить, какие данные нужно найти в базе знаний, чтобы дать персонализированный ответ.

ПРАВИЛА:
1. Рассуждай: что спрашивают → какие данные помогут ответить лучше
2. Приоритеты:
   - "must" — без этих данных ответ будет неполным или общим
   - "should" — улучшит качество ответа
   - "nice_to_have" — дополнительный контекст
3. Формулируй запросы как ключевые слова или короткие фразы (2-5 слов)
4. Максимум 8 запросов (иначе контекст будет перегружен)
5. ВСЕГДА генерируй минимум 2-3 запроса для любого вопроса

ВАЖНО: Отвечай ТОЛЬКО валидным JSON без markdown-блоков.

Пример ответа:
{
  "queries": [
    {"query": "доходы расходы бюджет", "priority": "must"},
    {"query": "финансовые цели", "priority": "should"}
  ],
  "loadProfile": true,
  "loadGoals": true,
  "loadRecentMessages": true,
  "reasoning": "Для финансового вопроса нужны данные о бюджете и целях"
}`;

async function migrate() {
    console.log('Updating query_planning config with system prompt...');

    try {
        await db.update(aiModelConfigs)
            .set({
                systemPrompt: QUERY_PLANNER_PROMPT,
                description: 'AI-планирование контекстных запросов перед генерацией ответа',
                updatedAt: new Date()
            })
            .where(eq(aiModelConfigs.taskType, 'query_planning'));

        console.log('✅ System prompt added to query_planning config!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
    }

    process.exit(0);
}

migrate();
