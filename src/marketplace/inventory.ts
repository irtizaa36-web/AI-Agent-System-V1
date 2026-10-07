import type { TrackerDocument } from "./types";

/**
 * INVENTORY readout (v3 plan §10, Phase 4).
 *
 * A persistent inventory of everything Toozy hands the agent, across all
 * three lanes — it survives listing deletion. `marketplace inventory`
 * prints the compact grouped readout; the daily digest appends rows that
 * changed in the window.
 */

function itemLine(i: { name: string; status: string; listPrice?: number; soldPrice?: number }): string {
  const price = i.soldPrice !== undefined ? `sold $${i.soldPrice}` : i.listPrice !== undefined ? `$${i.listPrice}` : "no price";
  return `  [${i.status}] ${i.name} — ${price}`;
}

function serviceLine(s: { name: string; status: string; quotesReceived: number; cost?: number }): string {
  const cost = s.cost !== undefined ? ` — $${s.cost}` : "";
  return `  [${s.status}] ${s.name} — ${s.quotesReceived} quote(s)${cost}`;
}

function huntLine(h: { name: string; status: string; ceiling?: number }): string {
  const ceiling = h.ceiling !== undefined ? ` — ceiling $${h.ceiling}` : "";
  return `  [${h.status}] ${h.name}${ceiling}`;
}

/** Compact grouped readout: items for sale → service requests → wanted-item hunts. */
export function formatInventory(doc: TrackerDocument): string {
  const lines = ["INVENTORY"];
  lines.push(`ITEMS FOR SALE (${doc.inventory.items.length}):`);
  if (doc.inventory.items.length === 0) lines.push("  (none)");
  for (const i of doc.inventory.items) lines.push(itemLine(i));
  lines.push(`SERVICE REQUESTS (${doc.inventory.services.length}):`);
  if (doc.inventory.services.length === 0) lines.push("  (none)");
  for (const s of doc.inventory.services) lines.push(serviceLine(s));
  lines.push(`WANTED-ITEM HUNTS (${doc.inventory.hunts.length}):`);
  if (doc.inventory.hunts.length === 0) lines.push("  (none)");
  for (const h of doc.inventory.hunts) lines.push(huntLine(h));
  return lines.join("\n");
}

/** Inventory rows whose status/price changed since `sinceIso` — for the digest. */
export function changedInventoryRows(doc: TrackerDocument, sinceIso: string): string[] {
  const lines: string[] = [];
  for (const i of doc.inventory.items) if (i.updatedAt >= sinceIso) lines.push(`  item: ${itemLine(i)}`);
  for (const s of doc.inventory.services) if (s.updatedAt >= sinceIso) lines.push(`  service: ${serviceLine(s)}`);
  for (const h of doc.inventory.hunts) if (h.updatedAt >= sinceIso) lines.push(`  hunt: ${huntLine(h)}`);
  return lines;
}
