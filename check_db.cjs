
require('dotenv').config();
const { Client } = require('pg');


async function main() {
    // Try common env names if DATABASE_URL is not found directly
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('DATABASE_URL not found in env');
        return;
    }

    const client = new Client({ 
        connectionString: dbUrl,
        ssl: dbUrl.includes('neon') ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        
        // Find last conversation
        const convRes = await client.query('SELECT id, title FROM conversations ORDER BY last_message_time DESC LIMIT 1');
        if (convRes.rows.length === 0) {
            console.log('No conversations found');
            return;
        }
        
        const convId = convRes.rows[0].id;
        console.log(`Found last conversation: ${convRes.rows[0].title} (ID: ${convId})`);
        
        // Get last messages
        const msgRes = await client.query(`
            SELECT id, sender, content, type 
            FROM messages 
            ORDER BY id DESC 
            LIMIT 10
        `);
        
        console.log('--- LAST 10 MESSAGES ---');
        msgRes.rows.reverse().forEach(row => {
            console.log(`[${row.sender}] ${row.content.substring(0, 200)}...`);
        });

        // Get last tool calls
        const toolRes = await client.query(`
            SELECT tool_name, success, displayText 
            FROM tool_call_logs 
            ORDER BY id DESC 
            LIMIT 5
        `);
        console.log('--- LAST 5 TOOL CALLS ---');
        toolRes.rows.forEach(row => {
            console.log(`${row.tool_name} (Success: ${row.success}): ${row.displayText?.substring(0, 100)}...`);
        });

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

main();
