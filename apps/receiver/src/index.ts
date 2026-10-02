import { z } from "zod";
import { receiverSchema, verify, boundedText } from "@dispatchlab/core";
const envelope = z
  .object({
    event: z
      .object({
        id: z.uuid(),
        event_type: z.string(),
        payload: z.json(),
        created_at: z.string(),
      })
      .strict(),
    receiver: receiverSchema,
  })
  .strict();
export default {
  async fetch(
    request: Request,
    env: { SIGNING_SECRET: string },
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/webhook"
    )
      return new Response("Not found", { status: 404 });
    if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 24)
      return new Response("Receiver unavailable", { status: 503 });
    const raw = await boundedText(request.body, 16384);
    if (raw.truncated) return new Response("Too large", { status: 413 });
    const context = {
      timestamp: request.headers.get("x-dispatchlab-timestamp") ?? "",
      deliveryId: request.headers.get("x-dispatchlab-delivery") ?? "",
      attempt: request.headers.get("x-dispatchlab-attempt") ?? "",
    };
    if (
      !(await verify(
        raw.text,
        context,
        request.headers.get("x-dispatchlab-signature") ?? "",
        env.SIGNING_SECRET,
      ))
    )
      return new Response("Invalid signature", { status: 401 });
    let parsed;
    try {
      parsed = envelope.parse(JSON.parse(raw.text));
    } catch {
      return new Response("Invalid envelope", { status: 400 });
    }
    if (parsed.event.id !== request.headers.get("x-dispatchlab-event"))
      return new Response("Event identity mismatch", { status: 400 });
    const r = parsed.receiver;
    if (r.behaviour === "timeout")
      await new Promise((resolve) => setTimeout(resolve, 4000));
    if (r.behaviour === "rate_limit")
      return Response.json(
        { message: "Fictional receiver rate limit", signatureVerified: true },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    if (
      r.behaviour === "always_fail" ||
      (r.behaviour === "fail_then_succeed" &&
        Number(context.attempt) <= r.failures)
    )
      return Response.json(
        { message: "Intentional receiver failure", signatureVerified: true },
        { status: 503 },
      );
    return Response.json({
      message: "Event received",
      signatureVerified: true,
      eventId: parsed.event.id,
    });
  },
};
