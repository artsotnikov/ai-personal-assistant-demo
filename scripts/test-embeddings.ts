import OpenAI from "openai";
import "dotenv/config";

async function main() {
    console.log("Testing embeddings with Antigravity Proxy...");
    const openai = new OpenAI({
        baseURL: process.env.ANTIGRAVITY_URL,
        apiKey: process.env.ANTIGRAVITY_API_KEY,
    });

    try {
        console.log("Trying model: text-embedding-004");
        const response1 = await openai.embeddings.create({
            model: "text-embedding-004", // Gemini embedding model
            input: "Hello world!",
        });
        console.log("Success with text-embedding-004! Vector size:", response1.data[0].embedding.length);
        process.exit(0);
    } catch (e: any) {
        console.error("error with text-embedding-004:", e.message);
    }

    try {
        console.log("Trying model: text-embedding-3-small");
        const response2 = await openai.embeddings.create({
            model: "text-embedding-3-small", 
            input: "Hello world!",
        });
        console.log("Success with text-embedding-3-small! Vector size:", response2.data[0].embedding.length);
        process.exit(0);
    } catch (e: any) {
        console.error("error with text-embedding-3-small:", e.message);
    }
}

main();
