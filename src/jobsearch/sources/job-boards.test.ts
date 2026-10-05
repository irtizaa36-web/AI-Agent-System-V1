import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MARKETING_QUERY_TERMS,
  marketingQueriesFor,
  postedWithinDays,
  titleMatchesMarketingTerms,
} from "./marketing-queries";
import { parseRemotiveJobs, REMOTIVE_API_URL, REMOTIVE_SOURCE_ID } from "./remotive";
import { parseRemoteOkJobs, REMOTEOK_SOURCE_ID } from "./remoteok";
import { adzunaSearchUrl, ADZUNA_SOURCE_ID, createAdzunaSource, parseAdzunaResults } from "./adzuna";
import { createPublicBoardSources } from "./public-boards";
import { LINKEDIN_GUEST_SOURCE_ID } from "./linkedin-guest";

const DAY_MS = 24 * 60 * 60 * 1000;
// Anchored to the real clock: the parsers filter recency against Date.now(), so a hardcoded date goes stale.
const NOW = Date.now();
const isoDaysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();
const FETCHED_AT = new Date(NOW).toISOString();

describe("titleMatchesMarketingTerms", () => {
  it("matches marketing titles case-insensitively", () => {
    assert.equal(titleMatchesMarketingTerms("Senior Product Marketing Manager"), true);
    assert.equal(titleMatchesMarketingTerms("demand generation lead"), true);
    assert.equal(titleMatchesMarketingTerms("Partner Marketing Specialist"), true);
  });

  it("rejects developer and product-management titles", () => {
    assert.equal(titleMatchesMarketingTerms("Frontend Developer"), false);
    assert.equal(titleMatchesMarketingTerms("Product Manager"), false);
    assert.equal(titleMatchesMarketingTerms("Software Engineer"), false);
  });

  it("honors an explicit term list", () => {
    assert.equal(titleMatchesMarketingTerms("Growth Hacker", ["Growth"]), true);
    assert.equal(titleMatchesMarketingTerms("Growth Hacker", ["Marketing"]), false);
  });
});

describe("marketingQueriesFor", () => {
  it("puts profile titles first and dedupes case-insensitively", () => {
    const queries = marketingQueriesFor(["Marketing Manager", "gtm manager", "  "]);
    assert.equal(queries[0], "Marketing Manager");
    assert.equal(queries[1], "gtm manager");
    // "Marketing Manager" is also a built-in term — it must not repeat.
    assert.equal(
      queries.filter((q) => q.toLowerCase() === "marketing manager").length,
      1,
    );
    assert.ok(queries.includes("Product Marketing"));
  });

  it("falls back to the built-in terms when no profile titles exist", () => {
    assert.deepEqual(marketingQueriesFor(undefined), [...MARKETING_QUERY_TERMS]);
  });
});

describe("postedWithinDays", () => {
  it("keeps recent, boundary, future, missing, and unparseable dates", () => {
    assert.equal(postedWithinDays(isoDaysAgo(1), 3, NOW), true);
    assert.equal(postedWithinDays(isoDaysAgo(3), 3, NOW), true);
    assert.equal(postedWithinDays(new Date(NOW + DAY_MS).toISOString(), 3, NOW), true);
    assert.equal(postedWithinDays(null, 3, NOW), true);
    assert.equal(postedWithinDays(undefined, 3, NOW), true);
    assert.equal(postedWithinDays("not a date", 3, NOW), true);
  });

  it("drops dates older than the window", () => {
    assert.equal(postedWithinDays(isoDaysAgo(4), 3, NOW), false);
    assert.equal(postedWithinDays(new Date(NOW - 3 * DAY_MS - 1).toISOString(), 3, NOW), false);
  });
});

