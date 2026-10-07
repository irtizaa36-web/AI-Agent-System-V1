import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLinkedInPullSource,
  linkedInPullPath,
  LINKEDIN_PULL_SOURCE_ID,
  parseLinkedInPull,
  readAppliedHistory,
  readLinkedInPull,
} from "./linkedin-pull";

const fetchedAt = "2026-09-28T15:00:00.000Z";

function pullFile(items: readonly unknown[]): string {
  return JSON.stringify({ pulledAt: fetchedAt, items });
}

test("a missing pull file yields nothing and raises no error", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-"));
  const postings = await readLinkedInPull("shivani", "2026-09-28", root);
  assert.deepEqual(postings, []);
});

test("malformed JSON is tolerated — the source yields nothing rather than failing the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-"));
  const { mkdir } = await import("node:fs/promises");
  const dir = join(root, "profile", "shivani", "linkedin-pull");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-09-28.json"), "not json {{{", "utf8");
  const postings = await readLinkedInPull("shivani", "2026-09-28", root);
  assert.deepEqual(postings, []);
});

test("a file with no items array yields nothing", async () => {
  assert.deepEqual(parseLinkedInPull({ pulledAt: fetchedAt }, fetchedAt), []);
  assert.deepEqual(parseLinkedInPull(null, fetchedAt), []);
  assert.deepEqual(parseLinkedInPull("nope", fetchedAt), []);
});

test("valid items map to postings with the linkedin-pull source id", () => {
  const postings = parseLinkedInPull(
    {
      pulledAt: fetchedAt,
      items: [
        {
          id: "123",
          title: "Marketing Manager",
          company: "Acme Corp",
          url: "https://www.linkedin.com/jobs/view/123/",
          location: "Remote",
          postedAt: "2026-09-27T00:00:00.000Z",
          summary: "Own demand generation.",
          salaryMin: 90000,
          salaryMax: 120000,
          salaryCurrency: "USD",
        },
      ],
    },
    fetchedAt,
  );
  assert.equal(postings.length, 1);
  const posting = postings[0]!;
  assert.equal(posting.sourceId, LINKEDIN_PULL_SOURCE_ID);
  assert.equal(posting.title, "Marketing Manager");
  assert.equal(posting.company, "Acme Corp");
  assert.equal(posting.url, "https://www.linkedin.com/jobs/view/123/");
  assert.equal(posting.location, "Remote");
  assert.equal(posting.postedAt, "2026-09-27T00:00:00.000Z");
  assert.match(posting.body, /Own demand generation/);
  // The stated salary travels verbatim so the pipeline's salary parsing can read it.
  assert.match(posting.body, /Stated salary range: 90,000–120,000 USD/);
});

test("nullable fields stay null — never guessed, never zero", () => {
  const postings = parseLinkedInPull(
    {
      pulledAt: fetchedAt,
      items: [
        { id: "1", title: "Growth Lead", company: "Beta", url: "https://www.linkedin.com/jobs/view/1/" },
      ],
    },
    fetchedAt,
  );
  assert.equal(postings.length, 1);
  assert.equal(postings[0]!.postedAt, null);
  assert.equal(postings[0]!.location, "");
  assert.doesNotMatch(postings[0]!.body, /Stated salary range/);
});

test("items missing title, company, or url are skipped individually", () => {
  const postings = parseLinkedInPull(
    {
      pulledAt: fetchedAt,
      items: [
        { id: "bad-1", company: "Acme", url: "https://x.test/1" },
        { id: "bad-2", title: "  ", company: "Acme", url: "https://x.test/2" },
        { id: "ok", title: "Marketing Manager", company: "Acme", url: "https://x.test/3" },
      ],
    },
    fetchedAt,
  );
  assert.equal(postings.length, 1);
  assert.equal(postings[0]!.title, "Marketing Manager");
});

test("the source factory reads the dated pull file for the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-"));
  const { mkdir } = await import("node:fs/promises");
  const dir = join(root, "profile", "shivani", "linkedin-pull");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "2026-09-28.json"),
    pullFile([{ id: "7", title: "Ops Manager", company: "Gamma", url: "https://www.linkedin.com/jobs/view/7/" }]),
    "utf8",
  );

  const source = createLinkedInPullSource("shivani", root, "2026-09-28");
  assert.equal(source.id, LINKEDIN_PULL_SOURCE_ID);
  const postings = await source.fetch();
  assert.equal(postings.length, 1);
  assert.equal(postings[0]!.title, "Ops Manager");
});

test("the adapter module cannot make network requests — no HTTP imports or fetch calls", async () => {
  // ADR 0013 stands for the engine: pipeline code must never touch
  // linkedin.com. This test reads the module source and asserts it has no
  // request-capable surface at all. The Source interface's own fetch()
  // method (declared but never calling the network) is the one exception.
  const modulePath = join(__dirname, "..", "..", "..", "src", "jobsearch", "sources", "linkedin-pull.ts");
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from\s+["']node:https?["']/, "no node:http(s) import");
  assert.doesNotMatch(source, /require\s*\(\s*["']node:https?["']\s*\)/, "no node:http(s) require");
  assert.doesNotMatch(source, /from\s+["']undici["']/, "no undici import");
  assert.doesNotMatch(source, /globalThis\.fetch/, "no globalThis.fetch");
  const fetchCalls = source.match(/(?<![\w.])fetch\s*\([^)]*\)/g) ?? [];
  for (const call of fetchCalls) {
    assert.equal(call, "fetch()", `no network-capable fetch call: ${call}`);
  }
});

test("readAppliedHistory returns [] when the file is missing, malformed, or has no history", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-"));
  assert.deepEqual(await readAppliedHistory("shivani", "2026-09-28", root), [], "missing file");

  const dir = join(root, "profile", "shivani", "linkedin-pull");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-09-28.json"), pullFile([]), "utf8");
  assert.deepEqual(await readAppliedHistory("shivani", "2026-09-28", root), [], "no appliedHistory key");

  await writeFile(join(dir, "2026-09-28.json"), "{not json", "utf8");
  assert.deepEqual(await readAppliedHistory("shivani", "2026-09-28", root), [], "malformed JSON");
});

test("readAppliedHistory parses the applied-jobs history from the pull file", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-"));
  const dir = join(root, "profile", "shivani", "linkedin-pull");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const file = {
    pulledAt: fetchedAt,
    items: [],
    appliedHistory: [
      { title: "Senior Marketing Program Manager", company: "Acme Corp", location: "Remote", dateApplied: "2026-09-20", status: "applied" },
      { title: "", company: "Sloppy Co" },
    ],
  };
  await writeFile(join(dir, "2026-09-28.json"), JSON.stringify(file), "utf8");
  const history = await readAppliedHistory("shivani", "2026-09-28", root);
  assert.equal(history.length, 1, "sloppy entries skipped individually");
  assert.equal(history[0]?.title, "Senior Marketing Program Manager");
  assert.equal(history[0]?.company, "Acme Corp");
});

test("applied history never affects posting ingestion — items flow unchanged", () => {
  const postings = parseLinkedInPull(
    {
      pulledAt: fetchedAt,
      items: [{ id: "1", title: "PM", company: "Acme", url: "https://www.linkedin.com/jobs/view/1", location: "Remote", postedAt: null, summary: "x", salaryMin: null, salaryMax: null, salaryCurrency: null }],
      appliedHistory: [{ title: "PM", company: "Acme", location: "Remote", dateApplied: "2026-09-20", status: "applied" }],
    },
    fetchedAt,
  );
  assert.equal(postings.length, 1);
});
