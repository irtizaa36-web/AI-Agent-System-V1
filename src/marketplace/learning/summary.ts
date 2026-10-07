import type { TrackerDocument } from "../types";
import { pricingStats } from "./sales";
import { BUCKETS } from "../buying/openers";

/**
 * ANALYTICS summary (v3 Phase 4).
 *
 * `marketplace learning summary` prints one block: sales count, average
 * days-to-close, average final-vs-list, negotiation close rate by opener
 * bucket, kill-reasons breakdown, and provider average ratings. All figures
 * come from the learning stores — no live data, no network.
 */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function formatLearningSummary(doc: TrackerDocument): string {
  const lines = ["LEARNING SUMMARY"];
  // Sales (loop #1).
  const sales = pricingStats(doc.learning.pricingHistory);
  lines.push(`SALES: ${sales.sales} recorded`);
  if (sales.sales > 0) {
    lines.push(`  avg days-to-close: ${sales.avgDaysToClose.toFixed(1)}`);
    lines.push(`  avg final-vs-list: ${sales.avgFinalVsList > 0 ? pct(sales.avgFinalVsList) : "n/a"}`);
  }
  // Negotiation close rate by opener bucket (loop #2).
  const outcomes = Object.values(doc.learning.negotiationOutcomes).filter((o) => typeof o.openerPct === "number");
  lines.push(`NEGOTIATION OUTCOMES: ${Object.keys(doc.learning.negotiationOutcomes).length} recorded (${outcomes.length} with opener data)`);
  for (const bucket of BUCKETS) {
    const inBucket = outcomes.filter((o) => o.openerPct! >= bucket.min && o.openerPct! < bucket.max);
    if (inBucket.length === 0) continue;
    const closed = inBucket.filter((o) => o.outcome === "closed").length;
    lines.push(`  opener ${bucket.label}: ${closed}/${inBucket.length} closed (${pct(inBucket.length > 0 ? closed / inBucket.length : 0)})`);
  }
  // Kill reasons (loop #3).
  const kills = doc.learning.huntKills;
  lines.push(`HUNT KILLS: ${kills.length} recorded`);
  if (kills.length > 0) {
    const byReason: Record<string, number> = {};
    for (const k of kills) byReason[k.reason] = (byReason[k.reason] ?? 0) + 1;
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason}: ${count}`);
    }
  }
  // Provider ratings (loop #6).
  const providers = Object.entries(doc.learning.providerTrust);
  lines.push(`PROVIDER RATINGS: ${providers.length} provider(s) rated`);
  for (const [id, trust] of providers.sort((a, b) => b[1].score - a[1].score)) {
    lines.push(`  ${id}: avg ${trust.score.toFixed(2)} (${trust.jobs} job(s))`);
  }
  return lines.join("\n");
}
