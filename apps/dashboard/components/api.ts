export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: controller.signal,
    });
    const data = await r.json();
    if (!r.ok)
      throw new ApiError(
        data.error?.message ?? "The demo is temporarily unavailable.",
        data.error?.code ?? "unavailable",
        r.status,
      );
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "Could not reach the demo. Please try again.",
      "network_error",
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}
export const startSession = () =>
  api("/session", { method: "POST", body: "{}" });
export const detailLink = (id: string) =>
  `/deliveries/?id=${encodeURIComponent(id)}`;
