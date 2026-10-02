import "dotenv/config";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runner } from "node-pg-migrate";
import { createServer } from "node:http";
import { Database, type Claim } from "@dispatchlab/db";
import {
  AppError,
  hash,
  type DeliveryMessage,
  type Receiver,
  type Result,
} from "@dispatchlab/core";
import {
  processDelivery,
  publish,
  send,
  type QueuePort,
} from "../../apps/worker/src/delivery";
import receiver from "../../apps/receiver/src/index";
import worker, { type Env } from "../../apps/worker/src/index";
import { api } from "../../apps/worker/src/api";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://dispatchlab_owner:local-only-owner@127.0.0.1:55439/dispatchlab_test";
if (!new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "Integration tests require a separate database ending in _test.",
  );
const db = new Database(url);
const secret = "integration-signing-secret-at-least-24-characters";
const success: Result = {
  status: 200,
  durationMs: 10,
  excerpt: "accepted",
  error: null,
  retryAfter: null,
};
const failure: Result = { ...success, status: 503, error: "http_error" };
const port = {
  fetch: (request: Request) =>
    receiver.fetch(request, { SIGNING_SECRET: secret }),
};
function queue() {
  const messages: DeliveryMessage[] = [];
  const delays: number[] = [];
  return {
    messages,
    delays,
    send: async (m: DeliveryMessage, options?: { delaySeconds: number }) => {
      messages.push(m);
      delays.push(options?.delaySeconds ?? 0);
    },
  };
}
async function session() {
  return db.createSession(await hash(crypto.randomUUID()));
}
async function event(
  owner: string,
  r: Receiver = { behaviour: "always_succeed" },
  key = crypto.randomUUID(),
) {
  return db.ingest(owner, key, {
    eventType: "test.event",
    payload: { fictional: true },
    receiver: r,
  });
}
async function due(id: string) {
  await db.connect((c) =>
    c.query(
      "UPDATE deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [id],
    ),
  );
}
async function expired(id: string) {
  await db.connect((c) =>
    c.query(
      "UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE id=$1",
      [id],
    ),
  );
}
async function claim(id: string, generation = 1): Promise<Claim> {
  const result = await db.claim({ deliveryId: id, generation });
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed") throw new Error("Expected a claim");
  return result.claim;
}
beforeAll(async () => {
  await runner({
    databaseUrl: url,
    dir: "packages/db/migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
  await runner({
    databaseUrl: url,
    dir: "packages/db/migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
});
beforeEach(async () => {
  await db.connect((c) =>
    c.query("TRUNCATE demo_sessions, demo_daily_usage CASCADE"),
  );
});

describe("durable admission", () => {
  it("migrates once and atomically persists all ingestion records", async () => {
    const owner = await session();
    const a = await event(owner);
    const counts = await db.connect(
      async (c) =>
        (
          await c.query(
            "SELECT (SELECT count(*) FROM pgmigrations) AS migrations,(SELECT count(*) FROM events) AS events,(SELECT count(*) FROM delivery_outbox) AS outbox,(SELECT count(*) FROM idempotency_requests) AS keys",
          )
        ).rows[0],
    );
    expect(counts).toEqual({
      migrations: "3",
      events: "1",
      outbox: "1",
      keys: "1",
    });
    expect((await db.detail(owner, a.deliveryId)).delivery.state).toBe(
      "pending",
    );
  });
  it("deduplicates simultaneous identical requests and rejects a different fingerprint", async () => {
    const owner = await session();
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        event(owner, { behaviour: "always_succeed" }, key),
      ),
    );
    expect(new Set(results.map((v) => v.deliveryId)).size).toBe(1);
    expect(results.filter((v) => !v.deduplicated)).toHaveLength(1);
    await expect(
      event(owner, { behaviour: "always_fail" }, key),
    ).rejects.toMatchObject({ status: 409 });
    expect((await db.list(owner)).deliveries).toHaveLength(1);
  });
  it("rolls back quota changes and event creation if the transaction fails", async () => {
    const owner = await session();
    await expect(
      db.admit(owner, "test", "rollback_key", "fingerprint", async (c) => {
        await c.query(
          "INSERT INTO events(id,session_id,event_type,payload) VALUES($1,$2,$3,$4)",
          [crypto.randomUUID(), owner, "test", "{}"],
        );
        throw new Error("simulated crash");
      }),
    ).rejects.toThrow("simulated crash");
    const counts = await db.connect(
      async (c) =>
        (
          await c.query(
            "SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM demo_daily_usage) AS days,(SELECT delivery_count FROM demo_sessions LIMIT 1) AS deliveries",
          )
        ).rows[0],
    );
    expect(counts).toEqual({ events: "0", days: "1", deliveries: 0 });
  });
  it("enforces exact session and global quotas, including concurrent admission", async () => {
    const owner = await session();
    await db.connect((c) =>
      c.query("UPDATE demo_sessions SET delivery_count=9 WHERE id=$1", [owner]),
    );
    const r = await Promise.allSettled([event(owner), event(owner)]);
    expect(r.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    await db.connect((c) =>
      c.query(
        "UPDATE demo_daily_usage SET delivery_count=49 WHERE day=(now() AT TIME ZONE 'UTC')::date",
      ),
    );
    const a = await session();
    const b = await session();
    const global = await Promise.allSettled([event(a), event(b)]);
    expect(global.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(global.filter((v) => v.status === "rejected")).toHaveLength(1);
  });
  it("bounds anonymous session creation independently of event admission", async () => {
    await session();
    await db.connect((c) =>
      c.query("UPDATE demo_daily_usage SET session_count=199"),
    );
    const results = await Promise.allSettled([session(), session()]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((v) => v.status === "rejected")).toHaveLength(1);
  });
  it("isolates owners, protects history, and purges expired records", async () => {
    const owner = await session();
    const other = await session();
    const a = await event(owner);
    await expect(db.detail(other, a.deliveryId)).rejects.toMatchObject({
      status: 404,
    });
    expect((await db.list(other)).deliveries).toHaveLength(0);
    await expect(
      db.connect((c) =>
        c.query("UPDATE events SET payload='{}' WHERE id=$1", [a.eventId]),
      ),
    ).rejects.toThrow("Events are immutable");
    const c = await claim(a.deliveryId);
    await db.finish(c, success);
    await expect(
      db.connect((c) =>
        c.query(
          "UPDATE delivery_attempts SET outcome='failed' WHERE delivery_id=$1",
          [a.deliveryId],
        ),
      ),
    ).rejects.toThrow("Completed attempts are immutable");
    await db.connect((c) =>
      c.query(
        "UPDATE demo_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [owner],
      ),
    );
    await db.recover();
    expect(await db.claim({ deliveryId: a.deliveryId, generation: 1 })).toEqual(
      { kind: "skip" },
    );
    expect(
      (await db.connect((c) => c.query("SELECT * FROM delivery_outbox"))).rows,
    ).toHaveLength(0);
  });
});

describe("claims, retries, and recovery", () => {
  it("allows one concurrent claim and ignores duplicate completed messages", async () => {
    const owner = await session();
    const a = await event(owner);
    const results = await Promise.all([
      db.claim({ deliveryId: a.deliveryId, generation: 1 }),
      db.claim({ deliveryId: a.deliveryId, generation: 1 }),
    ]);
    expect(results.filter((v) => v.kind === "claimed")).toHaveLength(1);
    expect(results.filter((v) => v.kind === "wait")).toHaveLength(1);
    const c = results.find((v) => v.kind === "claimed");
    if (!c || c.kind !== "claimed") throw new Error("Missing claim");
    await db.finish(c.claim, success);
    const q = queue();
    await processDelivery(db, q, port, secret, {
      deliveryId: a.deliveryId,
      generation: 1,
    });
    expect((await db.detail(owner, a.deliveryId)).attempts).toHaveLength(1);
    expect(q.messages).toHaveLength(0);
  });
  it("does not send an early or obsolete message", async () => {
    const owner = await session();
    const a = await event(owner);
    await db.finish(await claim(a.deliveryId), failure, () => 0.999);
    expect(
      (await db.claim({ deliveryId: a.deliveryId, generation: 1 })).kind,
    ).toBe("skip");
    expect(
      (await db.claim({ deliveryId: a.deliveryId, generation: 2 })).kind,
    ).toBe("wait");
    expect((await db.detail(owner, a.deliveryId)).attempts).toHaveLength(1);
  });
  it("runs configured failures to signed success through the delivery handler", async () => {
    const owner = await session();
    const a = await event(owner, {
      behaviour: "fail_then_succeed",
      failures: 2,
    });
    const q = queue();
    await publish(db, q, a.deliveryId);
    for (let n = 0; n < 3; n++) {
      const message = q.messages[n];
      expect(message).toBeDefined();
      await due(a.deliveryId);
      await processDelivery(db, q, port, secret, message);
    }
    const detail = await db.detail(owner, a.deliveryId);
    expect(detail.delivery.state).toBe("succeeded");
    expect(detail.attempts.map((v) => v.http_status)).toEqual([503, 503, 200]);
    expect(detail.attempts[2].response_excerpt).toContain(
      '"signatureVerified":true',
    );
    expect(q.delays[1]).toBeGreaterThanOrEqual(1);
  });
  it("exhausts five attempts and terminates non-retryable rejections immediately", async () => {
    const owner = await session();
    const a = await event(owner, { behaviour: "always_fail" });
    for (let n = 1; n <= 5; n++) {
      await due(a.deliveryId);
      await db.finish(await claim(a.deliveryId, n), failure, () => 0);
    }
    expect((await db.detail(owner, a.deliveryId)).delivery).toMatchObject({
      state: "dead_lettered",
      final_reason: "attempts_exhausted",
      attempt_count: 5,
    });
    const b = await event(owner);
    await db.finish(await claim(b.deliveryId), { ...failure, status: 400 });
    expect((await db.detail(owner, b.deliveryId)).delivery).toMatchObject({
      state: "dead_lettered",
      final_reason: "permanent_rejection",
      attempt_count: 1,
    });
  });
  it("recovers crashes before sending and fences the abandoned worker", async () => {
    const owner = await session();
    const a = await event(owner);
    const old = await claim(a.deliveryId);
    await expired(a.deliveryId);
    await db.recover();
    expect(await db.finish(old, success)).toBe(false);
    await due(a.deliveryId);
    const next = await claim(a.deliveryId, 2);
    await db.finish(next, success);
    expect(
      (await db.detail(owner, a.deliveryId)).attempts.map((v) => v.outcome),
    ).toEqual(["interrupted", "succeeded"]);
  });
  it("preserves an unknown outcome after receiver acceptance and permits duplicate receipt", async () => {
    const owner = await session();
    const a = await event(owner);
    const old = await claim(a.deliveryId);
    expect((await send(old, port, secret)).status).toBe(200); // Crash before recording the receiver's acceptance.
    await expired(a.deliveryId);
    await db.recover();
    await due(a.deliveryId);
    const next = await claim(a.deliveryId, 2);
    await db.finish(next, await send(next, port, secret));
    const detail = await db.detail(owner, a.deliveryId);
    expect(detail.attempts[0]).toMatchObject({
      outcome: "interrupted",
      http_status: null,
    });
    expect(detail.attempts[1].http_status).toBe(200);
  });
  it("rolls back finalisation if recording the attempt fails", async () => {
    const owner = await session();
    const a = await event(owner);
    const c = await claim(a.deliveryId);
    await db.connect((c) =>
      c.query(
        "CREATE FUNCTION reject_test_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$; CREATE TRIGGER test_reject BEFORE UPDATE ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION reject_test_attempt()",
      ),
    );
    try {
      await expect(db.finish(c, success)).rejects.toThrow(
        "injected database failure",
      );
    } finally {
      await db.connect((c) =>
        c.query(
          "DROP TRIGGER test_reject ON delivery_attempts; DROP FUNCTION reject_test_attempt()",
        ),
      );
    }
    expect((await db.detail(owner, a.deliveryId)).attempts[0].outcome).toBe(
      "started",
    );
    await expired(a.deliveryId);
    await db.recover();
    expect((await db.detail(owner, a.deliveryId)).attempts[0].outcome).toBe(
      "interrupted",
    );
  });
  it("persists delayed rate-limit scheduling once", async () => {
    const owner = await session();
    const a = await event(owner, { behaviour: "rate_limit" });
    const q = queue();
    await processDelivery(db, q, port, secret, {
      deliveryId: a.deliveryId,
      generation: 1,
    });
    const original = await db.detail(owner, a.deliveryId);
    expect(q.delays[0]).toBe(5);
    await processDelivery(db, q, port, secret, {
      deliveryId: a.deliveryId,
      generation: 1,
    });
    expect(
      (await db.detail(owner, a.deliveryId)).delivery.next_attempt_at,
    ).toBe(original.delivery.next_attempt_at);
  });
  it("recovers queue-publication failure without losing accepted events", async () => {
    const owner = await session();
    const a = await event(owner);
    const unavailable: QueuePort = {
      send: async () => {
        throw new Error("queue down");
      },
    };
    expect(await publish(db, unavailable, a.deliveryId)).toBe(false);
    expect((await db.detail(owner, a.deliveryId)).delivery.state).toBe(
      "pending",
    );
    const q = queue();
    expect(await publish(db, q, a.deliveryId)).toBe(true);
    expect(q.messages).toHaveLength(1);
  });
  it("handles send/record crashes and bounded infrastructure stalling", async () => {
    const owner = await session();
    const a = await event(owner);
    const publication = await db.publication(a.deliveryId);
    expect(publication).not.toBeNull();
    await db.connect((c) =>
      c.query(
        "UPDATE delivery_outbox SET lease_until=now()-interval '1 second' WHERE delivery_id=$1",
        [a.deliveryId],
      ),
    );
    const q = queue();
    await publish(db, q, a.deliveryId);
    expect(q.messages).toHaveLength(1);
    await db.connect((c) =>
      c.query(
        "UPDATE delivery_outbox SET publish_count=3,published_at=now()-interval '2 minutes',eligible_at=now()-interval '2 minutes' WHERE delivery_id=$1",
        [a.deliveryId],
      ),
    );
    await db.recover();
    expect((await db.detail(owner, a.deliveryId)).delivery.final_reason).toBe(
      "infrastructure_stalled",
    );
  });
  it("republishes lost notifications only after the recovery grace period", async () => {
    const owner = await session();
    const a = await event(owner);
    const q = queue();
    await publish(db, q, a.deliveryId);
    expect(await db.publication(a.deliveryId, true)).toBeNull();
    await db.connect((c) =>
      c.query(
        "UPDATE delivery_outbox SET published_at=now()-interval '2 minutes',eligible_at=now()-interval '2 minutes' WHERE delivery_id=$1",
        [a.deliveryId],
      ),
    );
    await publish(db, q, a.deliveryId, true);
    expect(q.messages).toHaveLength(2);
  });
  it("tests a normal HTTP transport and response truncation", async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const r = await receiver.fetch(
        new Request("https://receiver.internal/webhook", {
          method: "POST",
          headers,
          body: Buffer.concat(chunks).toString(),
        }),
        { SIGNING_SECRET: secret },
      );
      res.writeHead(r.status);
      res.end(await r.text());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const owner = await session();
      const a = await event(owner);
      const c = await claim(a.deliveryId);
      const r = await send(
        c,
        {
          fetch: (req) =>
            fetch(`http://127.0.0.1:${address.port}/webhook`, {
              method: req.method,
              headers: req.headers,
              body: req.body,
              duplex: "half",
              signal: req.signal,
            } as RequestInit),
        },
        secret,
      );
      expect(r.status).toBe(200);
      expect(r.excerpt).toContain("signatureVerified");
      const large = await send(
        c,
        { fetch: async () => new Response("x".repeat(9000)) },
        secret,
      );
      expect(large.excerpt.length).toBe(2048);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
  it("enforces the timeout even when the receiver ignores cancellation", async () => {
    const owner = await session();
    const a = await event(owner, { behaviour: "timeout" });
    const c = await claim(a.deliveryId);
    const r = await send(c, port, secret);
    expect(r.error).toBe("timeout");
    expect(r.status).toBeNull();
    expect(r.durationMs).toBeGreaterThanOrEqual(2900);
  });
});

describe("replay", () => {
  it("preserves original history, deduplicates replay, and limits the whole chain", async () => {
    const owner = await session();
    const a = await event(owner);
    await db.finish(await claim(a.deliveryId), success);
    const key = crypto.randomUUID();
    const results = await Promise.all([
      db.replay(owner, key, a.deliveryId, true),
      db.replay(owner, key, a.deliveryId, true),
    ]);
    expect(results[0].deliveryId).toBe(results[1].deliveryId);
    expect(results[0].eventId).toBe(a.eventId);
    const b = results[0];
    const original = await db.detail(owner, a.deliveryId);
    const replayed = await db.detail(owner, b.deliveryId);
    expect(original.attempts).toHaveLength(1);
    expect(replayed.attempts).toHaveLength(0);
    expect(replayed.delivery.replay_parent_id).toBe(a.deliveryId);
    expect(replayed.event.payload).toEqual(original.event.payload);
    await db.finish(await claim(b.deliveryId), success);
    const c = await db.replay(owner, crypto.randomUUID(), b.deliveryId, false);
    await db.finish(await claim(c.deliveryId), success);
    await expect(
      db.replay(owner, crypto.randomUUID(), c.deliveryId, false),
    ).rejects.toMatchObject({ code: "replay_limit" });
  });
  it("rejects active deliveries and cross-event replay lineage", async () => {
    const owner = await session();
    const a = await event(owner);
    const b = await event(owner);
    await expect(
      db.replay(owner, crypto.randomUUID(), a.deliveryId, false),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db.connect((c) =>
        c.query("UPDATE deliveries SET replay_parent_id=$1 WHERE id=$2", [
          a.deliveryId,
          b.deliveryId,
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe("API and queue boundaries", () => {
  function env(): Env {
    return {
      DATABASE_URL: url,
      SIGNING_SECRET: secret,
      MODE: "hosted",
      DEMO_PAUSED: "false",
      DELIVERY_QUEUE: queue(),
      RECEIVER: port,
      ASSETS: {
        fetch: async () => new Response("assets"),
      } as unknown as Fetcher,
      MUTATION_LIMITER: { limit: async () => ({ success: true }) },
      READ_LIMITER: { limit: async () => ({ success: true }) },
    };
  }
  async function request(
    environment: Env,
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    extra: Record<string, string> = {},
  ) {
    const tasks: Promise<unknown>[] = [];
    const r = await api(
      new Request(`https://dispatchlab.test/api${path}`, {
        method,
        headers: {
          Origin: "https://dispatchlab.test",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      environment,
      { waitUntil: (p) => tasks.push(p) },
    );
    await Promise.all(tasks);
    return r;
  }
  it("sets a secure capability cookie and accepts only presets in hosted mode", async () => {
    const environment = env();
    const start = await request(environment, "/session", "POST", {});
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const bad = await request(
      environment,
      "/events",
      "POST",
      {
        eventType: "test",
        payload: {},
        receiver: { behaviour: "always_succeed" },
      },
      cookie,
      { "Idempotency-Key": "test_hosted_123" },
    );
    expect(bad.status).toBe(400);
    const good = await request(
      environment,
      "/events",
      "POST",
      { sampleId: "order", receiver: { behaviour: "always_succeed" } },
      cookie,
      { "Idempotency-Key": "test_hosted_123" },
    );
    expect(good.status).toBe(202);
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    const unknown = await request(
      environment,
      `/deliveries/${crypto.randomUUID()}`,
      "GET",
      undefined,
      cookie,
    );
    expect(unknown.status).toBe(404);
  });
  it("enforces origin, body size, rate limits, pause, cursors, and graceful DB failure", async () => {
    const environment = env();
    expect(
      (
        await request(environment, "/session", "POST", {}, undefined, {
          Origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(environment, "/session", "POST", {
          oversized: "a".repeat(17000),
        })
      ).status,
    ).toBe(413);
    environment.MUTATION_LIMITER = { limit: async () => ({ success: false }) };
    expect((await request(environment, "/session", "POST", {})).status).toBe(
      429,
    );
    environment.DEMO_PAUSED = "true";
    expect((await request(environment, "/session", "POST", {})).status).toBe(
      503,
    );
    const healthy = env();
    const cookie = (await request(healthy, "/session", "POST", {})).headers.get(
      "set-cookie",
    )!;
    expect(
      (
        await request(
          healthy,
          "/deliveries?cursor=invalid",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(400);
    healthy.DATABASE_URL =
      "postgresql://invalid:invalid@127.0.0.1:1/dispatchlab_test";
    const r = await request(healthy, "/deliveries", "GET", undefined, cookie);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("postgresql");
  });
  it("acknowledges completed/invalid messages and retries execution failures", async () => {
    const environment = env();
    let ack = 0;
    let retry = 0;
    const batch = {
      messages: [
        { body: { invalid: true }, ack: () => ack++, retry: () => retry++ },
      ],
    } as unknown as MessageBatch<DeliveryMessage>;
    await worker.queue(batch, environment);
    expect(ack).toBe(1);
    const owner = await session();
    const a = await event(owner);
    const valid = {
      messages: [
        {
          body: { deliveryId: a.deliveryId, generation: 1 },
          ack: () => ack++,
          retry: () => retry++,
        },
      ],
    } as unknown as MessageBatch<DeliveryMessage>;
    await worker.queue(valid, environment);
    expect(ack).toBe(2);
    environment.DATABASE_URL =
      "postgresql://invalid:invalid@127.0.0.1:1/dispatchlab_test";
    await worker.queue(valid, environment);
    expect(retry).toBe(1);
  });
  it("uses structured safe errors", () => {
    expect(new AppError(409, "conflict", "Safe message").code).toBe("conflict");
  });
});
