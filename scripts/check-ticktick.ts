
import { tickTickService } from "../server/services/tickTickService";
import { storage } from "../server/storage";
import "dotenv/config";

async function checkTickTick() {
    console.log("Checking TickTick status...");
    
    const clientId = process.env.TICKTICK_CLIENT_ID;
    const clientSecret = process.env.TICKTICK_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        console.error("❌ TICKTICK_CLIENT_ID or TICKTICK_CLIENT_SECRET is NOT set in environment!");
        return;
    }
    
    console.log("✅ Client ID and Secret are set.");
    
    tickTickService.initialize({
        clientId,
        clientSecret,
        redirectUri: "http://localhost:5000/api/ticktick/callback", // dummy
    });
    
    const savedTokens = await storage.getSetting('ticktick_tokens');
    if (savedTokens) {
        console.log("✅ Tokens found in database.");
        try {
            const tokens = JSON.parse(savedTokens);
            tickTickService.setTokens(tokens);
            
            console.log("Testing connection...");
            const status = await tickTickService.validateConnection();
            console.log("Status:", status);
        } catch (e) {
            console.error("❌ Error parsing tokens or validating connection:", e);
        }
    } else {
        console.error("❌ No tokens found in database!");
    }
}

checkTickTick().catch(console.error);
