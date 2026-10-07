import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobRecord } from "./records";
import { mapWithConcurrency } from "./sources/source";

/**
 * Stage 13 — pre-digest liveness validation.
 *
 * Runs after rank/cut, before the digest: every shortlisted posting's apply
 * URL gets one lightweight check (HTTP HEAD, GET fallback when the server
 * refuses HEAD). Confirmed-dead postings are excluded from the digest and
 * marked `stale-unverified`; anything ambiguous — network errors, timeouts,
 * bot-protection 403s, LinkedIn URLs the pipeline must never fetch — keeps
 * the role and goes to the human review queue instead. Fail-open on check
 * errors, fail-closed on confirmed-dead: an uncertain check must never
 * silently delete a real opportunity, and a confirmed-dead posting must
 * never waste her effort.
 *
 * No Firecrawl, no Supabase, no browser — plain fetch with a timeout.
 * linkedin.com is never requested, in any form (ADR 0013).
 */

/** One liveness check outcome. `ambiguous` keeps the role and queues it for human review. */
export type LivenessVerdict = "live" | "dead" | "ambiguous";

export interface LivenessCheck {
  readonly record: JobRecord;
  readonly verdict: LivenessVerdict;
  /** Short machine-readable reason: http-404, expired-marker, timeout, linkedin-manual, … */
  readonly reason: string;
}

export interface LivenessFetchResult {
  readonly status: number;
  /** Body text when a GET was needed (HEAD refused); null after a clean HEAD. */
  readonly bodyText: string | null;
}

/**
 * The HTTP port, injected so tests can fake every outcome without sockets.
 * Production passes `httpLivenessFetcher` (below).
 */
export type LivenessFetcher = (url: string) => Promise<LivenessFetchResult>;

export interface LivenessReviewItem {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly url: string;
  readonly reason: string;
}

export interface LivenessReport {
  readonly live: readonly JobRecord[];
  readonly removed: readonly LivenessCheck[];
  readonly reviewQueue: readonly LivenessReviewItem[];
}

const LIVENESS_CONCURRENCY = 5;

/** Body markers that mean the posting is gone, case-insensitive. Checked only on GET fallback bodies. */
const DEAD_MARKERS = [
  "job expired",
  "this job has expired",
  "no longer available",
  "position has been filled",
  "job not found",
  "posting not found",
  "has been removed",
  "no longer accepting applications",
];

function isLinkedInUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

function reviewItem(record: JobRecord, reason: string): LivenessReviewItem {
  return { id: record.id, title: record.title, company: record.company, url: record.applyUrl, reason };
}

async function checkOne(record: JobRecord, fetchImpl: LivenessFetcher): Promise<LivenessCheck> {
  if (isLinkedInUrl(record.applyUrl)) {
    return { record, verdict: "ambiguous", reason: "linkedin-manual" };
  }
  let result: LivenessFetchResult;
  try {
    result = await fetchImpl(record.applyUrl);
  } catch (error) {
    const reason = error instanceof Error && /abort|timeout/i.test(error.message) ? "timeout" : "fetch-error";
    return { record, verdict: "ambiguous", reason };
  }
  if (result.status === 404 || result.status === 410) {
    return { record, verdict: "dead", reason: `http-${result.status}` };
  }
  if (result.status >= 200 && result.status < 400) {
    if (result.bodyText) {
      const lower = result.bodyText.toLowerCase();
      const marker = DEAD_MARKERS.find((m) => lower.includes(m));
      if (marker) return { record, verdict: "dead", reason: `expired-marker:${marker}` };
    }
    return { record, verdict: "live", reason: `http-${result.status}` };
  }
  // 403/429/5xx and anything else: a signal-less transport outcome. The
  // role stays; a human decides.
  return { record, verdict: "ambiguous", reason: `http-${result.status}` };
}

/**
 * Checks every record. Dead ones come back in `removed`; ambiguous ones
 * stay in `live` AND appear in `reviewQueue` — the digest keeps them, and
 * a human spot-checks them at human pace.
 */
export async function checkLiveness(
  records: readonly JobRecord[],
  fetchImpl: LivenessFetcher,
): Promise<LivenessReport> {
  const checks = await mapWithConcurrency(records, LIVENESS_CONCURRENCY, (record) => checkOne(record, fetchImpl));
  const live: JobRecord[] = [];
  const removed: LivenessCheck[] = [];
  const reviewQueue: LivenessReviewItem[] = [];
  for (const check of checks) {
    if (check.verdict === "dead") {
      removed.push(check);
    } else {
      live.push(check.record);
      if (check.verdict === "ambiguous") reviewQueue.push(reviewItem(check.record, check.reason));
    }
  }
  return { live, removed, reviewQueue };
}

/**
 * Appends ambiguous cases to `logs/liveness-review-queue.jsonl` — id,
 * title, company, url, reason per line — for human-paced Muse browser
 * spot-checks. Appends only; never rewrites history.
 */
export async function appendLivenessReviewQueue(
  items: readonly LivenessReviewItem[],
  queuePath: string,
): Promise<void> {
  if (items.length === 0) return;
  await mkdir(dirname(queuePath), { recursive: true });
  const lines = items.map((item) => JSON.stringify(item)).join("\n");
  await appendFile(queuePath, `${lines}\n`, "utf8");
}

/**
 * The production fetcher: one HEAD, GET fallback when the server refuses
 * HEAD (405/501). Ten-second timeout; GET bodies capped at 64KB. Plain
 * fetch — no extra dependencies.
 */
export async function httpLivenessFetcher(url: string): Promise<LivenessFetchResult> {
  const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
  if (head.status === 405 || head.status === 501) {
    const get = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: { accept: "text/html", range: "bytes=0-65535" },
    });
    const text = await get.text();
    return { status: get.status, bodyText: text.slice(0, 65536) };
  }
  return { status: head.status, bodyText: null };
}