describe("parseRemotiveJobs", () => {
  const queries = ["Product Marketing"];

  it("keeps recent marketing roles with a qualified Remote location", () => {
    const postings = parseRemotiveJobs(
      {
        jobs: [
          {
            title: "Senior Product Marketing Manager",
            company_name: "Acme",
            candidate_required_location: "USA Only",
            publication_date: isoDaysAgo(1),
            url: "https://remotive.com/remote-jobs/1",
            description: "<p>Great role</p>",
          },
        ],
      },
      queries,
      REMOTIVE_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 1);
    const posting = postings[0];
    assert.equal(posting.title, "Senior Product Marketing Manager");
    assert.equal(posting.location, "Remote (USA Only)");
    assert.equal(posting.company, "Acme");
    assert.equal(posting.sourceId, REMOTIVE_SOURCE_ID);
    assert.equal(posting.url, "https://remotive.com/remote-jobs/1");
  });

  it("drops non-marketing titles, stale posts, and title-less rows", () => {
    const postings = parseRemotiveJobs(
      {
        jobs: [
          { title: "Backend Engineer", publication_date: isoDaysAgo(1), url: "https://x/1" },
          { title: "Product Marketing Manager", publication_date: isoDaysAgo(5), url: "https://x/2" },
          { title: "  ", publication_date: isoDaysAgo(1), url: "https://x/3" },
        ],
      },
      queries,
      REMOTIVE_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 0);
  });

  it("emits bare Remote when no candidate requirement is stated", () => {
    const postings = parseRemotiveJobs(
      { jobs: [{ title: "Product Marketing Manager", publication_date: isoDaysAgo(1), url: "https://x/1" }] },
      queries,
      REMOTIVE_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings[0].location, "Remote");
  });

  it("tolerates malformed and empty responses", () => {
    assert.deepEqual(parseRemotiveJobs({}, queries, REMOTIVE_SOURCE_ID, FETCHED_AT), []);
    assert.deepEqual(parseRemotiveJobs({ jobs: [] }, queries, REMOTIVE_SOURCE_ID, FETCHED_AT), []);
  });

  it("uses the documented API URL", () => {
    assert.equal(REMOTIVE_API_URL, "https://remotive.com/api/remote-jobs?limit=200");
  });
});

describe("parseRemoteOkJobs", () => {
  const queries = ["Product Marketing"];

  it("skips the legal-notice row and keeps recent marketing roles", () => {
    const postings = parseRemoteOkJobs(
      [
        { legal: "API Terms of Service: link back to Remote OK" },
        {
          position: "Product Marketing Manager",
          company: "Acme",
          location: "Germany",
          date: isoDaysAgo(1),
          url: "https://remoteok.com/remote-jobs/1",
          description: "<p>Hi</p>",
        },
      ],
      queries,
      REMOTEOK_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 1);
    assert.equal(postings[0].location, "Remote (Germany)");
    assert.equal(postings[0].company, "Acme");
  });

  it("falls back to epoch when date is missing and drops stale posts", () => {
    const postings = parseRemoteOkJobs(
      [
        {
          position: "Product Marketing Manager",
          epoch: Math.floor((NOW - DAY_MS) / 1000),
          url: "https://remoteok.com/remote-jobs/2",
        },
        {
          position: "Product Marketing Manager",
          epoch: Math.floor((NOW - 5 * DAY_MS) / 1000),
          url: "https://remoteok.com/remote-jobs/3",
        },
      ],
      queries,
      REMOTEOK_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 1);
    assert.equal(postings[0].url, "https://remoteok.com/remote-jobs/2");
  });

  it("tolerates a non-array response", () => {
    assert.deepEqual(parseRemoteOkJobs({}, queries, REMOTEOK_SOURCE_ID, FETCHED_AT), []);
  });
});

describe("adzunaSearchUrl", () => {
  it("builds the documented search URL with credentials as params", () => {
    const url = adzunaSearchUrl("Demand Generation", "my-id", "my-key");
    assert.ok(url.startsWith("https://api.adzuna.com/v1/api/jobs/us/search/1?"));
    const params = new URL(url).searchParams;
    assert.equal(params.get("app_id"), "my-id");
    assert.equal(params.get("app_key"), "my-key");
    assert.equal(params.get("what"), "Demand Generation");
    assert.equal(params.get("results_per_page"), "30");
    assert.equal(params.get("max_days_old"), "3");
  });
});

