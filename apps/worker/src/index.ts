import { log, messageSchema, type DeliveryMessage } from "@dispatchlab/core";
import { Database } from "@dispatchlab/db";
import { api } from "./api";
import {
  processDelivery,
  publish,
  type QueuePort,
  type ReceiverPort,
} from "./delivery";
export interface Env {
  DATABASE_URL: string;
  SIGNING_SECRET: string;
  MODE: "local" | "hosted";
  DEMO_PAUSED: string;
  DELIVERY_QUEUE: QueuePort;
  RECEIVER: ReceiverPort;
  ASSETS: Fetcher;
  MUTATION_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  READ_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname.startsWith("/api/"))
      return api(request, env, ctx);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return new Response(asset.body, { status: asset.status, headers });
  },
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env) {
    const db = new Database(env.DATABASE_URL);
    for (const message of batch.messages) {
      const parsed = messageSchema.safeParse(message.body);
      if (!parsed.success) {
        log("invalid_queue_message", { errorCode: "invalid_message" });
        message.ack();
        continue;
      }
      try {
        const result = await processDelivery(
          db,
          env.DELIVERY_QUEUE,
          env.RECEIVER,
          env.SIGNING_SECRET,
          parsed.data,
        );
        if (result.retrySeconds)
          message.retry({ delaySeconds: result.retrySeconds });
        else message.ack();
      } catch {
        log("consumer_failed", {
          deliveryId: parsed.data.deliveryId,
          errorCode: "infrastructure_error",
        });
        message.retry({ delaySeconds: 5 });
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    const db = new Database(env.DATABASE_URL);
    try {
      log("recovery_completed", { count: await db.recover() });
      for (let i = 0; i < 20; i++) {
        const p = await db.publication(undefined, true);
        if (!p) break;
        try {
          await env.DELIVERY_QUEUE.send(
            { deliveryId: p.deliveryId, generation: p.generation },
            { delaySeconds: p.delaySeconds },
          );
          await db.published(p, true);
        } catch {
          await db.published(p, false);
          log("publication_failed", {
            deliveryId: p.deliveryId,
            errorCode: "queue_unavailable",
          });
          break;
        }
      }
    } catch {
      log("recovery_failed", { errorCode: "infrastructure_error" });
      throw new Error("Recovery failed; inspect durable delivery state.");
    }
  },
};
// Export the publisher for test harnesses; no public fault-injection endpoint exists.
export { publish };
