import type { RawPosting } from "../records";
import { fetchText, type AtsSourceOptions, type Source } from "./source";

/**
 * Generic RSS/Atom reader for niche and professional-society boards, which
 * almost universally publish a feed. A feed is a publisher saying "please
 * read this automatically" — the politest source there is.
 *
 * Parsed with regex rather than an XML dependency, deliberately: feeds are a
 * narrow, well-shaped subset of XML, and ADR 0002 keeps this project on
 * built-ins until a real need outgrows them.
 */

function unwrap(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagContent(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match?.[1] !== undefined ? unwrap(match[1]) : null;
}

function linkFrom(block: string): string {
  const plain = tagContent(block, "link");
  if (plain && plain.length > 0) return plain;
  const href = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block);
  return href?.[1] ?? "";
}

/** Pure: feed XML -> postings. Handles both RSS `item` and Atom `entry`. */
export function parseFeed(xml: string, company: string | null, sourceId: string, fetchedAt: string): readonly RawPosting[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];

  return blocks
    .map((block) => {
      const title = tagContent(block, "title") ?? "";
      const published = tagContent(block, "pubDate") ?? tagContent(block, "published") ?? tagContent(block, "updated");
      const parsedDate = published ? new Date(published) : null;
      return {
        sourceId,
        url: linkFrom(block),
        title,
        // A feed rarely separates company from title; the caller supplies it
        // for a single-company feed, and otherwise the title carries it.
        company: company ?? (title.split(/\s+(?:at|@)\s+/i)[1] ?? "").trim(),
        location: tagContent(block, "location") ?? "",
        body: tagContent(block, "content:encoded") ?? tagContent(block, "description") ?? tagContent(block, "summary") ?? "",
        postedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
        fetchedAt,
      };
    })
    .filter((posting) => posting.title.length > 0 && posting.url.length > 0);
}

export function createFeedSource(company: string | null, feedUrl: string, options: AtsSourceOptions = {}): Source {
  const id = `feed:${feedUrl}`;
  return {
    id,
    company,
    maxAgeDays: options.maxAgeDays,
    priority: options.priority,
    async fetch() {
      const xml = await fetchText(feedUrl);
      return parseFeed(xml, company, id, new Date().toISOString());
    },
  };
}