describe("parseAdzunaResults", () => {
  it("maps result fields onto the posting schema", () => {
    const postings = parseAdzunaResults(
      {
        results: [
          {
            title: "Demand Generation Manager",
            company: { display_name: "Acme" },
            location: { display_name: "New York, New York" },
            description: "Own the pipeline.",
            redirect_url: "https://adzuna.com/land/1",
            created: isoDaysAgo(1),
          },
        ],
      },
      ADZUNA_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 1);
    const posting = postings[0];
    assert.equal(posting.title, "Demand Generation Manager");
    assert.equal(posting.company, "Acme");
    assert.equal(posting.location, "New York, New York");
    assert.equal(posting.url, "https://adzuna.com/land/1");
    assert.equal(posting.sourceId, ADZUNA_SOURCE_ID);
  });

  it("drops rows without a URL or title, stale rows, and malformed bodies", () => {
    const postings = parseAdzunaResults(
      {
        results: [
          { title: "Demand Generation Manager", created: isoDaysAgo(1) },
          { title: "Demand Generation Manager", redirect_url: "https://x/2", created: isoDaysAgo(9) },
          { redirect_url: "https://x/3", created: isoDaysAgo(1) },
        ],
      },
      ADZUNA_SOURCE_ID,
      FETCHED_AT,
    );
    assert.equal(postings.length, 0);
    assert.deepEqual(parseAdzunaResults({}, ADZUNA_SOURCE_ID, FETCHED_AT), []);
    assert.deepEqual(parseAdzunaResults({ results: [] }, ADZUNA_SOURCE_ID, FETCHED_AT), []);
  });
});

describe("createAdzunaSource", () => {
  const savedId = process.env["ADZUNA_APP_ID"];
  const savedKey = process.env["ADZUNA_APP_KEY"];

  it("returns undefined when credentials are missing", () => {
    delete process.env["ADZUNA_APP_ID"];
    delete process.env["ADZUNA_APP_KEY"];
    assert.equal(createAdzunaSource(), undefined);
  });

  it("returns a source with the stable id when credentials are set", () => {
    process.env["ADZUNA_APP_ID"] = "test-id";
    process.env["ADZUNA_APP_KEY"] = "test-key";
    const source = createAdzunaSource();
    assert.ok(source);
    assert.equal(source.id, ADZUNA_SOURCE_ID);
    assert.equal(source.company, null);
  });

  it("restores the environment", () => {
    if (savedId === undefined) delete process.env["ADZUNA_APP_ID"];
    else process.env["ADZUNA_APP_ID"] = savedId;
    if (savedKey === undefined) delete process.env["ADZUNA_APP_KEY"];
    else process.env["ADZUNA_APP_KEY"] = savedKey;
  });
});

describe("createPublicBoardSources", () => {
  it("attaches boards for shivani only", () => {
    delete process.env["ADZUNA_APP_ID"];
    delete process.env["ADZUNA_APP_KEY"];
    const shivani = createPublicBoardSources("shivani", []);
    assert.deepEqual(
      shivani.sources.map((s) => s.id),
      [REMOTIVE_SOURCE_ID, REMOTEOK_SOURCE_ID, LINKEDIN_GUEST_SOURCE_ID],
    );
    assert.equal(shivani.adzunaSkipped, true);

    const other = createPublicBoardSources("irtiza", []);
    assert.deepEqual(other.sources, []);
    assert.equal(other.adzunaSkipped, false);
  });

  it("includes adzuna when credentials are present", () => {
    process.env["ADZUNA_APP_ID"] = "test-id";
    process.env["ADZUNA_APP_KEY"] = "test-key";
    const boards = createPublicBoardSources("shivani", []);
    assert.ok(boards.sources.some((s) => s.id === ADZUNA_SOURCE_ID));
    assert.equal(boards.adzunaSkipped, false);
    delete process.env["ADZUNA_APP_ID"];
    delete process.env["ADZUNA_APP_KEY"];
  });
});
