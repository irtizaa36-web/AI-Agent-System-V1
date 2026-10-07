import { execFile } from "node:child_process";
import type { ServiceRequest } from "../types";
import {
  REFERENCE_CENTER,
  REFERENCE_RADIUS_MILES,
} from "../pricing/reference";

/**
 * SERVICES — live provider discovery (v3 Phase 3, wired).
 *
 * `services discover --request <id>` executes real read-only
 * `facebook-cli marketplace search` calls against the request's criteria
 * and returns live candidate providers. Mirrors the selling/comps.ts seam
 * pattern: the network runner is injectable so tests never hit the
 * network; the CLI passes the real runner.
 *
 * Radius center is ALWAYS the public-meetup area (Highland Village) —
 * his street address appears nowhere in code, comments, or tests.
 */

export interface DiscoveredProvider {
  readonly listingId: string;
  readonly title: string;
  readonly price?: number;
  readonly location?: string;
  readonly distance?: string;
  readonly sellerId: string;
  readonly productUrl: string;
  readonly description?: string;
}

/** Runs `facebook-cli ...`. Injected so tests never hit the network. */
export type DiscoverySearchRunner = (args: readonly string[]) => Promise<string>;

export function realDiscoverySearchRunner(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "facebook-cli",
      [...args],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`facebook-cli search failed: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

function parsePrice(raw: unknown): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    const m = raw.replace(/,/g, "").match(/\d+(\.\d{1,2})?/);
    if (m) {
      const n = Number(m[0]);
      return n > 0 ? n : undefined;
    }
  }
  return undefined;
}

/** Parse one `marketplace search` JSON payload into candidates. Pure. */
export function parseDiscoveryResults(stdout: string): DiscoveredProvider[] {
  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
    if (!Array.isArray(items)) return [];
    const out: DiscoveredProvider[] = [];
    for (const item of items) {
      const listingId = typeof item?.listing_id === "string" ? item.listing_id : "";
      const title = typeof item?.title === "string" ? item.title : "";
      const sellerId = typeof item?.seller_id === "string" ? item.seller_id : "";
      if (!listingId || !title || !sellerId) continue;
      out.push({
        listingId,
        title,
        price: parsePrice(item?.price),
        location: typeof item?.location === "string" ? item.location : undefined,
        distance: typeof item?.distance === "string" ? item.distance : undefined,
        sellerId,
        productUrl:
          typeof item?.product_url === "string"
            ? item.product_url
            : `https://www.facebook.com/marketplace/item/${listingId}`,
        description: typeof item?.description === "string" ? item.description : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Search queries for a service request. Cleaning uses fixed service
 * terms; home services lead with the request's own specs (truncated) and
 * fall back to generic trade terms so a hyper-specific spec still
 * returns candidates.
 */
export function buildDiscoveryQueries(request: ServiceRequest): string[] {
  if (request.serviceType === "cleaning") {
    return ["house cleaning", "deep cleaning", "cleaning service"];
  }
  const specQuery = request.specs.trim().slice(0, 60);
  const queries = [specQuery, "TV mounting", "handyman", "home repair"];
  return [...new Set(queries.filter((q) => q.length > 0))];
}

/** Max listings kept per query — bounds the network fan-out. */
export const DISCOVERY_LIMIT_PER_QUERY = 10;
/** Max total candidates returned after dedupe. */
export const DISCOVERY_MAX_CANDIDATES = 15;

function searchArgs(query: string): string[] {
  return [
    "marketplace",
    "search",
    "--query",
    query,
    "--latitude",
    String(REFERENCE_CENTER.latitude),
    // Single arg with `=`: a bare "-95.44716" would parse as a flag.
    `--longitude=${REFERENCE_CENTER.longitude}`,
    "--radius-in-miles",
    String(REFERENCE_RADIUS_MILES),
    "--limit",
    String(DISCOVERY_LIMIT_PER_QUERY),
  ];
}

export interface DiscoveryPass {
  readonly candidates: DiscoveredProvider[];
  /** Parsed results per query, in query order — feeds cross-post counting with zero extra network. */
  readonly perQuery: DiscoveredProvider[][];
  readonly queries: string[];
}

/**
 * Run the discovery searches and return deduplicated live candidates
 * (first sighting wins) plus the raw per-query results. A failed query
 * degrades to "no results for that query" — one bad query never kills
 * the whole discovery pass.
 */
export async function discoverProvidersWithQueries(
  request: ServiceRequest,
  runner: DiscoverySearchRunner = realDiscoverySearchRunner,
): Promise<DiscoveryPass> {
  const queries = buildDiscoveryQueries(request);
  const perQuery: DiscoveredProvider[][] = [];
  const seen = new Map<string, DiscoveredProvider>();
  for (const query of queries) {
    let stdout: string;
    try {
      stdout = await runner(searchArgs(query));
    } catch {
      perQuery.push([]);
      continue;
    }
    const parsed = parseDiscoveryResults(stdout);
    perQuery.push(parsed);
    for (const candidate of parsed) {
      if (!seen.has(candidate.listingId)) seen.set(candidate.listingId, candidate);
      if (seen.size >= DISCOVERY_MAX_CANDIDATES) break;
    }
    if (seen.size >= DISCOVERY_MAX_CANDIDATES) break;
  }
  return { candidates: [...seen.values()], perQuery, queries };
}

/**
 * Run the discovery searches and return deduplicated live candidates
 * (first sighting wins). A failed query degrades to "no results for that
 * query" — one bad query never kills the whole discovery pass.
 */
export async function discoverProviders(
  request: ServiceRequest,
  runner: DiscoverySearchRunner = realDiscoverySearchRunner,
): Promise<DiscoveredProvider[]> {
  return (await discoverProvidersWithQueries(request, runner)).candidates;
}

/** One compact printable line per candidate for the CLI. */
export function formatCandidate(c: DiscoveredProvider, trust?: string): string {
  const price = c.price !== undefined ? `$${c.price}` : "price on ask";
  const where = [c.location, c.distance].filter(Boolean).join(" · ");
  const score = trust !== undefined ? ` | trust ${trust}` : "";
  return `- "${c.title}" — ${price}${where ? ` (${where})` : ""}${score}\n  ${c.productUrl}`;
}
