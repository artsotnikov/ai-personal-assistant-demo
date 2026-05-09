import "dotenv/config";
import { db, pool } from "../server/db";
import fs from "fs";
import path from "path";

async function run() {
    try {
        const sqlContent = `
        DROP TABLE IF EXISTS "entity_relations";
        DROP TABLE IF EXISTS "entity_attributes";
        `;
        console.log("Executing DROP TABLE commands...");
        await pool.query(sqlContent);
        console.log("Successfully dropped V1 tables.");
    } catch (error) {
        console.error("Migration failed:", error);
    } finally {
        process.exit(0);
    }
}

run();
