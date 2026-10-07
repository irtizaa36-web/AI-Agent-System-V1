import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNotFoundError } from "../store/run-store";

/**
 * The cost ledger. Every model call this pipeline makes appends one line to
 * logs/costs.jsonl, and the run total is printed at the top of the digest.
 *
 * The reason this exists at all: token spend drifts silently. A prompt grows,
 * a filter loosens, a source starts returning 400 postings instead of 40, and
 * nobody notices until the bill does the telling. A number in the digest every
 * morning makes drift visible the day it starts.
 */

/** Per-million-token list prices, as of this build. Cached reads bill at roughly a tenth of input. */
const PRICING: Readonly<Record<string, { readonly input: number; readonly output: number }>> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
};

const CACHE_READ_DISCOUNT = 0.1;

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface CostEntry {
  readonly runId: string;
  readonly ts: string;
  readonly stage: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
}

/**
 * Dollars for one call. An unknown model costs 0 rather than throwing — a
 * pricing table that has fallen behind a model rename must not be able to
 * fail a scheduled run at 8am.
 *
 * Lookup is longest-prefix-match on the PRICING keys, not exact-match: a
 * versioned model id (e.g. a future `claude-haiku-4-5-20251001`) must still
 * bill at its family's rate instead of silently reading $0.00. Genuinely
 * unknown models still cost 0.
 */
export function costOf(model: string, usage: Usage): number {
  const price = priceFor(model);
  if (!price) return 0;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const billedInput = usage.inputTokens + cacheWrite * 1.25 + cacheRead * CACHE_READ_DISCOUNT;

  return (billedInput / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
}

function priceFor(model: string): { readonly input: number; readonly output: number } | undefined {
  let best: { readonly input: number; readonly output: number } | undefined;
  let bestLength = -1;
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key) && key.length > bestLength) {
      best = PRICING[key];
      bestLength = key.length;
    }
  }
  return best;
}

export class CostLedger {
  private readonly entries: CostEntry[] = [];

  constructor(
    private readonly runId: string,
    private readonly path: string,
  ) {}

  async record(stage: string, model: string, usage: Usage): Promise<CostEntry> {
    const entry: CostEntry = {
      runId: this.runId,
      ts: new Date().toISOString(),
      stage,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      costUsd: costOf(model, usage),
    };
    this.entries.push(entry);

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  total(): number {
    return this.entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  totalTokens(): { input: number; output: number } {
    return this.entries.reduce(
      (sum, entry) => ({ input: sum.input + entry.inputTokens, output: sum.output + entry.outputTokens }),
      { input: 0, output: 0 },
    );
  }
}

/** Reads the ledger back, for a "what has this cost me lately" view. */
export async function readLedger(path: string): Promise<readonly CostEntry[]> {
  try {
    const body = await readFile(path, "utf8");
    return body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CostEntry];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}
