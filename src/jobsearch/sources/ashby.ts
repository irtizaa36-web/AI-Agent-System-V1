import type { RawPosting } from "../records";
import { fetchJson, type AtsSourceOptions, type Source } from "./source";

/** Ashby's public job board posting API. */

interface AshbyJob {
  readonly id: string;
  readonly title: string;
  readonly location?: string;
  readonly jobUrl?: string;
  readonly applyUrl?: string;
  readonly descriptionHtml?: string;
  readonly descriptionPlain?: string;
  readonly publishedAt?: string;
  readonly isRemote?: boolean;
  readonly employmentType?: string;
}

interface AshbyResponse {
  readonly jobs?: readonly AshbyJob[];
}

export function ashbyUrl(boardToken: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=true`;
}

export function parseAshby(body: AshbyResponse, company: string, sourceId: string, fetchedAt: string): readonly RawPosting[] {
  return (body.jobs ?? []).map((job) => ({
    sourceId,
    url: job.jobUrl ?? job.applyUrl ?? "",
    title: job.title,
    company,
    // Ashby states remoteness as a flag rather than in the location string;
    // folding it in lets the location classifier see it without a special case.
    location: job.isRemote ? `Remote${job.location ? ` (${job.location})` : ""}` : job.location ?? "",
    body: job.descriptionHtml ?? job.descriptionPlain ?? "",
    postedAt: job.publishedAt ?? null,
    fetchedAt,
  }));
}

export function createAshbySource(company: string, boardToken: string, options: AtsSourceOptions = {}): Source {
  const id = `ashby:${boardToken}`;
  return {
    id,
    company,
    maxAgeDays: options.maxAgeDays,
    priority: options.priority,
    async fetch() {
      const body = await fetchJson<AshbyResponse>(ashbyUrl(boardToken));
      return parseAshby(body, company, id, new Date().toISOString());
    },
  };
}
