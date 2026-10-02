import "dotenv/config";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
export async function migrate(databaseUrl) {
  if (!databaseUrl)
    throw new Error("Set DATABASE_URL to a migration-owner connection.");
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL("../packages/db/migrations/", import.meta.url)),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate(process.env.DATABASE_URL);
  console.log("Database migrations applied.");
}
