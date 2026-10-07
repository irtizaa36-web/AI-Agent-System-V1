import type { RawPosting } from "../records";

/**
 * The Source port (ADR 0001). Every discovery source — an ATS JSON endpoint,
 * an RSS feed, a mailbox of forwarded job alerts — is an adapter behind this
 * one interface, so the pipeline never knows or cares where a posting came
 * from.
 *
 * A Source that fails does not throw the run away. It reports the failure and
 * the pipeline marks it degraded, because one company changing its board
 * layout must never cost the candidate a day of discovery.
 */
export interface Source {
  readonly id: string;
  readonly company: string | null;
  /** Per-board freshness override from the watchlist entry, when set. */
  readonly maxAgeDays?: number;
  /** Priority-lane flag from the watchlist entry, when set. */
  readonly priority?: boolean;
  fetch(): Promise<readonly RawPosting[]>;
}

/** Per-entry tuning carried from the watchlist onto a Source. Optional throughout — absent means global defaults. */
export interface AtsSourceOptions {
  readonly maxAgeDays?: number;
  readonly priority?: boolean;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 1;

/**
 * Identifies the pipeline honestly to every server it talks to. A job board
 * operator who wants to block this, or rate-limit it, or email about it, can.
 * Anonymous traffic pretending to be a browser is exactly what the politeness
 * rules in this project exist to avoid.
 */
export const USER_AGENT = "MobyAI-JobSearch/1.0 (personal job search; contact via repository owner)";

/** Human-scale jitter so a run of 40 boards doesn't arrive as 40 simultaneous requests. */
export async function jitter(minMs = 250, maxMs = 900): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * One fetch with a timeout and a single retry at backoff. Anything past that
 * is the source's problem, reported rather than retried into a rate limit.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, text/xml, */*" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`fetch failed for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const body = await fetchText(url, options);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`response from ${url} was not JSON (the board's format may have changed)`);
  }
}

/** Runs sources with a small concurrency cap so no single run floods anyone. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index] as T);
    }
  });

  await Promise.all(runners);
  return results;
}
