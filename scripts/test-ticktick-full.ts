/**
 * Полный тест TickTick интеграции:
 * 1. Проверяет env variables
 * 2. Инициализирует сервис с credentials
 * 3. Загружает токены из БД
 * 4. Делает API-запросы (проекты + задачи)
 */
import "dotenv/config";
import { tickTickService } from "../server/services/tickTickService";
import { storage } from "../server/storage";

async function testTickTick() {
    console.log("=== TickTick Integration Full Test ===\n");

    // 1. Проверка env
    const clientId = process.env.TICKTICK_CLIENT_ID;
    const clientSecret = process.env.TICKTICK_CLIENT_SECRET;
    console.log(`TICKTICK_CLIENT_ID: ${clientId ? '✅ set (' + clientId.substring(0, 6) + '...)' : '❌ NOT SET'}`);
    console.log(`TICKTICK_CLIENT_SECRET: ${clientSecret ? '✅ set (' + clientSecret.substring(0, 6) + '...)' : '❌ NOT SET'}`);

    if (!clientId || !clientSecret) {
        console.error("\n❌ Credentials missing. Cannot proceed.");
        process.exit(1);
    }

    // 2. Инициализация сервиса
    console.log("\n--- Initializing TickTick Service ---");
    tickTickService.initialize({
        clientId,
        clientSecret,
        redirectUri: `${process.env.APP_URL || 'http://localhost:5000'}/api/ticktick/callback`,
        onTokensRefreshed: async (tokens) => {
            await storage.setSetting('ticktick_tokens', JSON.stringify(tokens));
            console.log('[Callback] Tokens saved to DB');
        },
        onInboxDiscovered: async (inboxId) => {
            await storage.setSetting('ticktick_inbox_id', inboxId);
            console.log(`[Callback] Inbox ID saved: ${inboxId}`);
        },
    });
    console.log(`isConfigured: ${tickTickService.isConfigured()}`);
    console.log(`isAuthenticated (before tokens): ${tickTickService.isAuthenticated()}`);

    // 3. Загрузка токенов из БД
    console.log("\n--- Loading tokens from DB ---");
    const savedTokens = await storage.getSetting('ticktick_tokens');
    if (savedTokens) {
        const tokens = JSON.parse(savedTokens);
        console.log(`Access token: ${tokens.accessToken.substring(0, 10)}...`);
        console.log(`Expires at: ${tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'not set'}`);
        const isExpired = tokens.expiresAt && Date.now() > tokens.expiresAt;
        console.log(`Token expired: ${isExpired ? '⚠️ YES' : '✅ NO'}`);
        
        tickTickService.setTokens(tokens);
        console.log(`isAuthenticated (after tokens): ${tickTickService.isAuthenticated()}`);
    } else {
        console.error("❌ No tokens in DB");
        process.exit(1);
    }

    // Загрузка Inbox ID
    const savedInboxId = await storage.getSetting('ticktick_inbox_id');
    if (savedInboxId) {
        tickTickService.setInboxId(savedInboxId);
        console.log(`Inbox ID: ${savedInboxId}`);
    }

    // 4. API-запросы
    console.log("\n--- Testing API calls ---");
    
    try {
        // Получить проекты
        const projects = await tickTickService.getProjects();
        console.log(`✅ getProjects: ${projects.length} projects`);
        for (const p of projects) {
            console.log(`   📁 ${p.name} (${p.id})`);
        }
    } catch (err: any) {
        console.error(`❌ getProjects FAILED: ${err.message}`);
    }

    try {
        // Получить задачи на сегодня
        const tasks = await tickTickService.getTasksFiltered({ dateFilter: 'today', limit: 10 });
        console.log(`\n✅ getTasksFiltered (today): ${tasks.length} tasks`);
        for (const t of tasks) {
            const prio = t.priority === 5 ? '🔴' : t.priority === 3 ? '🟡' : t.priority === 1 ? '🟢' : '⚪';
            console.log(`   ${prio} ${t.title}`);
        }
    } catch (err: any) {
        console.error(`❌ getTasksFiltered FAILED: ${err.message}`);
    }

    try {
        // Получить все задачи (лимит 5)
        const allTasks = await tickTickService.getTasksFiltered({ limit: 5 });
        console.log(`\n✅ getTasksFiltered (all, limit 5): ${allTasks.length} tasks`);
        for (const t of allTasks) {
            console.log(`   📋 ${t.title} [${t.projectId}]`);
        }
    } catch (err: any) {
        console.error(`❌ getTasksFiltered (all) FAILED: ${err.message}`);
    }

    console.log("\n=== Test Complete ===");
    process.exit(0);
}

testTickTick().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
