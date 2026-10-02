import { copyFile, access } from "node:fs/promises";
import { config } from "dotenv";
import pg from "pg";
import { migrate } from "./migrate.mjs";
for (const path of [
  ".env",
  "apps/worker/.dev.vars",
  "apps/receiver/.dev.vars",
]) {
  try {
    await access(path);
  } catch {
    await copyFile(`${path}.example`, path);
  }
}
config();
for (const url of [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL]) {
  await migrate(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // This is local setup only. Production grants are documented separately.
    await client.query(
      "GRANT USAGE ON SCHEMA public TO dispatchlab_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON demo_sessions, events, deliveries, delivery_attempts, idempotency_requests, delivery_outbox, demo_daily_usage TO dispatchlab_runtime",
    );
  } finally {
    await client.end();
  }
}
console.log("Local configuration and both databases are ready.");
