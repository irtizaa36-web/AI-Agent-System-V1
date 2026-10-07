import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLocation,
  classifyRemoteRegion,
  contentHashFor,
  htmlToText,
  identityKeyFor,
  normalizeCompany,
  normalizeTitle,
  parseExperienceYears,
  parseSalary,
  stripBoilerplate,
  titleMatchesTarget,
  toJobRecord,
  truncateToBudget,
} from "./normalize";

test("htmlToText separates paragraphs with a blank line and drops scripts", () => {
  const text = htmlToText("<div><script>evil()</script><p>First</p><p>Second &amp; third</p></div>");
  assert.equal(text, "First\n\nSecond & third");
});

test("paragraph breaks survive htmlToText so stripBoilerplate can drop ONE paragraph, not the posting", () => {
  // These two run in sequence on every real posting. If htmlToText collapsed
  // paragraphs to a single newline, stripBoilerplate would see the whole
  // document as one paragraph and a single EEO sentence would delete the job.
  const html = "<p>Own demand generation for the growth team.</p><p>Acme is an equal opportunity employer.</p><p>You will own the budget.</p>";

  const text = stripBoilerplate(htmlToText(html));

  assert.match(text, /demand generation/);
  assert.match(text, /own the budget/);
  assert.doesNotMatch(text, /equal opportunity/);
});

test("stripBoilerplate removes EEO paragraphs and keeps the real content", () => {
  const text = stripBoilerplate(
    "We need someone to run demand generation.\n\nAcme is an equal opportunity employer and does not discriminate.\n\nYou will own the budget.",
  );
  assert.match(text, /demand generation/);
  assert.match(text, /own the budget/);
  assert.doesNotMatch(text, /equal opportunity/);
});

test("classifyLocation prefers hybrid when a posting says both remote and days in office", () => {
  assert.equal(classifyLocation("Remote", "Remote friendly, 3 days per week in the office"), "hybrid");
});

test("classifyLocation reads remote from the location field", () => {
  assert.equal(classifyLocation("Remote - US", "Any old description"), "remote");
});

test("classifyLocation returns unknown rather than guessing remote when nothing is stated", () => {
  assert.equal(classifyLocation("", "We are hiring a marketing manager."), "unknown");
});

test("a stated city beats product copy in the body — the real Figma false positive", () => {
  // Figma's board describes its own product: "work together in real time from
  // anywhere in the world". That is advertising, not an employment term, and
  // it promoted an onsite Tel Aviv role into a remote-only search until the
  // stated location was given precedence.
  const body =
    "Figma helps teams move faster and work together in real time from anywhere in the world. " +
    "You will own product marketing for Figma Weave.";

  assert.equal(classifyLocation("Tel Aviv, Israel", body), "onsite");
});

test("a stated city still yields hybrid when the posting says days in office", () => {
  assert.equal(classifyLocation("Chicago, IL", "We work hybrid, 3 days per week in the office."), "hybrid");
});

test("a placeholder location falls through to the body instead of counting as a real place", () => {
  assert.equal(classifyLocation("Various", "This role is remote."), "remote");
  assert.equal(classifyLocation("N/A", "Some description with no signal."), "unknown");
});

test("a stated remote location wins even when the body mentions an office", () => {
  assert.equal(classifyLocation("Remote - US", "Visit our San Francisco office sometimes."), "remote");
});

test("classifyRemoteRegion reads an explicit US marker", () => {
  assert.equal(classifyRemoteRegion("Remote - US"), "us");
  assert.equal(classifyRemoteRegion("Remote (US)"), "us");
  assert.equal(classifyRemoteRegion("United States - Remote"), "us");
});

test("classifyRemoteRegion reads a US state as a US marker — the real Databricks case", () => {
  assert.equal(classifyRemoteRegion("Remote - California; Remote - New York"), "us");
  assert.equal(classifyRemoteRegion("Remote - Massachusetts; Remote - New York; Tennessee"), "us");
});

test("classifyRemoteRegion rejects a specific non-US country with no US option — the real Databricks case", () => {
  assert.equal(classifyRemoteRegion("Remote - India"), "non-us");
  assert.equal(classifyRemoteRegion("Remote - United Kingdom"), "non-us");
});

test("classifyRemoteRegion rejects a multi-country EMEA listing with no US seat", () => {
  assert.equal(
    classifyRemoteRegion("EMEA; Germany; London, United Kingdom; Paris, France; Remote - Netherlands"),
    "non-us",
  );
});

test("classifyRemoteRegion treats a listing naming both a US state and a non-US country as US-eligible", () => {
  // The role is open to a US-based candidate even though it also lists other
  // countries — she isn't excluded just because someone in Canada could also apply.
  assert.equal(classifyRemoteRegion("Remote - US; Remote - Canada"), "us");
});

test("classifyRemoteRegion never guesses — a bare Remote with no country is unspecified, not us", () => {
  assert.equal(classifyRemoteRegion("Remote"), "unspecified");
  assert.equal(classifyRemoteRegion(""), "unspecified");
});

test('classifyRemoteRegion does not false-positive on "us" appearing inside an unrelated word', () => {
  // A word-boundary slip here would misclassify almost every posting that
  // happens to mention "focus", "campus", "onboarding", etc.
  assert.equal(classifyRemoteRegion("Remote - Mauritius"), "unspecified");
});

test("parseSalary reads a dollar range", () => {
  assert.deepEqual(parseSalary("The range is $120,000 - $150,000 per year"), {
    min: 120000,
    max: 150000,
    currency: "USD",
  });
});

test("parseSalary reads a k-suffixed range", () => {
  assert.deepEqual(parseSalary("$120k to $150k"), { min: 120000, max: 150000, currency: "USD" });
});

