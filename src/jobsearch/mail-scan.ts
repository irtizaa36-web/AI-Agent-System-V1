import { readFile } from "node:fs/promises";
import type { ApplicationRecord, ApplicationStatus, JobRecord } from "./records";
import { normalizeCompany } from "./affinity";

/**
 * Read-only recruiting-mail scan (Stage 14 CRM).
 *
 * Boundary: this module READS and PROPOSES. `jobs mail-scan --dry-run`
 * classifies recent mail and proposes links to tracked applications; it
 * writes nothing, transitions nothing, and never sends. Applying a proposal
 * is her explicit tap via `jobs stage`. See ADR 0021.
 *
 * Gmail access itself lives outside this repository: the approved operator
 * (her Gmail, her tap) dumps messages to a JSON file and the CLI reads that
 * file. This module never holds credentials and never touches the network.
 */

/** One message from the reader port. */
export interface MailMessage {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly date: string | null;
  readonly snippet: string;
}

/** The reader port. Production uses JsonFileMailReader; tests use fakes. */
export interface MailReader {
  readMessages(): Promise<readonly MailMessage[]>;
}

/**
 * Reads a JSON file shaped as an array of MailMessage objects — the format
 * the Gmail-side export produces. Malformed entries are skipped
 * individually; a missing/unparseable file is an error (the operator should
 * know the export failed, not silently see an empty scan).
 */
export class JsonFileMailReader implements MailReader {
  constructor(private readonly path: string) {}

  async readMessages(): Promise<readonly MailMessage[]> {
    const body = await readFile(this.path, "utf8");
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error(`Mail export at ${this.path} is not an array.`);
    const messages: MailMessage[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry["id"] === "string" ? entry["id"] : null;
      const from = typeof entry["from"] === "string" ? entry["from"] : "";
      const subject = typeof entry["subject"] === "string" ? entry["subject"] : "";
      if (!id) continue;
      const date = typeof entry["date"] === "string" ? entry["date"] : null;
      const snippet = typeof entry["snippet"] === "string" ? entry["snippet"] : "";
      messages.push({ id, from, subject, date, snippet });
    }
    return messages;
  }
}

export type MailClassification = "recruiting" | "application-update" | "interview" | "not-recruiting";

/** Sender domains that exist to move candidates through funnels. */
const ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workday.com",
  "myworkdayjobs.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
  "taleo.net",
  "workable.com",
  "breezy.hr",
  "jazzhr.com",
  "linkedin.com",
  "indeed.com",
];

const REJECTION_MARKERS = [
  "not moving forward",
  "decided not to move forward",
  "decided to move forward with other",
  "unfortunately",
  "will not be moving forward",
  "pursue other candidates",
];

const INTERVIEW_MARKERS = [
  "interview",
  "phone screen",
  "final round",
  "onsite",
  "on-site",
  "meet the team",
  "next steps",
];

const APPLICATION_MARKERS = [
  "your application",
  "application received",
  "thank you for applying",
  "application update",
  "we received your",
];

/**
 * Deterministic keyword classification. Order matters: an explicit
 * rejection marker beats a generic application marker, and interview
 * language beats both — a "your interview is confirmed" mail is not an
 * application update.
 */
export function classifyRecruitingMail(message: MailMessage): MailClassification {
  const haystack = `${message.from}\n${message.subject}\n${message.snippet}`.toLowerCase();
  const fromDomain = (message.from.match(/@([a-z0-9.-]+)/i)?.[1] ?? "").toLowerCase();
  const looksAts = ATS_DOMAINS.some((domain) => fromDomain === domain || fromDomain.endsWith(`.${domain}`));

  if (INTERVIEW_MARKERS.some((marker) => haystack.includes(marker))) return "interview";
  if (REJECTION_MARKERS.some((marker) => haystack.includes(marker))) return "application-update";
  if (APPLICATION_MARKERS.some((marker) => haystack.includes(marker))) return "application-update";
  if (looksAts) return "application-update";
  if (haystack.includes("recruiter") || haystack.includes("talent") || haystack.includes("opportunity")) {
    return "recruiting";
  }
  return "not-recruiting";
}

