import { describe, expect, it, vi, afterEach } from "vitest";
import {
  canonical,
  hash,
  retryDelay,
  retryable,
  sign,
  verify,
  boundedText,
  receiverSchema,
  terminal,
  settlement,
} from "@dispatchlab/core";
import receiver from "../../apps/receiver/src/index";
const secret = "test-signing-secret-at-least-24-characters";
const deliveryId = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.useRealTimers());
describe("retry policy", () => {
  it.each([
    [1, 200, "succeeded", null],
    [5, 200, "succeeded", null],
    [4, 503, "retry_wait", null],
    [5, 503, "dead_lettered", "attempts_exhausted"],
    [1, 400, "dead_lettered", "permanent_rejection"],
    [1, null, "retry_wait", null],
    [5, null, "dead_lettered", "attempts_exhausted"],
  ] as const)(
    "settles attempt %s / status %s into %s",
    (attempt, status, state, reason) =>
      expect(settlement(attempt, status)).toEqual({ state, reason }),
  );
  it.each([408, 429, 500, 503, null])("retries %s", (status) =>
    expect(retryable(status)).toBe(true),
  );
  it.each([200, 301, 400, 401, 404, 422])("does not retry %s", (status) =>
    expect(retryable(status)).toBe(false),
  );
  it("has exponential bounds and bounded jitter", () => {
    for (let n = 1; n <= 8; n++) {
      expect(retryDelay(n, null, 0, () => 0)).toBe(1);
      expect(retryDelay(n, null, 0, () => 0.9999)).toBe(Math.min(30, 2 ** n));
    }
  });
  it("honours Retry-After seconds and dates, capped at 30 seconds", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(retryDelay(1, "5", now, () => 0)).toBe(5);
    expect(retryDelay(1, "Fri, 02 Oct 2026 00:00:10 GMT", now, () => 0)).toBe(
      10,
    );
    expect(retryDelay(1, "999", now, () => 0)).toBe(30);
    expect(retryDelay(1, "invalid", now, () => 0)).toBe(1);
    expect(retryDelay(1, "Thu, 01 Oct 2026 23:00:00 GMT", now, () => 0)).toBe(
      1,
    );
  });
});
describe("canonical fingerprints and validation", () => {
  it("ignores object-key order but preserves array order", async () => {
    expect(await hash(canonical({ b: 2, a: { z: 1, x: 2 } }))).toBe(
      await hash(canonical({ a: { x: 2, z: 1 }, b: 2 })),
    );
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(canonical(JSON.parse('{"__proto__":{"x":1}}'))).toContain(
      "__proto__",
    );
  });
  it("rejects URLs, excessive failure counts, and unknown options", () => {
    expect(
      receiverSchema.safeParse({
        behaviour: "always_succeed",
        url: "http://localhost",
      }).success,
    ).toBe(false);
    expect(
      receiverSchema.safeParse({ behaviour: "fail_then_succeed", failures: 5 })
        .success,
    ).toBe(false);
  });
  it("recognises only terminal states", () => {
    expect(terminal("succeeded")).toBe(true);
    expect(terminal("dead_lettered")).toBe(true);
    expect(terminal("retry_wait")).toBe(false);
  });
  it("bounds streamed responses without reading the remainder", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("abcdef"));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await boundedText(stream, 3)).toEqual({
      text: "abc",
      truncated: true,
    });
    expect(cancelled).toBe(true);
  });
});
describe("HMAC and controlled HTTP receiver", () => {
  const context = () => ({
    timestamp: String(Math.floor(Date.now() / 1000)),
    deliveryId,
    attempt: "1",
  });
  it("verifies exact bytes and rejects tampering, stale timestamps, metadata and wrong secret", async () => {
    const c = context();
    const signature = await sign('{"ok":true}', c, secret);
    expect(await verify('{"ok":true}', c, signature, secret)).toBe(true);
    expect(await verify('{"ok":false}', c, signature, secret)).toBe(false);
    expect(
      await verify('{"ok":true}', { ...c, attempt: "2" }, signature, secret),
    ).toBe(false);
    expect(await verify('{"ok":true}', c, signature, "wrong-secret")).toBe(
      false,
    );
    expect(
      await verify('{"ok":true}', c, signature, secret, Date.now() + 301000),
    ).toBe(false);
    expect(await verify("{}", c, "v1=invalid", secret)).toBe(false);
  });
  async function call(behaviour: unknown, attempt = 1) {
    const body = canonical({
      event: {
        id: deliveryId,
        event_type: "order.created",
        payload: { demo: true },
        created_at: new Date().toISOString(),
      },
      receiver: behaviour,
    });
    const c = { ...context(), attempt: String(attempt) };
    return receiver.fetch(
      new Request("https://receiver.internal/webhook", {
        method: "POST",
        body,
        headers: {
          "X-DispatchLab-Event": deliveryId,
          "X-DispatchLab-Delivery": deliveryId,
          "X-DispatchLab-Attempt": c.attempt,
          "X-DispatchLab-Timestamp": c.timestamp,
          "X-DispatchLab-Signature": await sign(body, c, secret),
        },
      }),
      { SIGNING_SECRET: secret },
    );
  }
  it("accepts valid signed events", async () => {
    const r = await call({ behaviour: "always_succeed" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ signatureVerified: true });
  });
  it("fails the configured number of attempts", async () => {
    expect(
      (await call({ behaviour: "fail_then_succeed", failures: 2 }, 2)).status,
    ).toBe(503);
    expect(
      (await call({ behaviour: "fail_then_succeed", failures: 2 }, 3)).status,
    ).toBe(200);
  });
  it("returns permanent 503 and rate-limit headers", async () => {
    expect((await call({ behaviour: "always_fail" })).status).toBe(503);
    const r = await call({ behaviour: "rate_limit" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("5");
  });
  it("rejects an unsigned request before selecting behaviour", async () => {
    expect(
      (
        await receiver.fetch(
          new Request("https://receiver.internal/webhook", {
            method: "POST",
            body: "{}",
          }),
          { SIGNING_SECRET: secret },
        )
      ).status,
    ).toBe(401);
  });
  it("actually delays the timeout receiver", async () => {
    vi.useFakeTimers();
    const pending = call({ behaviour: "timeout" });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).status).toBe(200);
  });
});