test("parseSalary returns nulls when no salary is stated, never a guess", () => {
  assert.deepEqual(parseSalary("Competitive compensation and great benefits"), {
    min: null,
    max: null,
    currency: null,
  });
});

test("parseSalary ignores an hourly-looking figure rather than treating it as annual", () => {
  assert.deepEqual(parseSalary("$45 per hour"), { min: null, max: null, currency: null });
});

test("parseExperienceYears reads an explicit range", () => {
  assert.deepEqual(parseExperienceYears("3-6 years of experience required"), { min: 3, max: 6 });
  assert.deepEqual(parseExperienceYears("You have 5 to 8 years of relevant experience"), { min: 5, max: 8 });
});

test("parseExperienceYears reads an open floor as a floor with no stated ceiling", () => {
  assert.deepEqual(parseExperienceYears("5+ years of experience"), { min: 5, max: null });
  assert.deepEqual(parseExperienceYears("Minimum of 7 years experience"), { min: 7, max: null });
  assert.deepEqual(parseExperienceYears("At least 4 years"), { min: 4, max: null });
});

test("parseExperienceYears reads a bare figure as a floor, not an exact match", () => {
  assert.deepEqual(parseExperienceYears("5 years of experience in program management"), { min: 5, max: null });
});

test("parseExperienceYears reads the yrs abbreviation", () => {
  assert.deepEqual(parseExperienceYears("2-5 yrs technical content"), { min: 2, max: 5 });
  assert.deepEqual(parseExperienceYears("3+ yrs of experience in growth marketing"), { min: 3, max: null });
});

test("parseExperienceYears reads a bare figure with qualifier words before experience", () => {
  assert.deepEqual(parseExperienceYears("Requires 10 years of marketing experience"), { min: 10, max: null });
});

test("parseExperienceYears unions every stated figure instead of first-match-wins", () => {
  assert.deepEqual(
    parseExperienceYears("1-2 years in a startup environment. 5-7 years of marketing experience required."),
    { min: 1, max: 7 }
  );
});

test("parseExperienceYears returns nulls when nothing is stated, never a guess", () => {
  assert.deepEqual(parseExperienceYears("Own the roadmap and drive cross-functional execution."), {
    min: null,
    max: null,
  });
});

test("normalizeCompany strips legal suffixes and punctuation", () => {
  assert.equal(normalizeCompany("Acme Corp."), normalizeCompany("Acme, Inc"));
});

test("normalizeTitle strips location decoration and requisition ids", () => {
  assert.equal(normalizeTitle("Marketing Manager (Remote, US)"), "marketing manager");
  assert.equal(normalizeTitle("Marketing Manager - Req #4821"), "marketing manager");
});

test("identityKeyFor collapses the same role posted with different decoration", () => {
  const left = identityKeyFor("Acme, Inc", "Marketing Manager (Remote)", "remote");
  const right = identityKeyFor("Acme Corp.", "Marketing Manager", "remote");
  assert.equal(left, right);
});

test("identityKeyFor keeps genuinely different locations apart", () => {
  assert.notEqual(
    identityKeyFor("Acme", "Marketing Manager", "remote"),
    identityKeyFor("Acme", "Marketing Manager", "onsite"),
  );
});

test("contentHashFor is stable across whitespace changes", () => {
  assert.equal(contentHashFor("Acme", "Manager", "a  b\n\nc"), contentHashFor("Acme", "Manager", "a b c"));
});

test("truncateToBudget leaves short text alone and marks what it cuts", () => {
  assert.equal(truncateToBudget("short", 100), "short");
  const long = truncateToBudget("x".repeat(1000), 10);
  assert.ok(long.length < 1000);
  assert.match(long, /\[truncated\]$/);
});

test("titleMatchesTarget matches regardless of word order", () => {
  assert.equal(titleMatchesTarget("Senior GTM Strategy & Operations Manager", "strategy & operations manager"), true);
  assert.equal(titleMatchesTarget("Manager, Enablement Programs", "enablement manager"), true);
});

test("titleMatchesTarget is a superset of substring matching — a literal match still passes", () => {
  assert.equal(titleMatchesTarget("Senior Marketing Program Manager", "program manager"), true);
});

test("titleMatchesTarget requires every word in the pattern, not just one", () => {
  assert.equal(titleMatchesTarget("Operations Coordinator", "strategy & operations manager"), false);
});

test("titleMatchesTarget does not stem — plural and singular are different tokens", () => {
  assert.equal(titleMatchesTarget("Director of Platform Programs", "program manager"), false);
});

test("titleMatchesTarget returns false for an empty pattern rather than matching everything", () => {
  assert.equal(titleMatchesTarget("Anything At All", ""), false);
});

test("toJobRecord produces a seen record with the raw body kept out of the summary path", () => {
  const record = toJobRecord(
    {
      sourceId: "greenhouse:acme",
      url: "https://example.test/jobs/1",
      title: "Marketing Manager (Remote)",
      company: "Acme, Inc",
      location: "Remote - US",
      body: "<p>Own demand gen. Range: $130,000 - $160,000.</p>",
      postedAt: "2026-09-01T00:00:00.000Z",
      fetchedAt: "2026-09-13T08:00:00.000Z",
    },
    { descriptionPath: "/tmp/raw.html", tokenBudget: 600, now: "2026-09-13T08:00:00.000Z" },
  );

  assert.equal(record.state, "seen");
  assert.equal(record.locationClass, "remote");
  assert.equal(record.remoteRegion, "us");
  assert.equal(record.salaryMin, 130000);
  assert.equal(record.salaryMax, 160000);
  assert.equal(record.sources.length, 1);
  assert.doesNotMatch(record.summary, /<p>/);
});
