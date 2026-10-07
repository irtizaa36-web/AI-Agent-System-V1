import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MailMessage } from "./mail-scan";
import { classifyRecruitingMail, proposeMailLinks, renderMailScanReport } from "./mail-scan";
import type { ApplicationRecord, JobRecord } from "./records";

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "msg-1",
    from: "recruiter@example.com",
    subject: "Hello",
    date: null,
    snippet: "",
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing program manager::remote",
    title: "Marketing Program Manager",
    company: "Acme Corp",
    rawLocation: "Remote",
    locationClass: "remote",
    remoteRegion: "us",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    postedAt: null,
    experienceYearsMin: null,
    experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z",
    lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [{ sourceId: "test", url: "https://example.com/job", fetchedAt: "2026-09-28T00:00:00.000Z" }],
    applyUrl: "https://example.com/job",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
    state: "shortlisted",
    filterReason: null,
    score: 80,
    confidence: null,
    rationale: null,
    gaps: [],
    scoreDimensions: null,
    ...overrides,
  };
}

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: "app-1",
    jobId: "job-1",
    status: "applied",
    appliedAt: "2026-09-20T00:00:00.000Z",
    resumeVariantPath: null,
    coverLetterPath: null,
    followUpDueAt: "2026-09-27T00:00:00.000Z",
    outcome: null,
    rejectionReason: null,
    notes: [],
    ...overrides,
  };
}

test("classifyRecruitingMail: ATS senders and application language", () => {
  assert.equal(
    classifyRecruitingMail(message({ from: "jobs@greenhouse.io", subject: "Application received — Acme Corp" })),
    "application-update",
  );
  assert.equal(
    classifyRecruitingMail(message({ subject: "Interview confirmed: Marketing Program Manager" })),
    "interview",
  );
  assert.equal(
    classifyRecruitingMail(
      message({ subject: "Update on your application", snippet: "we will not be moving forward" }),
    ),
    "application-update",
  );
});

test("classifyRecruitingMail: cold outreach vs ordinary mail", () => {
  assert.equal(
    classifyRecruitingMail(
      message({ from: "jane@talentfirm.com", subject: "Exciting opportunity at Beta Inc", snippet: "I'm a recruiter" }),
    ),
    "recruiting",
  );
  assert.equal(classifyRecruitingMail(message({ from: "mom@family.com", subject: "Dinner Sunday" })), "not-recruiting");
});

test("proposeMailLinks matches a message to its tracked application", () => {
  const proposals = proposeMailLinks(
    [message({ from: "jobs@acmecorp.com", subject: "Interview: Marketing Program Manager", snippet: "Acme Corp would like to meet" })],
    [application()],
    [job()],
  );
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.classification, "interview");
  assert.equal(proposals[0]?.matchedApplicationId, "app-1");
  assert.equal(proposals[0]?.suggestedStage, "interview");
});

test("proposeMailLinks proposes rejected for an explicit rejection email — a proposal, not a transition", () => {
  const proposals = proposeMailLinks(
    [message({ from: "jobs@acmecorp.com", subject: "Your application", snippet: "unfortunately Acme Corp will not be moving forward" })],
    [application()],
    [job()],
  );
  assert.equal(proposals[0]?.suggestedStage, "rejected");
});

test("proposeMailLinks surfaces unmatched recruiting mail as a new lead", () => {
  const proposals = proposeMailLinks(
    [message({ from: "jane@talentfirm.com", subject: "Role at NewCo", snippet: "recruiter reaching out" })],
    [application()],
    [job()],
  );
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.matchedApplicationId, null);
  assert.equal(proposals[0]?.suggestedStage, null);
  assert.ok((proposals[0]?.note ?? "").includes("new lead"));
});

test("proposeMailLinks skips non-recruiting mail entirely", () => {
  const proposals = proposeMailLinks(
    [message({ from: "mom@family.com", subject: "Dinner Sunday" })],
    [application()],
    [job()],
  );
  assert.equal(proposals.length, 0);
});

test("renderMailScanReport states plainly that nothing was changed", () => {
  const report = renderMailScanReport([]);
  assert.ok(report.includes("nothing was changed"));
});
