
import { db } from "../server/db";
import { expertises } from "../shared/schema";
import "dotenv/config";

async function listExpertises() {
    console.log("Listing expertises...");
    const results = await db.select().from(expertises);
    console.log(JSON.stringify(results, null, 2));
}

listExpertises().catch(console.error);
