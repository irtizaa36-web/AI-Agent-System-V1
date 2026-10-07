import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/**
 * The evidence ledger for a tailored resume draft (Stage 11).
 *
 * ADR 0029 shipped the draft step with a structural no-fabrication rule but

 * no post-draft verification: the model was told not to invent, and nobody
 * checked. This module is the check. After a draft is written, every claim
 * in it is extracted and classified against the base resume, deterministically
 * (no model, no judgment calls, no cost):
 *
 * - `confirmed` — the claim's wording (or a 3+ word phrase of it) appears in
 *   the base resume, or every metric it states appears in the resume's
 *   stated metrics. Traceable, verbatim.
 * - `supportable` — part of the claim matches (a distinctive phrase), but
 *   not enough to call it confirmed. Plausibly a rewording; review by eye.
 * - `unsupported` — nothing in the claim traces to the resume. Flagged
 *   prominently at approval time. This is the fabrication detector, and it
 *   is deliberately conservative: a heavily reworded-but-true claim can land
 *   here, because a ledger that waves fabrications through is worse than one
 *   that asks a human to glance twice.
 *
 * The ledger is written next to the draft at
 * `profile/<name>/tailored/<job-id>.ledger.json`, born `pending-approval`.
 * Nothing becomes exportable/ready before `jobs tailor --approve --job <id>
 * --confirm` — the approval renders the base-vs-tailored diff, flags the
 * unsupported claims, and only the explicit confirmation flips the ledger
 * (and the application record) to ready. Fail closed throughout.
 */

export const LEDGER_SUFFIX = ".ledger.json";

export type ClaimVerdict = "confirmed" | "supportable" | "unsupported";
export type LedgerStatus = "pending-approval" | "ready";

export interface ResumeFacts {
  /** Employer-looking lines from the experience section (deterministic heuristic, documented below). */
  readonly employers: readonly string[];
  readonly titles: readonly string[];
  readonly dates: readonly string[];
  readonly metrics: readonly string[];
  readonly degrees: readonly string[];
  readonly skills: readonly string[];
}

export interface LedgerClaimCheck {
  /** The draft bullet/sentence, as written. */
  readonly text: string;
  readonly verdict: ClaimVerdict;
  /** Resume phrases or metrics that matched — the evidence, so a reviewer can see why. */
  readonly evidence: readonly string[];
}

export interface TailorLedger {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly generatedAt: string;
  readonly draftPath: string;
  /** SHA-256 of the exact base resume text the draft was checked against. */
  readonly baseResumeSha256: string;
  readonly resumeFacts: ResumeFacts;
  readonly claims: readonly LedgerClaimCheck[];
  readonly unsupportedCount: number;
  readonly status: LedgerStatus;
  readonly approvedAt: string | null;
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,by,at,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,may,might,must,shall,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,their,our,your,my,me,us,him,who,which,what,when,where,how,not,no,yes,if,then,than,so,such,into,out,up,down,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,only,own,same,too,very,just,also,via,per,including,include,includes,included,across,through,during,before,after,between,within,without,using,used,use,based,well,highly,strong,proven,skilled,experienced,detail,oriented,passionate,results,driven"
    .split(","),
);

/** Lowercase, strip punctuation, drop stopwords — the canonical form both sides are compared in. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s%$.,]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .join(" ");
}

/** Sliding windows of n significant words over the normalized text. */
function phraseWindows(normalized: string, n: number): string[] {
  const words = normalized.split(" ").filter(Boolean);
  const windows: string[] = [];
  for (let i = 0; i + n <= words.length; i++) windows.push(words.slice(i, i + n).join(" "));
  return windows;
}

const DATE_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b|\b(?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|present|current)\b/gi;
const METRIC_RE = /\$[\d,]+(?:\.\d+)?[KMB]?\b|\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*percent\b|\b\d+(?:\.\d+)?[KMB]\b|\b\d+(?:\.\d+)?x\b/gi;
const DEGREE_RE = /\b(?:B\.?\s*A\.?|B\.?\s*S\.?|BBA|M\.?\s*A\.?|M\.?\s*S\.?|MBA|Ph\.?\s*D\.?|J\.?\s*D\.?)\b[^.\n]{0,60}/gi;
const TITLE_WORDS = /\b(manager|director|engineer|analyst|lead|specialist|coordinator|associate|consultant|strategist|marketer|designer|developer|architect|owner|head|vp|vice president|president|intern|assistant)\b/i;

/**
 * Deterministic fact extraction from the base resume. Dates, metrics,
 * degrees, and skills are regex-solid; employers/titles are a documented
 * heuristic (lines in the experience section carrying a date range, split on
 * the usual separators). This is evidence for the ledger, not a parse anyone
 * should build payroll on — the claim classifier below does the real work.
 */
