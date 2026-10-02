import { z } from "zod";

export const MAX_ATTEMPTS = 5;
export const LEASE_SECONDS = 30;
export const SESSION_LIMIT = 10;
export const DAILY_LIMIT = 50;
export const states = [
  "pending",
  "in_progress",
  "retry_wait",
  "succeeded",
  "dead_lettered",
] as const;
export type DeliveryState = (typeof states)[number];
export const terminal = (state: DeliveryState) =>
  state === "succeeded" || state === "dead_lettered";
export const receiverSchema = z.discriminatedUnion("behaviour", [
  z.object({ behaviour: z.literal("always_succeed") }).strict(),
  z
    .object({
      behaviour: z.literal("fail_then_succeed"),
      failures: z.number().int().min(0).max(4),
    })
    .strict(),
  z.object({ behaviour: z.literal("always_fail") }).strict(),
  z.object({ behaviour: z.literal("timeout") }).strict(),
  z.object({ behaviour: z.literal("rate_limit") }).strict(),
]);
export type Receiver = z.infer<typeof receiverSchema>;
export const samples = {
  order: {
    type: "order.created",
    payload: {
      orderId: "ord_demo_1042",
      customer: "Alex Morgan",
      total: 12900,
      currency: "USD",
      items: [{ sku: "LAB-NOTEBOOK", quantity: 2 }],
    },
  },
  shipment: {
    type: "shipment.dispatched",
    payload: {
      shipmentId: "shp_demo_208",
      carrier: "Fictional Express",
      destination: "Cape Town",
      status: "dispatched",
    },
  },
  invoice: {
    type: "invoice.paid",
    payload: {
      invoiceId: "inv_demo_731",
      amount: 4900,
      currency: "USD",
      account: "Northstar Studio",
    },
  },
} satisfies Record<string, { type: string; payload: EventInput["payload"] }>;
export const ingestionSchema = z.union([
  z
    .object({
      sampleId: z.enum(["order", "shipment", "invoice"]),
      receiver: receiverSchema,
    })
    .strict(),
  z
    .object({
      eventType: z.string().min(1).max(100),
      payload: z.json(),
      receiver: receiverSchema,
    })
    .strict(),
]);
export const replaySchema = z
  .object({ recover: z.boolean().default(false) })
  .strict();
export const messageSchema = z
  .object({ deliveryId: z.uuid(), generation: z.number().int().positive() })
  .strict();
export type DeliveryMessage = z.infer<typeof messageSchema>;
export type EventInput = {
  eventType: string;
  payload: z.infer<ReturnType<typeof z.json>>;
  receiver: Receiver;
};
export type Delivery = {
  id: string;
  event_id: string;
  replay_parent_id: string | null;
  receiver: Receiver;
  state: DeliveryState;
  attempt_count: number;
  generation: number;
  next_attempt_at: string;
  created_at: string;
  completed_at: string | null;
  final_reason: string | null;
};
export type Attempt = {
  delivery_id: string;
  attempt_number: number;
  outcome: "started" | "succeeded" | "failed" | "interrupted";
  started_at: string;
  finished_at: string | null;
  http_status: number | null;
  duration_ms: number | null;
  response_excerpt: string | null;
  error_code: string | null;
};
export type EventRecord = {
  id: string;
  event_type: string;
  payload: EventInput["payload"];
  created_at: string;
};
export type Detail = {
  delivery: Delivery;
  event: EventRecord;
  attempts: Attempt[];
  replays: Delivery[];
};
export type Accepted = {
  eventId: string;
  deliveryId: string;
  deduplicated: boolean;
};
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export const retryable = (status: number | null) =>
  status === null || status === 408 || status === 429 || status >= 500;
export function settlement(
  attempt: number,
  status: number | null,
): {
  state: "succeeded" | "retry_wait" | "dead_lettered";
  reason: string | null;
} {
  if (status !== null && status >= 200 && status < 300)
    return { state: "succeeded", reason: null };
  if (!retryable(status))
    return { state: "dead_lettered", reason: "permanent_rejection" };
  if (attempt >= MAX_ATTEMPTS)
    return { state: "dead_lettered", reason: "attempts_exhausted" };
  return { state: "retry_wait", reason: null };
}
export function retryDelay(
  attempt: number,
  retryAfter: string | null,
  now = Date.now(),
  random = Math.random,
): number {
  const ceiling = Math.min(30, 2 ** attempt);
  const jitter =
    1 + Math.floor(Math.min(0.999999, Math.max(0, random())) * ceiling);
  let requested = 0;
  if (retryAfter !== null) {
    if (/^\d+$/.test(retryAfter.trim())) requested = Number(retryAfter);
    else {
      const parsed = Date.parse(retryAfter);
      if (Number.isFinite(parsed)) requested = Math.ceil((parsed - now) / 1000);
    }
  }
  return Math.max(jitter, Math.min(30, Math.max(0, requested)));
}
export type Result = {
  status: number | null;
  durationMs: number;
  excerpt: string;
  error: string | null;
  retryAfter: string | null;
};
export type SignatureContext = {
  timestamp: string;
  deliveryId: string;
  attempt: string;
};
const signingInput = (body: string, c: SignatureContext) =>
  new TextEncoder().encode(
    `${c.timestamp}\n${c.deliveryId}\n${c.attempt}\n${body}`,
  );
async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sign(
  body: string,
  context: SignatureContext,
  secret: string,
): Promise<string> {
  const bytes = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    signingInput(body, context),
  );
  return `v1=${[...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
export async function verify(
  body: string,
  context: SignatureContext,
  signature: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    !/^\d{10}$/.test(context.timestamp) ||
    !/^[1-5]$/.test(context.attempt) ||
    !z.uuid().safeParse(context.deliveryId).success
  )
    return false;
  if (Math.abs(now / 1000 - Number(context.timestamp)) > 300) return false;
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, (v) =>
    parseInt(v, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    bytes,
    signingInput(body, context),
  );
}
export async function boundedText(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        chunks.push(value.subarray(0, limit - size));
        await reader.cancel();
        return {
          text: new TextDecoder().decode(join(chunks, limit)),
          truncated: true,
        };
      }
      chunks.push(value);
      size += value.length;
    }
    return {
      text: new TextDecoder().decode(join(chunks, size)),
      truncated: false,
    };
  } finally {
    reader.releaseLock();
  }
}
function join(chunks: Uint8Array[], size: number) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
type LogFields = {
  requestId?: string;
  eventId?: string;
  deliveryId?: string;
  attempt?: number;
  generation?: number;
  durationMs?: number;
  outcome?: string;
  errorCode?: string;
  count?: number;
};
export function log(event: string, fields: LogFields = {}) {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }),
  );
}
