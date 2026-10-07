/**
 * Shared HTTP plumbing for the sports-data read ports. Everything here is
 * GET-only and read-only. `getJson` never throws: any failure (network
 * error, timeout, non-2xx status, unparseable body) resolves to null, and
 * each client degrades that to an "unknown"/empty result for its caller.
 * Tests inject a fake `fetchImpl`; production uses the global fetch.
 */

export interface HttpGetOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface JsonResponse<T> {
  readonly data: T;
  readonly headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Join a relative API path onto a base URL that may itself carry a path
 * (e.g. base "https://api.elections.kalshi.com/trade-api/v2" + "/events").
 * A naive `new URL("/events", base)` would silently drop "/trade-api/v2",
 * so the leading slash is stripped and the base gets a trailing slash first.
 */
export function joinUrl(base: string, path: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase);
}

/**
 * GET a URL and parse the body as JSON. Resolves to null on ANY failure —
 * never throws through the caller.
 */
export async function getJson<T>(url: string | URL, options: HttpGetOptions = {}): Promise<JsonResponse<T> | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...(options.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return null;
    const data = (text ? JSON.parse(text) : null) as T;
    return { data, headers: response.headers };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
