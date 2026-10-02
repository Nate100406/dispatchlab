# Hosted demo and recovery runbook

## Provision a free demo

1. Use Neon Free with PostgreSQL 17, minimum compute and scale-to-zero. Record a direct **owner** URL for migrations and a pooled **runtime** URL. No keep-alive job.
2. Create a `dispatchlab_runtime` LOGIN role with a generated password, USAGE on public, and SELECT/INSERT/UPDATE/DELETE only on the seven application tables. It must not own the database or schema. Revoke CREATE on public from PUBLIC if inherited. Keep migrations table and DDL privileges with the owner.
3. Create one Cloudflare Queue: `npx wrangler queues create dispatchlab-deliveries`. Stay on Workers Free. Free queue retention is 24 hours; verify current allowances before launch.
4. Generate a signing secret (at least 32 random bytes). Set SIGNING_SECRET with `wrangler secret put` on **both** Workers using their respective configs. Set DATABASE_URL only on the DispatchLab Worker to the pooled runtime connection. Never use local examples in production.
5. Apply migrations using the owner's direct URL (`DATABASE_URL=… npm run db:migrate`). Grant runtime access after migrations using owner SQL. Production credentials never enter `.dev.vars`, source, logs, or screenshots.
6. Deploy the receiver first, then DispatchLab. The receiver config disables workers.dev and preview URLs and has no routes; audit the account for any manually added receiver domains/routes and remove them. MODE defaults to hosted; local `.dev.vars` is not deployed. Use the main Worker's free workers.dev URL.
7. The manual GitHub deploy workflow requires a successful CI run for its exact commit, Cloudflare account/token secrets and MIGRATION_DATABASE_URL. Worker runtime/signing secrets must already exist in Cloudflare. Configure the production environment review rules as desired.

Example owner grants (after migrations):

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO dispatchlab_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
 demo_sessions, events, deliveries, delivery_attempts,
 idempotency_requests, delivery_outbox, demo_daily_usage
TO dispatchlab_runtime;
```

Use TLS for Neon connections; do not disable certificate verification. Runtime drivers open invocation-scoped connections and close them. Migrations use a direct connection because their advisory lock is session-scoped.

## Hosted smoke gate

- Health reports configured; static dashboard and inspector work with no browser errors.
- Fail twice: 503, 503, 200 with verified signature; always fail: five attempts, final failure; replay to success preserves original history.
- Timeout and 429 behave as documented. Hosted JSON input and URL/header injection are rejected. Another browser session cannot inspect a delivery.
- Receiver has no public/preview/custom routes. Production secret values are not local examples.
- Session/delivery quotas and 24-hour cleanup are verified in an isolated deployment/database. Do not exhaust the public demo's budget merely to test it.
- Inspect actual Workers CPU usage and Neon compute usage against current free-plan limits. Local runtime tests cannot establish hosted CPU feasibility or SLA. Keep free plans; simplify hotspots rather than silently upgrading.

## Diagnose and recover

Search structured logs by delivery ID. Use the delivery timeline and final reason first. `worker_interrupted` means receiver outcome unknown; `infrastructure_stalled` means bounded publication failed to produce progress; `attempts_exhausted` means the application budget ended.

Recovery runs every 30 minutes and performs bounded batches. Locally invoke it with `curl http://localhost:8787/__scheduled` (the local-only Wrangler scheduled-test endpoint). No public application recovery/fault endpoint exists. Restoring the queue/database lets the next sweep resume eligible work. Terminal failures require replay. Replay may duplicate receiver effects; inspect before performing it.

To pause anonymous API access, set DEMO_PAUSED=true through Worker configuration and redeploy. In-flight bounded deliveries still complete. Provider limits may suspend availability without charging when on free plans. Never enable paid overages as an automatic fallback.

Prefer forward migrations. Keep already-applied migration files unchanged. Build/release should be additive to existing state; a worker rollback does not reverse schema. Back up before destructive owner operations. Local `docker compose down --volumes` is deliberately destructive and is never a production recovery method.