export function extractResumeFacts(resume: string): ResumeFacts {
  const dates = [...new Set(resume.match(DATE_RE) ?? [])].map((d) => d.replace(/\s+/g, " ").trim());
  const metrics = [...new Set(resume.match(METRIC_RE) ?? [])].map((m) => m.replace(/\s+/g, "").toLowerCase());
  const degrees = [...new Set(resume.match(DEGREE_RE) ?? [])].map((d) => d.replace(/\s+/g, " ").trim());

  const skills: string[] = [];
  const skillsMatch = resume.match(/^#{0,3}\s*skills\b[^\n]*\n([\s\S]{0,600})/im);
  if (skillsMatch?.[1]) {
    const block = skillsMatch[1].split(/\n#{1,3}\s/m)[0] ?? "";
    for (const part of block.split(/[,|•·;]/)) {
      const skill = part.replace(/[*_`]/g, "").trim();
      if (skill.length > 1 && skill.length < 60) skills.push(skill);
    }
  }

  const employers: string[] = [];
  const titles: string[] = [];
  const lines = resume.split("\n");
  let inExperience = false;
  for (const line of lines) {
    if (/^#{1,3}\s*(experience|work history|employment|professional experience)\b/i.test(line)) {
      inExperience = true;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) inExperience = false;
    if (!inExperience) continue;
    const clean = line.replace(/[*_`>#]/g, "").trim();
    if (!/\b(?:19|20)\d{2}\b|\bpresent\b|\bcurrent\b/i.test(clean)) continue;
    const beforeDate = clean.split(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b|\b(?:19|20)\d{2}\b/i)[0] ?? "";
    const parts = beforeDate
      .split(/[—–|•·]/)
      .map((p) => p.replace(/,$/, "").trim())
      .filter((p) => p.length > 1);
    if (parts.length === 0) continue;
    employers.push(parts[0] as string);
    for (const part of parts.slice(1)) {
      if (TITLE_WORDS.test(part)) titles.push(part);
    }
  }

  return {
    employers: [...new Set(employers)],
    titles: [...new Set(titles)],
    dates,
    metrics,
    degrees,
    skills: [...new Set(skills)],
  };
}

function extractMetrics(text: string): string[] {
  return [...new Set(text.match(METRIC_RE) ?? [])].map((m) => m.replace(/\s+/g, "").toLowerCase());
}

/**
 * Pulls the checkable claims out of a draft: bullets and sentences, minus the
 * stamp header (blockquotes, the DRAFT heading) and the ## Gaps section (it
 * names what the resume does NOT cover — checking it against the resume
 * would manufacture false unsupported flags).
 */
export function extractDraftClaims(draftMarkdown: string): readonly string[] {
  const claims: string[] = [];
  let inGaps = false;
  for (const line of draftMarkdown.split("\n")) {
    if (/^#{1,3}\s*gaps\b/i.test(line)) {
      inGaps = true;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) inGaps = false;
    if (inGaps) continue;
    if (/^\s*>/.test(line)) continue; // stamp header
    if (/^#\s*draft\b/i.test(line)) continue;
    if (/^#{1,3}\s/.test(line)) continue; // section headings aren't claims
    const text = line
      .replace(/^\s*[-*•·\d.)]+\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (text.length >= 12) claims.push(text);
  }
  return claims;
}

/**
 * Classifies one draft claim against the base resume text.
 *
 * Order matters: metrics first. A claim that states a number the resume
 * never states is unsupported no matter how many ordinary words match —
 * invented metrics are the fabrication that costs a candidacy.
 */
export function classifyClaim(
  claim: string,
  resumeText: string,
): { readonly verdict: ClaimVerdict; readonly evidence: readonly string[] } {
  const resumeNorm = ` ${normalizeText(resumeText)} `;
  const claimNorm = normalizeText(claim);
  const significantWords = claimNorm.split(" ").filter(Boolean);

  if (significantWords.length < 4) {
    return { verdict: "supportable", evidence: ["too short to check — review by eye"] };
  }

  const claimMetrics = extractMetrics(claim);
  if (claimMetrics.length > 0) {
    const resumeMetrics = new Set(extractMetrics(resumeText));
    const matched = claimMetrics.filter((m) => resumeMetrics.has(m));
    if (matched.length === 0) {
      return { verdict: "unsupported", evidence: [`states ${claimMetrics.join(", ")} — not in the resume`] };
    }
    if (matched.length === claimMetrics.length) {
      return { verdict: "confirmed", evidence: matched.map((m) => `metric ${m} stated in resume`) };
    }
    // Some metrics match, some don't: supportable, with the gap named.
    return {
      verdict: "supportable",
      evidence: [
        `matched ${matched.join(", ")}`,
        `UNMATCHED: ${claimMetrics.filter((m) => !resumeMetrics.has(m)).join(", ")} — verify by eye`,
      ],
    };
  }

  const windows3 = phraseWindows(claimNorm, 3);
  const confirmedPhrases = windows3.filter((phrase) => resumeNorm.includes(` ${phrase} `));
  if (confirmedPhrases.length > 0 || resumeNorm.includes(` ${claimNorm} `)) {
    return { verdict: "confirmed", evidence: confirmedPhrases.slice(0, 3) };
  }

  const windows2 = phraseWindows(claimNorm, 2);
  const matched2 = windows2.filter((phrase) => resumeNorm.includes(` ${phrase} `));
  if (matched2.length > 0) {
    return { verdict: "supportable", evidence: [...new Set(matched2)].slice(0, 3) };
  }

  return { verdict: "unsupported", evidence: [] };
}

/** The draft body without the stamp header — what the diff and the claims are computed from. */
export function stripDraftHeader(draftMarkdown: string): string {
  const lines = draftMarkdown.split("\n");
  let i = 0;
  while (i < lines.length && (/^#\s*draft\b/i.test(lines[i] as string) || /^\s*>/.test(lines[i] as string) || (lines[i] as string).trim() === "")) {
    i++;
  }
  return lines.slice(i).join("\n").trim();
}

/** Builds the ledger for a fresh draft. Status is always pending-approval at birth. */
export function buildLedger(options: {
  readonly jobId: string;
  readonly jobTitle: string;
  readonly company: string;
  readonly resume: string;
  readonly draftMarkdown: string;
  readonly draftPath: string;
  readonly generatedAt?: Date;
}): TailorLedger {
  const generatedAt = options.generatedAt ?? new Date();
  const claims = extractDraftClaims(options.draftMarkdown).map((text) => {
    const { verdict, evidence } = classifyClaim(text, options.resume);
    return { text, verdict, evidence };
  });
  return {
    schemaVersion: 1,
    jobId: options.jobId,
    jobTitle: options.jobTitle,
    company: options.company,
    generatedAt: generatedAt.toISOString(),
    draftPath: options.draftPath,
    baseResumeSha256: createHash("sha256").update(options.resume, "utf8").digest("hex"),
    resumeFacts: extractResumeFacts(options.resume),
    claims,
    unsupportedCount: claims.filter((c) => c.verdict === "unsupported").length,
    status: "pending-approval",
    approvedAt: null,
  };
}

/**
 * Marks a pending ledger ready. Fail closed: anything that is not
 * pending-approval comes back unchanged — there is no path from a missing,
 * already-ready, or tampered ledger to ready except the explicit approval.
 */
export function approveLedger(ledger: TailorLedger, now = new Date()): TailorLedger {
  if (ledger.status !== "pending-approval") return ledger;
  return { ...ledger, status: "ready", approvedAt: now.toISOString() };
}

export function ledgerPathFor(tailoredDir: string, safeJobId: string): string {
  return `${tailoredDir}/${safeJobId}${LEDGER_SUFFIX}`;
}

export async function writeLedger(path: string, ledger: TailorLedger): Promise<void> {
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export async function readLedger(path: string): Promise<TailorLedger> {
  return JSON.parse(await readFile(path, "utf8")) as TailorLedger;
}

/**
 * A deterministic unified diff of the base resume against the draft body
 * (LCS over lines, 3 lines of context). Dependency-free on purpose — this
 * runs at approval time on a human's machine, and the diff is the review
 * surface, so it must never depend on a model or a network call.
 */
export function renderResumeDiff(baseResume: string, draftBody: string): string {
  const a = baseResume.split("\n");
  const b = stripDraftHeader(draftBody).split("\n");

  if (a.length > 1500 || b.length > 1500) {
    const inA = new Set(a.map((l) => l.trim()).filter(Boolean));
    const onlyInDraft = [...new Set(b.map((l) => l.trim()).filter((l) => l && !inA.has(l)))];
    return ["(resumes too long for a line diff — lines present only in the draft:)", ...onlyInDraft.map((l) => `+ ${l}`)].join("\n");
  }

  // LCS table.
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }

  type Op = { readonly kind: "same" | "del" | "add"; readonly line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] as string });
      i++;
      j++;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      ops.push({ kind: "del", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] as string });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "del", line: a[i++] as string });
  while (j < b.length) ops.push({ kind: "add", line: b[j++] as string });

  // Emit hunks with 3 lines of context.
  const CONTEXT = 3;
  const out: string[] = ["--- base resume", "+++ tailored draft"];
  let hunk: Op[] = [];
  const flush = (): void => {
    const changes = hunk.filter((op) => op.kind !== "same");
    if (changes.length === 0) {
      hunk = [];
      return;
    }
    let start = 0;
    while (start < hunk.length && hunk[start]!.kind === "same") start++;
    let end = hunk.length;
    while (end > start && hunk[end - 1]!.kind === "same") end--;
    const trimmed = hunk.slice(Math.max(0, start - CONTEXT), Math.min(hunk.length, end + CONTEXT));
    out.push("@@");
    for (const op of trimmed) {
      out.push(`${op.kind === "same" ? " " : op.kind === "del" ? "-" : "+"} ${op.line}`);
    }
    hunk = [];
  };

  for (const op of ops) {
    if (op.kind === "same" && hunk.length > 0) {
      const trailing = hunk.slice(-CONTEXT).every((o) => o.kind === "same") ? 0 : 1;
      void trailing;
    }
    hunk.push(op);
    const sames = hunk.filter((o) => o.kind === "same").length;
    if (op.kind === "same" && sames > CONTEXT * 2) {
      // Long unchanged run: split the hunk here.
      const keep = hunk.splice(hunk.length - CONTEXT);
      flush();
      hunk = keep;
    }
  }
  flush();
  return out.join("\n");
}
