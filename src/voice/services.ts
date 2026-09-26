/**
 * The services a verification text might name. A message "names" a service
 * when one of its aliases appears as a whole word, ignoring case. The
 * catalog only needs to be good enough to notice a code that names
 * a *different* service than the one the agent is waiting on. A pending
 * verification can always add its own aliases for anything not listed here.
 */
export const SERVICE_CATALOG: Readonly<Record<string, readonly string[]>> = {
  google: ["google", "gmail", "youtube"],
  microsoft: ["microsoft", "outlook", "xbox"],
  apple: ["apple", "icloud", "apple id"],
  amazon: ["amazon"],
  facebook: ["facebook", "meta", "marketplace"],
  instagram: ["instagram"],
  whatsapp: ["whatsapp"],
  offerup: ["offerup"],
  craigslist: ["craigslist"],
  nextdoor: ["nextdoor"],
  uber: ["uber"],
  lyft: ["lyft"],
  doordash: ["doordash"],
  instacart: ["instacart"],
  prolific: ["prolific"],
  swagbucks: ["swagbucks"],
  surveyjunkie: ["survey junkie", "surveyjunkie"],
  userinterviews: ["user interviews", "userinterviews"],
  respondent: ["respondent"],
  discord: ["discord"],
  telegram: ["telegram"],
  tiktok: ["tiktok"],
  linkedin: ["linkedin"],
  paypal: ["paypal"],
  venmo: ["venmo"],
  cashapp: ["cash app", "cashapp"],
  zelle: ["zelle"],
  x: ["x", "twitter", "x.com", "x corp"],
  polymarket: ["polymarket"],
  kalshi: ["kalshi"],
  coinbase: ["coinbase"],
  chase: ["chase", "jpmorgan"],
  bankofamerica: ["bank of america", "boa", "bofa"],
  wellsfargo: ["wells fargo", "wellsfargo"],
  citi: ["citi", "citibank"],
  capitalone: ["capital one"],
  usbank: ["us bank", "u.s. bank"],
  pnc: ["pnc"],
  usaa: ["usaa"],
  truist: ["truist"],
  bank: ["bank"],
  medical: ["doctor", "dr", "appointment", "clinic", "hospital", "prescription", "pharmacy", "labcorp", "quest", "quest diagnostics"],
};

/**
 * Services that must never be verified through the Voice number (ADR 0023):
 * X blocks VoIP numbers outright, and banks, payment apps and trading or
 * betting exchanges get the real mobile. The broker refuses to open a
 * pending verification for these, so their codes always raise an alert.
 */
export const REAL_MOBILE_ONLY: ReadonlySet<string> = new Set([
  "x",
  "paypal",
  "venmo",
  "cashapp",
  "zelle",
  "polymarket",
  "kalshi",
  "coinbase",
  "chase",
  "bankofamerica",
  "wellsfargo",
  "citi",
  "capitalone",
  "usbank",
  "pnc",
  "usaa",
  "truist",
  "bank",
]);

/**
 * Never verified through the Voice number at all (ADR 0023): nothing
 * medical goes through Voice or AgentMail — residency, credentialing and
 * NPI stay on real contacts. The broker refuses to open a pending
 * verification for these, so their codes always raise an alert.
 */
export const NEVER_VERIFY: ReadonlySet<string> = new Set(["medical"]);

export function normalizeService(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function defaultAliases(service: string): readonly string[] {
  const key = normalizeService(service);
  return SERVICE_CATALOG[key] ?? [key];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namesAlias(text: string, alias: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias.toLowerCase())}($|[^a-z0-9])`);
  return pattern.test(text.toLowerCase());
}

/** Every service a message names, from the catalog plus any extra alias lists supplied (the open pending verifications). */
export function servicesNamed(text: string, extra: Readonly<Record<string, readonly string[]>> = {}): ReadonlySet<string> {
  const named = new Set<string>();
  for (const [service, aliases] of [...Object.entries(SERVICE_CATALOG), ...Object.entries(extra)]) {
    if (aliases.some((alias) => namesAlias(text, alias))) named.add(service);
  }
  return named;
}
