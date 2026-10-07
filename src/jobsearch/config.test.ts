import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertValidProfile,
  configDirFor,
  dataDirFor,
  listProfiles,
  loadPreferences,
  loadProfile,
  loadWatchlist,
  MissingProfileError,
  profileDirFor,
  savePreferences,
  UnknownProfileError,
} from "./config";

test("each profile gets its own config, data and profile directory — no shared path", () => {
  assert.equal(configDirFor("shivani"), join("config/job-search", "shivani"));
  assert.equal(configDirFor("irtiza"), join("config/job-search", "irtiza"));
  assert.notEqual(dataDirFor("shivani"), dataDirFor("irtiza"));
  assert.notEqual(profileDirFor("shivani"), profileDirFor("irtiza"));
});

test("a profile name that could escape its namespace is rejected outright", () => {
  for (const bad of ["../etc", "a/b", "", "Shivani", "with space", "./x"]) {
    assert.throws(() => assertValidProfile(bad), UnknownProfileError, `expected "${bad}" to be rejected`);
  }
});

test("ordinary profile names are accepted", () => {
  for (const good of ["shivani", "irtiza", "person-2", "a1"]) {
    assert.doesNotThrow(() => assertValidProfile(good));
  }
});

test("listProfiles finds every configured profile and ignores stray files", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/shivani"), { recursive: true });
    await mkdir(join(root, "config/job-search/irtiza"), { recursive: true });
    await writeFile(join(root, "config/job-search/README.md"), "not a profile", "utf8");

    assert.deepEqual(await listProfiles(root), ["irtiza", "shivani"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listProfiles returns nothing rather than throwing when no config root exists yet", async () => {
  assert.deepEqual(await listProfiles(join(tmpdir(), "definitely-not-a-repo-root")), []);
});

test("one profile's preferences never leak into another's", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/shivani"), { recursive: true });
    await mkdir(join(root, "config/job-search/irtiza"), { recursive: true });
    await writeFile(
      join(root, "config/job-search/shivani/preferences.json"),
      JSON.stringify({ salaryFloor: 120000, titles: ["marketing manager"] }),
      "utf8",
    );
    await writeFile(
      join(root, "config/job-search/irtiza/preferences.json"),
      JSON.stringify({ salaryFloor: null, titles: ["clinical expert"] }),
      "utf8",
    );

    const shivani = await loadPreferences("shivani", root);
    const irtiza = await loadPreferences("irtiza", root);

    assert.equal(shivani.salaryFloor, 120000);
    assert.deepEqual(shivani.titles, ["marketing manager"]);
    assert.equal(irtiza.salaryFloor, null);
    assert.deepEqual(irtiza.titles, ["clinical expert"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePreferences merges a patch over the existing file, preserving keys it didn't touch — including '_comment'-style documentation that isn't part of the Preferences type", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/shivani"), { recursive: true });
    const path = join(root, "config/job-search/shivani/preferences.json");
    await writeFile(
      path,
      JSON.stringify({ salaryFloor: 120000, _salaryFloor: "Set per Irtiza's Sep 13 call.", titles: ["marketing manager"] }, null, 2),
      "utf8",
    );

    await savePreferences("shivani", { salaryFloor: 130000 }, root);

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.salaryFloor, 130000, "the patched field changed");
    assert.equal(onDisk._salaryFloor, "Set per Irtiza's Sep 13 call.", "the comment field survived, untouched");
    assert.deepEqual(onDisk.titles, ["marketing manager"], "an untouched field survived, untouched");

    const reloaded = await loadPreferences("shivani", root);
    assert.equal(reloaded.salaryFloor, 130000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePreferences creates the file when none exists yet, rather than requiring one to pre-exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/shivani"), { recursive: true });
    await savePreferences("shivani", { scoreCutoff: 70 }, root);
    const reloaded = await loadPreferences("shivani", root);
    assert.equal(reloaded.scoreCutoff, 70);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePreferences never touches another profile's file", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/shivani"), { recursive: true });
    await mkdir(join(root, "config/job-search/irtiza"), { recursive: true });
    await writeFile(join(root, "config/job-search/irtiza/preferences.json"), JSON.stringify({ salaryFloor: null }), "utf8");

    await savePreferences("shivani", { salaryFloor: 130000 }, root);

    const irtiza = await loadPreferences("irtiza", root);
    assert.equal(irtiza.salaryFloor, null, "unaffected by a write to shivani's file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing profile config falls back to defaults rather than failing the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "config/job-search/nobody"), { recursive: true });
    const prefs = await loadPreferences("nobody", root);
    assert.equal(prefs.scoreCutoff, 65, "defaults still apply");
    assert.deepEqual(await loadWatchlist("nobody", root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProfile reads one person's resume and never another's", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await mkdir(join(root, "profile/shivani"), { recursive: true });
    await mkdir(join(root, "profile/irtiza"), { recursive: true });
    await writeFile(join(root, "profile/shivani/resume.md"), "Marketing Program Manager at AWS", "utf8");
    await writeFile(join(root, "profile/irtiza/resume.md"), "Physician", "utf8");

    assert.match((await loadProfile("shivani", root)).resume, /Marketing Program Manager/);
    assert.match((await loadProfile("irtiza", root)).resume, /Physician/);
    assert.doesNotMatch((await loadProfile("irtiza", root)).resume, /Marketing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing resume names the exact per-profile path it looked for", async () => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  try {
    await assert.rejects(() => loadProfile("irtiza", root), (error: unknown) => {
      assert.ok(error instanceof MissingProfileError);
      assert.match(error.message, /profile\/irtiza\/resume\.md/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePreferences writes valid keys and names the rejected ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "prefs-gate-"));
  try {
    const profileDir = join(root, configDirFor("shivani"));
    await mkdir(profileDir, { recursive: true });
    const { rejectedKeys } = await savePreferences(
      "shivani",
      { salaryFloor: 150000, remoteOnly: "definitely" as unknown as boolean },
      root,
    );
    assert.deepEqual(rejectedKeys, ["remoteOnly"], "the type-invalid key is named, not written");
    const prefs = await loadPreferences("shivani", root);
    assert.equal(prefs.salaryFloor, 150000);
    assert.equal(prefs.remoteOnly, true, "the invalid value never touched the file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("savePreferences rejects a type-invalid known field, but lets documentary comments through", async () => {
  const root = await mkdtemp(join(tmpdir(), "prefs-gate-"));
  try {
    await mkdir(join(root, configDirFor("shivani")), { recursive: true });
    const { rejectedKeys } = await savePreferences(
      "shivani",
      { salaryFloor: "lots" as unknown as number, _titles: "commentary, not a field" },
      root,
    );
    assert.deepEqual(rejectedKeys, ["salaryFloor"], "type-invalid values reject per-key");
    const raw = JSON.parse(await readFile(join(root, configDirFor("shivani"), "preferences.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw["_titles"], "commentary, not a field", "documentary comments are never rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
