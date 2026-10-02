import {
  boundedText,
  canonical,
  log,
  sign,
  settlement,
  type DeliveryMessage,
  type Result,
} from "@dispatchlab/core";
import { Database, type Claim } from "@dispatchlab/db";
export type QueuePort = {
  send(
    body: DeliveryMessage,
    options?: { delaySeconds: number },
  ): Promise<void>;
};
export type ReceiverPort = { fetch(request: Request): Promise<Response> };
export async function publish(
  db: Database,
  queue: QueuePort,
  id?: string,
  recovery = false,
): Promise<boolean> {
  const p = await db.publication(id, recovery);
  if (!p) return true;
  try {
    await queue.send(
      { deliveryId: p.deliveryId, generation: p.generation },
      { delaySeconds: p.delaySeconds },
    );
    await db.published(p, true);
    log("notification_published", {
      deliveryId: p.deliveryId,
      generation: p.generation,
    });
    return true;
  } catch {
    await db.published(p, false).catch(() => {});
    log("publication_failed", {
      deliveryId: p.deliveryId,
      generation: p.generation,
      errorCode: "queue_unavailable",
    });
    return false;
  }
}
export async function send(
  claim: Claim,
  receiver: ReceiverPort,
  secret: string,
): Promise<Result> {
  const body = canonical({
    event: claim.event,
    receiver: claim.delivery.receiver,
  });
  const context = {
    timestamp: String(Math.floor(Date.now() / 1000)),
    deliveryId: claim.delivery.id,
    attempt: String(claim.attempt),
  };
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-DispatchLab-Event": claim.event.id,
    "X-DispatchLab-Delivery": context.deliveryId,
    "X-DispatchLab-Attempt": context.attempt,
    "X-DispatchLab-Timestamp": context.timestamp,
    "X-DispatchLab-Signature": await sign(body, context, secret),
  });
  const controller = new AbortController();
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (async () => {
        const r = await receiver.fetch(
          new Request("https://receiver.internal/webhook", {
            method: "POST",
            body,
            headers,
            redirect: "manual",
            signal: controller.signal,
          }),
        );
        const excerpt = await boundedText(r.body, 2048);
        return {
          status: r.status,
          durationMs: Date.now() - start,
          excerpt: excerpt.text,
          error: r.ok ? null : "http_error",
          retryAfter: r.headers.get("retry-after"),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, 3000);
      }),
    ]);
    return response;
  } catch {
    return {
      status: null,
      durationMs: Date.now() - start,
      excerpt: "",
      error: controller.signal.aborted ? "timeout" : "connection_error",
      retryAfter: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function processDelivery(
  db: Database,
  queue: QueuePort,
  receiver: ReceiverPort,
  secret: string,
  message: DeliveryMessage,
): Promise<{ retrySeconds?: number }> {
  const result = await db.claim(message);
  if (result.kind === "wait") return { retrySeconds: result.seconds };
  if (result.kind === "claimed") {
    const c = result.claim;
    log("attempt_started", {
      eventId: c.event.id,
      deliveryId: c.delivery.id,
      attempt: c.attempt,
      generation: message.generation,
    });
    const outcome = await send(c, receiver, secret);
    const committed = await db.finish(c, outcome);
    log(committed ? "attempt_completed" : "stale_result_ignored", {
      eventId: c.event.id,
      deliveryId: c.delivery.id,
      attempt: c.attempt,
      durationMs: outcome.durationMs,
      outcome:
        outcome.status !== null && outcome.status >= 200 && outcome.status < 300
          ? "succeeded"
          : "failed",
      errorCode: outcome.error ?? undefined,
    });
    if (committed) {
      const decision = settlement(c.attempt, outcome.status);
      log(
        decision.state === "retry_wait"
          ? "retry_scheduled"
          : decision.state === "succeeded"
            ? "delivery_succeeded"
            : "delivery_dead_lettered",
        {
          eventId: c.event.id,
          deliveryId: c.delivery.id,
          attempt: c.attempt,
          generation:
            message.generation + (decision.state === "retry_wait" ? 1 : 0),
          errorCode: decision.reason ?? undefined,
        },
      );
    }
  }
  return (await publish(db, queue, message.deliveryId))
    ? {}
    : { retrySeconds: 5 };
}
