import "dotenv/config";
import { createEmbedding } from "../server/embeddingService";

async function main() {
    console.log("=== Testing Embeddings System ===");
    console.log("Checking API keys in process.env:");
    console.log("- OPENROUTER_API_KEY:", process.env.OPENROUTER_API_KEY ? "YES" : "NO");
    console.log("- OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "YES" : "NO");
    
    try {
        console.log("\nAttempting to create embedding...");
        const vector = await createEmbedding("Тестовый текст для генерации вектора");
        console.log(`✅ Success! Vector dimension: ${vector.length}`);
        
        if (vector.length === 1536) {
            console.log("✅ Expected text-embedding-3-small dimension (1536) confirmed.");
        } else {
            console.warn(`⚠️ Warning: Expected dimension 1536, got ${vector.length}`);
        }
    } catch (e: any) {
        console.error("❌ Failed to create embedding:", e.message || e);
    }
}

main().catch(console.error);
