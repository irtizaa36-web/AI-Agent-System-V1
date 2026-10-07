import type { RawPosting } from "../records";
import { fetchJson, type AtsSourceOptions, type Source } from "./source";

/**
 * Greenhouse's public job board API. No key, no scraping, no robots.txt
 * question — this is the endpoint Greenhouse publishes for exactly this
 * purpose, and it returns structured JSON rather than a page to parse.
 */

interface GreenhouseJob {
  readonly id: number;
  readonly title: string;
  readonly absolute_url: string;
  readonly updated_at?: string;
  readonly location?: { readonly name?: string };
  /** HTML, with its angle brackets entity-escaped. */
  readonly content?: string;
}

interface GreenhouseResponse {
  readonly jobs?: readonly GreenhouseJob[];
}

export function greenhouseUrl(boardToken: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
}

/** Greenhouse double-escapes its HTML; undo that before the normalizer sees it. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pure: response body -> postings. Tested without a network call. */
export function parseGreenhouse(body: GreenhouseResponse, company: string, sourceId: string, fetchedAt: string): readonly RawPosting[] {
  return (body.jobs ?? []).map((job) => ({
    sourceId,
    url: job.absolute_url,
    title: job.title,
    company,
    location: job.location?.name ?? "",
    body: decodeEntities(job.content ?? ""),
    postedAt: job.updated_at ?? null,
    fetchedAt,
  }));
}

export function createGreenhouseSource(company: string, boardToken: string, options: AtsSourceOptions = {}): Source {
  const id = `greenhouse:${boardToken}`;
  return {
    id,
    company,
    maxAgeDays: options.maxAgeDays,
    priority: options.priority,
    async fetch() {
      const body = await fetchJson<GreenhouseResponse>(greenhouseUrl(boardToken));
      return parseGreenhouse(body, company, id, new Date().toISOString());
    },
  };
}
