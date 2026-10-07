import type { RawPosting } from "../records";
import { fetchJson, type AtsSourceOptions, type Source } from "./source";

/** Lever's public postings API — structured JSON, published for public consumption. */

interface LeverPosting {
  readonly id: string;
  readonly text: string;
  readonly hostedUrl: string;
  readonly createdAt?: number;
  readonly categories?: { readonly location?: string; readonly commitment?: string };
  readonly description?: string;
  readonly descriptionPlain?: string;
  readonly lists?: readonly { readonly text?: string; readonly content?: string }[];
}

export function leverUrl(boardToken: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
}

export function parseLever(postings: readonly LeverPosting[], company: string, sourceId: string, fetchedAt: string): readonly RawPosting[] {
  return postings.map((posting) => {
    // Lever splits requirements and responsibilities into `lists`; the
    // description alone omits exactly the content the scorer needs most.
    const lists = (posting.lists ?? []).map((list) => `${list.text ?? ""}\n${list.content ?? ""}`).join("\n");
    return {
      sourceId,
      url: posting.hostedUrl,
      title: posting.text,
      company,
      location: posting.categories?.location ?? "",
      body: `${posting.description ?? posting.descriptionPlain ?? ""}\n${lists}`,
      postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
      fetchedAt,
    };
  });
}

export function createLeverSource(company: string, boardToken: string, options: AtsSourceOptions = {}): Source {
  const id = `lever:${boardToken}`;
  return {
    id,
    company,
    maxAgeDays: options.maxAgeDays,
    priority: options.priority,
    async fetch() {
      const body = await fetchJson<readonly LeverPosting[]>(leverUrl(boardToken));
      return parseLever(Array.isArray(body) ? body : [], company, id, new Date().toISOString());
    },
  };
}
