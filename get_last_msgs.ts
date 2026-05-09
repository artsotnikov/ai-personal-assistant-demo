
import { db, pool } from './server/db';
import { messages } from './shared/schema';
import { desc } from 'drizzle-orm';

async function main() {
  try {
    const lastMessages = await db.select()
      .from(messages)
      .orderBy(desc(messages.id))
      .limit(20);

    console.log(JSON.stringify(lastMessages.reverse(), null, 2));
  } catch (error) {
    console.error('Error fetching messages:', error);
  } finally {
    await pool.end();
  }
}

main();
