
import { db } from "../server/db";
import { appSettings } from "../shared/schema";
import "dotenv/config";

async function listSettings() {
    console.log("Listing app settings...");
    const settings = await db.select().from(appSettings);
    console.log(JSON.stringify(settings, null, 2));
}

listSettings().catch(console.error);
