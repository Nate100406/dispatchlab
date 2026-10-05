import { z } from "zod";
import {
  AppError,
  boundedText,
  canonical,
  hash,
  ingestionSchema,
  log,
  randomToken,
  replaySchema,
  samples,
  states,
  type EventInput,
} from "@dispatchlab/core";
import { Database } from "@dispatchlab/db";
import { publish } from "./delivery";
import type { Env } from "./index";
import { databaseUrl } from "./database";
const cookieName = "dispatchlab_session";
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
function token(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
}
async function readBody(request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new AppError(400, "content_type", "Send application/json.");
  const body = await boundedText(request.body, 16384);
  if (body.truncated)
    throw new AppError(413, "body_too_large", "Request body exceeds 16 KiB.");
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Send valid JSON.");
  }
}
function idempotency(request: Request) {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new AppError(
      400,
      "idempotency_key",
      "Use an Idempotency-Key containing 8–128 letters, digits, underscores, or hyphens.",
    );
  return key;
}
export async function api(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health")
      return response({
        status:
          databaseUrl(env) && env.SIGNING_SECRET
            ? "configured"
            : "unconfigured",
      });
    if (env.DEMO_PAUSED === "true")
      throw new AppError(503, "demo_paused", "The demo is temporarily paused.");
    const mutation = request.method === "POST";
    if (mutation) {
      const origin = request.headers.get("origin");
      if (
        origin !== url.origin &&
        !(env.MODE === "local" && origin === "http://localhost:3000")
      )
        throw new AppError(
          403,
          "origin_rejected",
          "Use the demo from its own origin.",
        );
    }
    const sessionToken = token(request);
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    const limiter = mutation ? env.MUTATION_LIMITER : env.READ_LIMITER;
    for (const key of [
      `ip:${ip}`,
      ...(sessionToken ? [`session:${await hash(sessionToken)}`] : []),
    ]) {
      if (!(await limiter.limit({ key })).success)
        throw new AppError(
          429,
          "rate_limited",
          "Too many requests. Please wait a minute.",
        );
    }
    if (
      !databaseUrl(env) ||
      !env.SIGNING_SECRET ||
      env.SIGNING_SECRET.length < 24
    )
      throw new AppError(
        503,
        "configuration_missing",
        "The demo is not configured yet.",
      );
    // Share the foreground connection; publication has its own lifetime.
    return await new Database(databaseUrl(env)).withConnection(async (db) => {
      const sessionId =
        sessionToken && /^[a-f0-9]{64}$/.test(sessionToken)
          ? await db.session(await hash(sessionToken))
          : null;
      if (mutation && url.pathname === "/api/session") {
        await readBody(request);
        if (sessionId) return response({ ready: true });
        const fresh = randomToken();
        await db.createSession(await hash(fresh));
        return response({ ready: true }, 201, {
          "Set-Cookie": `${cookieName}=${fresh}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${env.MODE === "local" ? "" : "; Secure"}`,
        });
      }
      if (!sessionId)
        throw new AppError(
          401,
          "session_required",
          "Start a demo session first.",
        );
      if (mutation && url.pathname === "/api/events") {
        const input = ingestionSchema.parse(await readBody(request));
        let event: EventInput;
        if ("sampleId" in input)
          event = {
            eventType: samples[input.sampleId].type,
            payload: samples[input.sampleId].payload,
            receiver: input.receiver,
          };
        else {
          if (env.MODE !== "local")
            throw new AppError(
              400,
              "preset_required",
              "The hosted demo accepts fictional sample events only.",
            );
          if (new TextEncoder().encode(canonical(input.payload)).length > 8192)
            throw new AppError(
              413,
              "payload_too_large",
              "Event payload exceeds 8 KiB.",
            );
          event = input;
        }
        const accepted = await db.ingest(
          sessionId,
          idempotency(request),
          event,
        );
        log(
          accepted.deduplicated ? "ingestion_deduplicated" : "event_accepted",
          {
            requestId,
            eventId: accepted.eventId,
            deliveryId: accepted.deliveryId,
          },
        );
        ctx.waitUntil(
          publish(
            new Database(databaseUrl(env)),
            env.DELIVERY_QUEUE,
            accepted.deliveryId,
          ).catch(() => {
            log("publication_failed", {
              requestId,
              deliveryId: accepted.deliveryId,
              errorCode: "database_unavailable",
            });
          }),
        );
        return response(accepted, 202);
      }
      if (request.method === "GET" && url.pathname === "/api/deliveries") {
        const state = url.searchParams.get("status");
        if (state && !states.includes(state as (typeof states)[number]))
          throw new AppError(400, "invalid_status", "Unknown delivery status.");
        let cursor: { time: string; id: string } | undefined;
        if (url.searchParams.has("cursor")) {
          try {
            cursor = z
              .object({ time: z.iso.datetime(), id: z.uuid() })
              .strict()
              .parse(JSON.parse(atob(url.searchParams.get("cursor")!)));
          } catch {
            throw new AppError(
              400,
              "invalid_cursor",
              "Invalid pagination cursor.",
            );
          }
        }
        return response(await db.list(sessionId, state ?? undefined, cursor));
      }
      const match = url.pathname.match(
        /^\/api\/deliveries\/([^/]+)(\/replay)?$/,
      );
      if (match && z.uuid().safeParse(match[1]).success) {
        if (!match[2] && request.method === "GET")
          return response(await db.detail(sessionId, match[1]));
        if (match[2] && mutation) {
          const { recover } = replaySchema.parse(await readBody(request));
          const accepted = await db.replay(
            sessionId,
            idempotency(request),
            match[1],
            recover,
          );
          log("delivery_replayed", {
            requestId,
            eventId: accepted.eventId,
            deliveryId: accepted.deliveryId,
          });
          ctx.waitUntil(
            publish(
              new Database(databaseUrl(env)),
              env.DELIVERY_QUEUE,
              accepted.deliveryId,
            ).catch(() => {
              log("publication_failed", {
                requestId,
                errorCode: "database_unavailable",
              });
            }),
          );
          return response(accepted, 202);
        }
      }
      throw new AppError(404, "not_found", "Endpoint not found.");
    });
  } catch (error) {
    const known =
      error instanceof AppError
        ? error
        : error instanceof z.ZodError
          ? new AppError(
              400,
              "invalid_request",
              "Check the request fields and receiver configuration.",
            )
          : new AppError(
              503,
              "temporarily_unavailable",
              "The demo is temporarily unavailable. Retry with the same idempotency key.",
            );
    log("request_failed", { requestId, errorCode: known.code });
    return response(
      { error: { code: known.code, message: known.message, requestId } },
      known.status,
      known.status === 429 ? { "Retry-After": "60" } : {},
    );
  }
}
