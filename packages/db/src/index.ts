import pg, { type Client } from "pg";
import {
  AppError,
  DAILY_LIMIT,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  SESSION_LIMIT,
  canonical,
  hash,
  retryDelay,
  settlement,
  terminal,
  type Accepted,
  type Delivery,
  type DeliveryMessage,
  type Detail,
  type EventInput,
  type EventRecord,
  type Receiver,
  type Result,
} from "@dispatchlab/core";

type DeliveryRow = Omit<
  Delivery,
  "created_at" | "completed_at" | "next_attempt_at"
> & {
  created_at: Date;
  completed_at: Date | null;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_until: Date | null;
};
export type Claim = {
  delivery: DeliveryRow;
  event: EventRecord;
  token: string;
  attempt: number;
};
export type ClaimResult =
  | { kind: "claimed"; claim: Claim }
  | { kind: "skip" }
  | { kind: "wait"; seconds: number };
export type Publication = DeliveryMessage & {
  token: string;
  delaySeconds: number;
};
const wire = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
export class Database {
  constructor(public readonly url: string) {}
  async connect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({
      connectionString: this.url,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }
  async transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return this.connect(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }
  async session(tokenHash: string): Promise<string | null> {
    return this.connect(
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM demo_sessions WHERE token_hash=$1 AND expires_at>now()",
            [tokenHash],
          )
        ).rows[0]?.id ?? null,
    );
  }
  async createSession(tokenHash: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.transaction(async (c) => {
      const quota = await c.query(
        "INSERT INTO demo_daily_usage(day,session_count) VALUES((now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(day) DO UPDATE SET session_count=demo_daily_usage.session_count+1 WHERE demo_daily_usage.session_count<200 RETURNING day",
      );
      if (!quota.rowCount)
        throw new AppError(
          429,
          "session_budget",
          "The demo has reached its daily session budget. Please return tomorrow.",
        );
      await c.query(
        "INSERT INTO demo_sessions(id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')",
        [id, tokenHash],
      );
    });
    return id;
  }
  async admit(
    sessionId: string,
    operation: string,
    key: string,
    fingerprint: string,
    create: (c: Client) => Promise<{ eventId: string; deliveryId: string }>,
  ): Promise<Accepted> {
    return this.transaction(async (c) => {
      // Consistent lock order: session, idempotency, global quota, then event/delivery.
      const session = (
        await c.query<{ delivery_count: number }>(
          "SELECT delivery_count FROM demo_sessions WHERE id=$1 AND expires_at>now() FOR UPDATE",
          [sessionId],
        )
      ).rows[0];
      if (!session)
        throw new AppError(401, "session_expired", "Start a new demo session.");
      const existing = (
        await c.query<{
          fingerprint: string;
          event_id: string;
          delivery_id: string;
        }>(
          "SELECT * FROM idempotency_requests WHERE session_id=$1 AND operation=$2 AND key=$3",
          [sessionId, operation, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new AppError(
            409,
            "idempotency_conflict",
            "This idempotency key was used for a different request.",
          );
        return {
          eventId: existing.event_id,
          deliveryId: existing.delivery_id,
          deduplicated: true,
        };
      }
      if (session.delivery_count >= SESSION_LIMIT)
        throw new AppError(
          429,
          "session_limit",
          "This session has reached its delivery limit.",
        );
      const quota = await c.query(
        "INSERT INTO demo_daily_usage(day,delivery_count) VALUES((now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(day) DO UPDATE SET delivery_count=demo_daily_usage.delivery_count+1 WHERE demo_daily_usage.delivery_count<$1 RETURNING day",
        [DAILY_LIMIT],
      );
      if (!quota.rowCount)
        throw new AppError(
          429,
          "daily_limit",
          "The demo has reached its daily delivery budget. Please return tomorrow.",
        );
      const result = await create(c);
      await c.query(
        "UPDATE demo_sessions SET delivery_count=delivery_count+1 WHERE id=$1",
        [sessionId],
      );
      await c.query(
        "INSERT INTO idempotency_requests(session_id,operation,key,fingerprint,event_id,delivery_id) VALUES($1,$2,$3,$4,$5,$6)",
        [
          sessionId,
          operation,
          key,
          fingerprint,
          result.eventId,
          result.deliveryId,
        ],
      );
      return { ...result, deduplicated: false };
    });
  }
  async insertDelivery(
    c: Client,
    eventId: string,
    receiver: Receiver,
    parent: string | null = null,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await c.query(
      "INSERT INTO deliveries(id,event_id,receiver,replay_parent_id) VALUES($1,$2,$3,$4)",
      [id, eventId, JSON.stringify(receiver), parent],
    );
    await c.query(
      "INSERT INTO delivery_outbox(delivery_id,generation,eligible_at) VALUES($1,1,now())",
      [id],
    );
    return id;
  }
  async ingest(
    sessionId: string,
    key: string,
    input: EventInput,
  ): Promise<Accepted> {
    const fingerprint = await hash(canonical(input));
    return this.admit(sessionId, "ingest", key, fingerprint, async (c) => {
      const eventId = crypto.randomUUID();
      await c.query(
        "INSERT INTO events(id,session_id,event_type,payload) VALUES($1,$2,$3,$4)",
        [eventId, sessionId, input.eventType, JSON.stringify(input.payload)],
      );
      return {
        eventId,
        deliveryId: await this.insertDelivery(c, eventId, input.receiver),
      };
    });
  }
  async replay(
    sessionId: string,
    key: string,
    sourceId: string,
    recover: boolean,
  ): Promise<Accepted> {
    return this.admit(
      sessionId,
      "replay",
      key,
      await hash(canonical({ sourceId, recover })),
      async (c) => {
        const source = (
          await c.query<DeliveryRow>(
            "SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.id=$1 AND e.session_id=$2",
            [sourceId, sessionId],
          )
        ).rows[0];
        if (!source)
          throw new AppError(404, "not_found", "Delivery not found.");
        if (!terminal(source.state))
          throw new AppError(
            409,
            "delivery_active",
            "Wait for this delivery to finish before replaying it.",
          );
        await c.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [
          source.event_id,
        ]);
        const count = Number(
          (
            await c.query<{ count: string }>(
              "SELECT count(*) FROM deliveries WHERE event_id=$1 AND replay_parent_id IS NOT NULL",
              [source.event_id],
            )
          ).rows[0].count,
        );
        if (count >= 2)
          throw new AppError(
            429,
            "replay_limit",
            "This event has reached its replay limit.",
          );
        return {
          eventId: source.event_id,
          deliveryId: await this.insertDelivery(
            c,
            source.event_id,
            recover ? { behaviour: "always_succeed" } : source.receiver,
            source.id,
          ),
        };
      },
    );
  }
  async detail(sessionId: string, id: string): Promise<Detail> {
    return this.transaction(async (c) => {
      // A coherent timeline even if an attempt completes between reads.
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const d = (
        await c.query<DeliveryRow>(
          "SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.id=$1 AND e.session_id=$2",
          [id, sessionId],
        )
      ).rows[0];
      if (!d) throw new AppError(404, "not_found", "Delivery not found.");
      const event = (
        await c.query(
          "SELECT id,event_type,payload,created_at FROM events WHERE id=$1",
          [d.event_id],
        )
      ).rows[0];
      const attempts = (
        await c.query(
          "SELECT * FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number",
          [id],
        )
      ).rows;
      const replays = (
        await c.query(
          "SELECT * FROM deliveries WHERE replay_parent_id=$1 ORDER BY created_at,id",
          [id],
        )
      ).rows;
      return wire<Detail>({
        delivery: publicDelivery(d),
        event,
        attempts,
        replays: replays.map(publicDelivery),
      });
    });
  }
  async list(
    sessionId: string,
    state?: string,
    cursor?: { time: string; id: string },
  ): Promise<{ deliveries: Delivery[]; nextCursor: string | null }> {
    return this.connect(async (c) => {
      const rows = (
        await c.query<DeliveryRow>(
          "SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_id WHERE e.session_id=$1 AND ($2::text IS NULL OR d.state=$2) AND ($3::timestamptz IS NULL OR (d.created_at,d.id)<($3::timestamptz,$4::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT 21",
          [sessionId, state ?? null, cursor?.time ?? null, cursor?.id ?? null],
        )
      ).rows;
      const page = rows.slice(0, 20);
      const last = page.at(-1);
      return {
        deliveries: wire<Delivery[]>(page.map(publicDelivery)),
        nextCursor:
          rows.length > 20 && last
            ? btoa(
                JSON.stringify({
                  time: last.created_at.toISOString(),
                  id: last.id,
                }),
              )
            : null,
      };
    });
  }
  async recoverLease(c: Client, d: DeliveryRow): Promise<void> {
    await c.query(
      "UPDATE delivery_attempts SET outcome='interrupted',finished_at=now(),error_code='worker_interrupted' WHERE delivery_id=$1 AND outcome='started'",
      [d.id],
    );
    await this.schedule(
      c,
      d,
      d.attempt_count >= MAX_ATTEMPTS ? "dead_lettered" : "retry_wait",
      1,
      d.attempt_count >= MAX_ATTEMPTS ? "attempts_exhausted" : null,
    );
  }
  async schedule(
    c: Client,
    d: DeliveryRow,
    state: "retry_wait" | "succeeded" | "dead_lettered",
    seconds: number,
    reason: string | null,
  ): Promise<void> {
    const generation = d.generation + (state === "retry_wait" ? 1 : 0);
    await c.query(
      "UPDATE deliveries SET state=$2,generation=$3,next_attempt_at=now()+($4*interval '1 second'),lease_token=NULL,lease_until=NULL,final_reason=$5,completed_at=CASE WHEN $2 IN ('succeeded','dead_lettered') THEN now() ELSE NULL END WHERE id=$1",
      [d.id, state, generation, seconds, reason],
    );
    if (state === "retry_wait")
      await c.query(
        "INSERT INTO delivery_outbox(delivery_id,generation,eligible_at) VALUES($1,$2,now()+($3*interval '1 second'))",
        [d.id, generation, seconds],
      );
  }
  async claim(message: DeliveryMessage): Promise<ClaimResult> {
    return this.transaction(async (c) => {
      const d = (
        await c.query<DeliveryRow>(
          "SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_id JOIN demo_sessions s ON s.id=e.session_id WHERE d.id=$1 AND s.expires_at>now() FOR UPDATE OF d",
          [message.deliveryId],
        )
      ).rows[0];
      if (!d || terminal(d.state) || d.generation !== message.generation)
        return { kind: "skip" };
      const now = (
        await c.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0].now.getTime();
      if (d.state === "in_progress") {
        if (d.lease_until!.getTime() > now)
          return {
            kind: "wait",
            seconds: Math.max(
              1,
              Math.ceil((d.lease_until!.getTime() - now) / 1000),
            ),
          };
        await this.recoverLease(c, d);
        return { kind: "skip" };
      }
      if (d.next_attempt_at.getTime() > now)
        return {
          kind: "wait",
          seconds: Math.max(
            1,
            Math.ceil((d.next_attempt_at.getTime() - now) / 1000),
          ),
        };
      if (d.attempt_count >= MAX_ATTEMPTS) {
        await this.schedule(c, d, "dead_lettered", 0, "attempts_exhausted");
        return { kind: "skip" };
      }
      const token = crypto.randomUUID();
      const attempt = d.attempt_count + 1;
      await c.query(
        "UPDATE deliveries SET state='in_progress',attempt_count=$2,lease_token=$3,lease_until=clock_timestamp()+($4*interval '1 second') WHERE id=$1",
        [d.id, attempt, token, LEASE_SECONDS],
      );
      await c.query(
        "INSERT INTO delivery_attempts(delivery_id,attempt_number) VALUES($1,$2)",
        [d.id, attempt],
      );
      const event = (
        await c.query(
          "SELECT id,event_type,payload,created_at FROM events WHERE id=$1",
          [d.event_id],
        )
      ).rows[0];
      return {
        kind: "claimed",
        claim: { delivery: d, event: wire<EventRecord>(event), token, attempt },
      };
    });
  }
  async finish(
    claim: Claim,
    result: Result,
    random = Math.random,
  ): Promise<boolean> {
    return this.transaction(async (c) => {
      const d = (
        await c.query<DeliveryRow>(
          "SELECT * FROM deliveries WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE",
          [claim.delivery.id, claim.token],
        )
      ).rows[0];
      if (!d) return false;
      const success =
        result.status !== null && result.status >= 200 && result.status < 300;
      await c.query(
        "UPDATE delivery_attempts SET outcome=$3,finished_at=now(),http_status=$4,duration_ms=$5,response_excerpt=$6,error_code=$7 WHERE delivery_id=$1 AND attempt_number=$2",
        [
          d.id,
          claim.attempt,
          success ? "succeeded" : "failed",
          result.status,
          Math.max(0, Math.round(result.durationMs)),
          result.excerpt,
          result.error,
        ],
      );
      const decision = settlement(d.attempt_count, result.status);
      const retry = decision.state === "retry_wait";
      await this.schedule(
        c,
        d,
        decision.state,
        retry
          ? retryDelay(claim.attempt, result.retryAfter, Date.now(), random)
          : 0,
        decision.reason,
      );
      return true;
    });
  }
  async publication(
    deliveryId?: string,
    recover = false,
  ): Promise<Publication | null> {
    return this.transaction(async (c) => {
      const row = (
        await c.query<{
          delivery_id: string;
          generation: number;
          eligible_at: Date;
          now: Date;
        }>(
          `SELECT o.*,clock_timestamp() AS now FROM delivery_outbox o JOIN deliveries d ON d.id=o.delivery_id JOIN events e ON e.id=d.event_id JOIN demo_sessions s ON s.id=e.session_id
        WHERE o.generation=d.generation AND d.state IN ('pending','retry_wait') AND s.expires_at>now()
        AND ($1::uuid IS NULL OR o.delivery_id=$1) AND o.publish_count<3
        AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp())
        AND (o.published_at IS NULL OR ($2 AND o.eligible_at<now()-interval '60 seconds' AND o.published_at<now()-interval '60 seconds'))
        ORDER BY o.eligible_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
          [deliveryId ?? null, recover],
        )
      ).rows[0];
      if (!row) return null;
      const token = crypto.randomUUID();
      await c.query(
        "UPDATE delivery_outbox SET lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds',publish_count=publish_count+1 WHERE delivery_id=$1 AND generation=$2",
        [row.delivery_id, row.generation, token],
      );
      return {
        deliveryId: row.delivery_id,
        generation: row.generation,
        token,
        delaySeconds: Math.max(
          0,
          Math.ceil((row.eligible_at.getTime() - row.now.getTime()) / 1000),
        ),
      };
    });
  }
  async published(p: Publication, success: boolean) {
    await this.connect((c) =>
      c.query(
        "UPDATE delivery_outbox SET published_at=CASE WHEN $4 THEN clock_timestamp() ELSE published_at END,lease_token=NULL,lease_until=NULL WHERE delivery_id=$1 AND generation=$2 AND lease_token=$3",
        [p.deliveryId, p.generation, p.token, success],
      ),
    );
  }
  async recover(): Promise<number> {
    return this.transaction(async (c) => {
      const expired = (
        await c.query<DeliveryRow>(
          "SELECT * FROM deliveries WHERE state='in_progress' AND lease_until<=clock_timestamp() ORDER BY lease_until LIMIT 20 FOR UPDATE SKIP LOCKED",
        )
      ).rows;
      for (const d of expired) await this.recoverLease(c, d);
      // Grace period prevents marking a recently published final notification as failed.
      const stuck = (
        await c.query<DeliveryRow>(
          `SELECT d.* FROM deliveries d JOIN delivery_outbox o ON o.delivery_id=d.id AND o.generation=d.generation WHERE d.state IN ('pending','retry_wait') AND o.publish_count>=3 AND o.eligible_at<now()-interval '60 seconds' AND (o.lease_until IS NULL OR o.lease_until<=now()) AND (o.published_at IS NULL OR o.published_at<now()-interval '60 seconds') LIMIT 20 FOR UPDATE OF d SKIP LOCKED`,
        )
      ).rows;
      for (const d of stuck)
        await this.schedule(c, d, "dead_lettered", 0, "infrastructure_stalled");
      await c.query(
        "DELETE FROM demo_sessions WHERE id IN (SELECT id FROM demo_sessions WHERE expires_at<=now() ORDER BY expires_at LIMIT 20 FOR UPDATE SKIP LOCKED)",
      );
      await c.query(
        "DELETE FROM demo_daily_usage WHERE day<(now() AT TIME ZONE 'UTC')::date-2",
      );
      return expired.length + stuck.length;
    });
  }
}
function publicDelivery(row: DeliveryRow): Delivery {
  const { lease_token: _token, lease_until: _until, ...safe } = row;
  void _token;
  void _until;
  return wire<Delivery>(safe);
}
