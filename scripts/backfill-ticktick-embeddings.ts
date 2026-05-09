import "dotenv/config";
import { backfillMissingTaskEmbeddings } from "../server/embeddingService";

async function main() {
    console.log("=== Backfill TickTick Task Embeddings ===\n");
    
    const result = await backfillMissingTaskEmbeddings();
    
    console.log("\n=== Результат ===");
    console.log(`  Всего без эмбеддинга: ${result.total}`);
    console.log(`  Создано: ${result.created}`);
    console.log(`  Ошибок: ${result.failed}`);
    
    process.exit(result.failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
