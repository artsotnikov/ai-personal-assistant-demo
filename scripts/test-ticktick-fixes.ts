/**
 * Тест исправлений TickTick: поиск + завершение задачи
 * 
 * Проверяем:
 * 1. searchTasks("стоимость уколов") — должен найти задачу (ILIKE-first)
 * 2. completeTask(...) — должен завершиться без Unexpected end of JSON input
 */
import "dotenv/config";
import { tickTickService } from "../server/services/tickTickService";
import { storage } from "../server/storage";

async function testFixes() {
    console.log("=== Testing TickTick Bug Fixes ===\n");

    // Init service
    const clientId = process.env.TICKTICK_CLIENT_ID!;
    const clientSecret = process.env.TICKTICK_CLIENT_SECRET!;
    tickTickService.initialize({
        clientId,
        clientSecret,
        redirectUri: `http://localhost:5000/api/ticktick/callback`,
        onTokensRefreshed: async (tokens) => {
            await storage.setSetting('ticktick_tokens', JSON.stringify(tokens));
        },
        onInboxDiscovered: async (inboxId) => {
            await storage.setSetting('ticktick_inbox_id', inboxId);
        },
    });

    const savedTokens = await storage.getSetting('ticktick_tokens');
    if (savedTokens) {
        tickTickService.setTokens(JSON.parse(savedTokens));
    }
    const savedInboxId = await storage.getSetting('ticktick_inbox_id');
    if (savedInboxId) {
        tickTickService.setInboxId(savedInboxId);
    }

    // === TEST 1: searchTasks ===
    console.log("--- TEST 1: searchTasks('стоимость уколов') ---");
    try {
        const results = await tickTickService.searchTasks("стоимость уколов");
        if (results.length > 0) {
            console.log(`✅ PASS: Найдено ${results.length} задач:`);
            for (const t of results) {
                console.log(`   📋 "${t.title}" [${t.id}]`);
            }
        } else {
            console.log(`❌ FAIL: Задача не найдена`);
        }
    } catch (err: any) {
        console.error(`❌ FAIL: ${err.message}`);
    }

    // === TEST 2: searchTasks с частичным совпадением ===
    console.log("\n--- TEST 2: searchTasks('уколы') ---");
    try {
        const results = await tickTickService.searchTasks("уколы");
        if (results.length > 0) {
            console.log(`✅ PASS: Найдено ${results.length} задач:`);
            for (const t of results) {
                console.log(`   📋 "${t.title}" [${t.id}]`);
            }
        } else {
            console.log(`❌ FAIL: Задача не найдена`);
        }
    } catch (err: any) {
        console.error(`❌ FAIL: ${err.message}`);
    }

    // === TEST 3: completeTask (создаём тестовую задачу → завершаем) ===
    console.log("\n--- TEST 3: completeTask (create → complete) ---");
    try {
        // Создаём тестовую задачу для проверки
        const testTask = await tickTickService.createTask({
            title: "ТЕСТ: Задача для проверки complete (можно удалить)",
            projectId: savedInboxId || 'inbox',
            priority: 0,
        });
        console.log(`   Создана тестовая задача: "${testTask.title}" [${testTask.id}]`);

        // Завершаем её
        await tickTickService.completeTask(testTask.projectId, testTask.id);
        console.log(`✅ PASS: Задача завершена без ошибок`);
    } catch (err: any) {
        console.error(`❌ FAIL: ${err.message}`);
    }

    console.log("\n=== All Tests Complete ===");
    process.exit(0);
}

testFixes().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
