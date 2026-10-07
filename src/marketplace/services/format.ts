import type { ServiceRequest } from "../types";
import { compareProviders, type ComparisonResult } from "./requests";

/**
 * SERVICES — quote comparison rendering (v3 plan §4).
 * Pure function over state + a format helper; the ranking logic is in
 * compareProviders() so it can be tested without the printer.
 */

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Side-by-side comparison table plus the one-line recommendation. */
export function formatComparison(request: ServiceRequest): string {
  const result: ComparisonResult = compareProviders(request);
  const lines: string[] = [
    `QUOTE COMPARISON — request ${request.id} (${request.serviceType})`,
    `  specs: ${request.specs}`,
    `  budget: $${request.budgetCeiling} · window: ${request.timingWindow}`,
    "",
  ];
  if (result.rows.length === 0) {
    lines.push("  (no quotes yet)");
  } else {
    const headers = ["PROVIDER", "QUOTE", "SCREENED", "REF AVG", "AVAILABILITY", "FLAGS"];
    const rows = result.rows.map((r) => [
      r.providerName,
      r.vsBudget,
      r.screened ? "yes" : "no",
      r.referenceAvg !== undefined ? `${r.referenceAvg.toFixed(1)}/5 (${r.referenceCount})` : "—",
      r.availabilityFit,
      r.redFlags.length > 0 ? `RED: ${r.redFlags.join("; ")}` : "none",
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    lines.push("  " + headers.map((h, i) => pad(h, widths[i])).join("  "));
    for (const r of rows) lines.push("  " + r.map((c, i) => pad(c, widths[i])).join("  "));
    for (const r of result.rows) {
      if (!r.qualified) lines.push(`  ✕ ${r.providerName}: ${r.disqualifiedReason}`);
    }
  }
  lines.push("");
  lines.push(result.recommendation);
  return lines.join("\n");
}
