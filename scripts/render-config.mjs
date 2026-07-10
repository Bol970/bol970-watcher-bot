import { writeFile } from "node:fs/promises";
import { loadDotEnv } from "./load-env.mjs";

await loadDotEnv();

const databaseId = process.env.D1_DATABASE_ID;
if (!databaseId) throw new Error("D1_DATABASE_ID is required");

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "bol970-watcher-bot",
  main: "src/index.ts",
  compatibility_date: "2026-07-10",
  workers_dev: true,
  preview_urls: true,
  observability: { enabled: true },
  triggers: { crons: ["0 * * * *"] },
  vars: {
    BOT_DISPLAY_NAME: "Bol970 Watcher",
    WORKERS_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast"
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "bol970_watcher_bot",
      database_id: databaseId
    }
  ],
  ai: { binding: "AI", remote: true }
};

await writeFile("wrangler.jsonc", `${JSON.stringify(config, null, 2)}\n`);
console.log("Rendered ignored wrangler.jsonc");