export interface MailProposal {
  readonly messageId: string;
  readonly from: string;
  readonly subject: string;
  readonly classification: MailClassification;
  readonly matchedApplicationId: string | null;
  readonly matchedJobId: string | null;
  /** The stage a human might move the matched application to — a proposal only, never applied here. */
  readonly suggestedStage: ApplicationStatus | null;
  readonly note: string;
}

/**
 * Links recruiting-classified messages to tracked applications/jobs by
 * company name (and title when present). Unmatched recruiting mail becomes a
 * new-lead proposal rather than being dropped — an inbound recruiter for a
 * company she never applied to is exactly the kind of thing worth surfacing.
 */
export function proposeMailLinks(
  messages: readonly MailMessage[],
  applications: readonly ApplicationRecord[],
  jobs: readonly JobRecord[],
): readonly MailProposal[] {
  const proposals: MailProposal[] = [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  for (const message of messages) {
    const classification = classifyRecruitingMail(message);
    if (classification === "not-recruiting") continue;
    const haystack = `${message.from} ${message.subject} ${message.snippet}`;

    let matchedApplication: ApplicationRecord | null = null;
    let matchedJob: JobRecord | null = null;

    // Prefer an application match: company name appears in the message and
    // the job record (if any) lines up too.
    for (const app of applications) {
      const job = jobById.get(app.jobId);
      const company = normalizeCompany(job?.company ?? "");
      if (!company) continue;
      if (companyNameInText(company, haystack)) {
        matchedApplication = app;
        matchedJob = job ?? null;
        break;
      }
    }
    if (!matchedApplication) {
      for (const job of jobs) {
        if (companyNameInText(normalizeCompany(job.company), haystack)) {
          matchedJob = job;
          break;
        }
      }
    }

    const suggestedStage = suggestStage(classification, message, matchedApplication);
    const note = matchedApplication
      ? `Matches tracked application ${matchedApplication.id} (${matchedJob?.title ?? "unknown title"}).`
      : matchedJob
        ? `Matches tracked job ${matchedJob.id} (${matchedJob.title}) with no application yet.`
        : "No tracked application or job matches — possible new lead or cold outreach.";

    proposals.push({
      messageId: message.id,
      from: message.from,
      subject: message.subject,
      classification,
      matchedApplicationId: matchedApplication?.id ?? null,
      matchedJobId: matchedJob?.id ?? null,
      suggestedStage,
      note,
    });
  }
  return proposals;
}

function companyNameInText(normalizedCompany: string, text: string): boolean {
  if (!normalizedCompany) return false;
  return text.toLowerCase().includes(normalizedCompany);
}

/**
 * Suggests (never applies) a stage move. An explicit rejection email
 * proposes `rejected` — this is a real "no" from the employer in her inbox,
 * not LinkedIn silence, and it is still only a proposal until she taps
 * `jobs stage`. Interview language proposes `interview`; a bare
 * application-update proposes nothing.
 */
function suggestStage(
  classification: MailClassification,
  message: MailMessage,
  app: ApplicationRecord | null,
): ApplicationStatus | null {
  if (!app) return null;
  const haystack = `${message.subject}\n${message.snippet}`.toLowerCase();
  if (REJECTION_MARKERS.some((marker) => haystack.includes(marker))) return "rejected";
  if (classification === "interview") return "interview";
  return null;
}

/** Renders the dry-run report. Pure text — the CLI prints it, nothing else happens. */
export function renderMailScanReport(proposals: readonly MailProposal[]): string {
  const lines = [
    "Recruiting mail scan (read-only — proposals only, nothing was changed):",
    "",
  ];
  if (proposals.length === 0) {
    lines.push("No recruiting-classified messages found.");
    return lines.join("\n");
  }
  for (const proposal of proposals) {
    lines.push(`- [${proposal.classification}] ${proposal.subject}`);
    lines.push(`  from: ${proposal.from}`);
    lines.push(`  ${proposal.note}`);
    if (proposal.suggestedStage && proposal.matchedApplicationId) {
      lines.push(
        `  proposal: jobs stage ${proposal.matchedApplicationId} ${proposal.suggestedStage}  (her tap required)`,
      );
    }
  }
  return lines.join("\n");
}
