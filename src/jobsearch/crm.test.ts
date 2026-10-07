import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationRecord, ApplicationStatus, JobRecord } from "./records";
import {
  addMutedCompany,
  applicationKey,
  canTransition,
  dueFollowUps,
  FOLLOW_UP_AFTER_DAYS,
  IllegalApplicationTransitionError,
  isMuted,
  loadMutedCompanies,
  rejectPostingForJob,
  removeMutedCompany,
  syncLinkedInApplications,
  transitionApplication,
} from "./crm";
import { parseSavedJobs } from "./sources/linkedin-pull";

function app(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: "app-1",
    jobId: "job-1",
    status: "queued",
    appliedAt: null,
    resumeVariantPath: null,
    coverLetterPath: null,
    followUpDueAt: null,
    outcome: null,
    rejectionReason: null,
    notes: [],
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

const NOW = new Date("2026-09-28T12:00:00.000Z");

test("the full post-application funnel walks applied -> screening -> interview -> offer", () => {
  let record = app({ status: "applied" });
  for (const stage of ["screening", "interview", "offer"] as const) {
    assert.ok(canTransition(record.status, stage), `${record.status} -> ${stage}`);
    record = transitionApplication(record, stage, NOW);
  }
  assert.equal(record.status, "offer");
});

test("rejected and withdrawn are terminal", () => {
  for (const terminal of ["rejected", "withdrawn"] as const) {
    for (const next of ["applied", "screening", "interview", "offer", "queued"] as const) {
      assert.equal(canTransition(terminal, next as ApplicationStatus), false, `${terminal} -> ${next}`);
    }
  }
});

test("tailoring states are preserved: pending-approval -> materials_ready -> applied", () => {
  assert.ok(canTransition("pending-approval", "materials_ready"));
  assert.ok(canTransition("materials_ready", "applied"));
  assert.equal(canTransition("pending-approval", "applied"), false, "the approval gate cannot be skipped");
});

test("rejection is reachable from every post-application stage, never from a terminal one", () => {
  for (const stage of ["applied", "screening", "interview", "submitted_by_human", "responded"] as const) {
    assert.ok(canTransition(stage, "rejected"), `${stage} -> rejected`);
  }
  // Nothing to reject before she applies: a queued or saved lead can be
  // withdrawn (decided against), not rejected (turned down).
  assert.equal(canTransition("queued", "rejected"), false);
  assert.equal(canTransition("saved", "rejected"), false);
  assert.ok(canTransition("queued", "withdrawn"));
});

test("transitionApplication throws on an illegal move and leaves the record untouched", () => {
  const record = app({ status: "applied" });
  assert.throws(
    () => transitionApplication(record, "offer", NOW),
    IllegalApplicationTransitionError,
    "applied cannot jump to offer",
  );
});

test("transitionApplication stamps appliedAt and refreshes followUpDueAt on applied", () => {
  const record = transitionApplication(app({ status: "materials_ready" }), "applied", NOW);
  assert.equal(record.status, "applied");
  assert.equal(record.appliedAt, NOW.toISOString());
  assert.ok(record.followUpDueAt !== null, "a nudge is scheduled");
  const due = new Date(record.followUpDueAt as string);
  const expected = new Date(NOW);
  expected.setDate(expected.getDate() + FOLLOW_UP_AFTER_DAYS);
  assert.equal(due.toISOString(), expected.toISOString());
});

test("transitionApplication refreshes the nudge after each active step", () => {
  const applied = transitionApplication(app({ status: "materials_ready" }), "applied", NOW);
  const later = new Date("2026-10-10T12:00:00.000Z");
  const screening = transitionApplication(applied, "screening", later);
  assert.ok(
    (screening.followUpDueAt as string) > (applied.followUpDueAt as string),
    "screening moves the nudge forward",
  );
});

test("transitionApplication to the same status is a no-op", () => {
  const record = app({ status: "applied", appliedAt: "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(transitionApplication(record, "applied", NOW), record);
});

test("dueFollowUps returns only active applications past their nudge date", () => {
  const apps = [
    app({ id: "a", status: "applied", followUpDueAt: "2026-09-20T00:00:00.000Z" }),
    app({ id: "b", status: "applied", followUpDueAt: "2026-10-20T00:00:00.000Z" }),
    app({ id: "c", status: "interview", followUpDueAt: "2026-09-01T00:00:00.000Z" }),
    app({ id: "d", status: "rejected", followUpDueAt: "2026-09-01T00:00:00.000Z" }),
    app({ id: "e", status: "applied", followUpDueAt: null }),
  ];
  assert.deepEqual(dueFollowUps(apps, NOW).map((record) => record.id), ["a", "c"]);
});

test("rejectPostingForJob rejects the posting without muting the company", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-mute-"));
  try {
    const rejected = rejectPostingForJob(job());
    assert.equal(rejected.state, "rejected");
    assert.ok((rejected.filterReason ?? "").includes("Candidate rejected"));
    // The mute list is untouched — rejecting a posting is not a company mute.
    assert.deepEqual(await loadMutedCompanies("shivani", root), []);
    assert.equal(isMuted("Acme Corp", await loadMutedCompanies("shivani", root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mute-company storage adds, dedupes, and removes case-insensitively", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-mute-"));
  try {
    const first = await addMutedCompany("shivani", root, "Acme Corp");
    assert.equal(first.added, true);
    const dup = await addMutedCompany("shivani", root, "acme corp.");
    assert.equal(dup.added, false, "same company, different punctuation — not added twice");
    assert.deepEqual(await loadMutedCompanies("shivani", root), ["Acme Corp"]);
    assert.ok(isMuted("ACME CORP", ["Acme Corp"]));
    assert.ok(!isMuted("Beta Inc", ["Acme Corp"]));
    const removed = await removeMutedCompany("shivani", root, "Acme Corp");
    assert.equal(removed.removed, true);
    assert.deepEqual(await loadMutedCompanies("shivani", root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseSavedJobs validates entries and degrades to [] on bad input", () => {
  assert.deepEqual(parseSavedJobs(undefined), []);
  assert.deepEqual(parseSavedJobs(null), []);
  assert.deepEqual(parseSavedJobs({}), []);
  const parsed = parseSavedJobs([
    { title: "Field Marketing Manager", company: "Baseten", location: "NYC hybrid", url: "https://example.com/1" },
    { title: "", company: "NoTitle" },
    { company: "NoTitleEither" },
    "junk",
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, "Field Marketing Manager");
  assert.equal(parsed[0]?.url, "https://example.com/1");
});

test("applicationKey normalizes company+title for dedupe", () => {
  assert.equal(applicationKey("Eon.io", "Field Marketing Manager"), applicationKey("eon io", "field  marketing manager"));
});

test("LinkedIn sync: 'In Progress' and applied both become CRM applied", () => {
  const result = syncLinkedInApplications({
    existing: [],
    history: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "In Progress" },
      { title: "Senior Marketing Events Manager", company: "GoFundMe", location: "Remote", dateApplied: null, status: "Applied" },
    ],
    savedJobs: [],
    jobs: [],
    now: NOW,
  });
  assert.equal(result.created.length, 2);
  assert.ok(result.created.every((record) => record.status === "applied"));
  assert.ok(result.created.every((record) => record.source === "linkedin"));
  assert.ok(result.created.every((record) => record.followUpDueAt !== null), "nudges scheduled");
});

test("LinkedIn sync never infers rejection: 'no longer accepting' still becomes applied", () => {
  const result = syncLinkedInApplications({
    existing: [],
    history: [
      { title: "Performance Marketing Specialist", company: "Bloom Nutrition", location: "Austin", dateApplied: null, status: "No longer accepting applications" },
    ],
    savedJobs: [],
    jobs: [],
    now: NOW,
  });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]?.status, "applied");
  assert.ok((result.created[0]?.notes.join(" ") ?? "").includes("never infer rejection"));
});

test("LinkedIn sync dedupes against pipeline-tracked applications by company+title", () => {
  const pipelineJob = job({ id: "job-acme", title: "Marketing Program Manager", company: "Acme Corp" });
  const existing = [app({ id: "app-acme", jobId: "job-acme", status: "applied" })];
  const result = syncLinkedInApplications({
    existing,
    history: [
      { title: "marketing program manager", company: "ACME Corp.", location: "Remote", dateApplied: null, status: "Applied" },
    ],
    savedJobs: [],
    jobs: [pipelineJob],
    now: NOW,
  });
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "already tracked as an application");
});

test("LinkedIn sync is idempotent across re-runs", () => {
  const first = syncLinkedInApplications({
    existing: [],
    history: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "Applied" },
    ],
    savedJobs: [{ title: "Field Marketing Manager", company: "Baseten", location: "NYC", url: null, savedAt: null }],
    jobs: [],
    now: NOW,
  });
  assert.equal(first.created.length, 2);
  const second = syncLinkedInApplications({
    existing: first.created,
    history: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "Applied" },
    ],
    savedJobs: [{ title: "Field Marketing Manager", company: "Baseten", location: "NYC", url: null, savedAt: null }],
    jobs: [],
    now: NOW,
  });
  assert.equal(second.created.length, 0, "re-running creates nothing new");
  assert.equal(second.skipped.length, 2);
});

test("LinkedIn sync links to a tracked job record when company+title match", () => {
  const tracked = job({ id: "job-tracked", title: "Field Marketing Manager", company: "Eon.io" });
  const result = syncLinkedInApplications({
    existing: [],
    history: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "Applied" },
    ],
    savedJobs: [],
    jobs: [tracked],
    now: NOW,
  });
  assert.equal(result.created[0]?.jobId, "job-tracked");
});

test("LinkedIn sync turns saved jobs into saved-status leads, not applications", () => {
  const result = syncLinkedInApplications({
    existing: [],
    history: [],
    savedJobs: [{ title: "Field Marketing Manager", company: "Baseten", location: "NYC hybrid", url: "https://example.com/1", savedAt: null }],
    jobs: [],
    now: NOW,
  });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]?.status, "saved");
  assert.equal(result.created[0]?.appliedAt, null, "a saved lead has no applied date");
});
