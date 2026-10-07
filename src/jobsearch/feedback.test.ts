import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedbackPatch,
  buildConversationHistory,
  buildFeedbackPrompt,
  buildFeedbackReplyBody,
  buildRunContext,
  classifyFeedback,
  looksLikeDirectMessage,
  looksLikeDirectText,
  parseFeedbackClassification,
  type ConversationTurn,
  validatePreferenceValue,
} from "./feedback";
import { DEFAULT_PREFERENCES, type Preferences } from "./records";
import { FakeScoringClient } from "./scoring-client";
import type { DigestPayload } from "./digest";

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["program manager"], scoreCutoff: 65, salaryFloor: 120000 };

test("looksLikeDirectMessage requires her as the sender AND the mailbox as a direct recipient", () => {
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";

  assert.equal(
    looksLikeDirectMessage({ from: { address: candidate }, to: [{ address: mailbox }] }, candidate, mailbox),
    true,
  );
});

test("looksLikeDirectMessage rejects a message from someone else, even if addressed to the mailbox", () => {
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";
  assert.equal(
    looksLikeDirectMessage({ from: { address: "hello@emails.reebok.com" }, to: [{ address: mailbox }] }, candidate, mailbox),
    false,
  );
});

test("looksLikeDirectMessage rejects her own forwarded mail that never actually reached the mailbox directly", () => {
  // The exact shape of a real forwarded LinkedIn alert: she's the recipient
  // named in the forwarded headers, not the one who wrote to us just now.
  const candidate = "brshivani@gmail.com";
  const mailbox = "toozy@inkboxmail.com";
  assert.equal(
    looksLikeDirectMessage({ from: { address: "jobalerts-noreply@linkedin.com" }, to: [{ address: candidate }] }, candidate, mailbox),
    false,
  );
});

test("looksLikeDirectMessage is case-insensitive", () => {
  assert.equal(
    looksLikeDirectMessage(
      { from: { address: "BrShivani@Gmail.com" }, to: [{ address: "Toozy@InkboxMail.com" }] },
      "brshivani@gmail.com",
      "toozy@inkboxmail.com",
    ),
    true,
  );
});

test("looksLikeDirectText requires inbound direction from her own configured number", () => {
  assert.equal(
    looksLikeDirectText({ direction: "inbound", remoteNumber: "+12144023994" }, "+12144023994"),
    true,
  );
});

test("looksLikeDirectText rejects an outbound message even from her own number — that's our own reply, not her feedback", () => {
  assert.equal(
    looksLikeDirectText({ direction: "outbound", remoteNumber: "+12144023994" }, "+12144023994"),
    false,
  );
});

test("looksLikeDirectText rejects a message from a different number", () => {
  assert.equal(
    looksLikeDirectText({ direction: "inbound", remoteNumber: "+15559876543" }, "+12144023994"),
    false,
  );
});

test("looksLikeDirectText rejects a group thread's inbound message with no direct remoteNumber", () => {
  assert.equal(looksLikeDirectText({ direction: "inbound", remoteNumber: null }, "+12144023994"), false);
});

test("looksLikeDirectText tolerates formatting differences (+1, parens/dashes, bare 10 digits) between the same number", () => {
  assert.equal(looksLikeDirectText({ direction: "inbound", remoteNumber: "(214) 402-3994" }, "+12144023994"), true);
  assert.equal(looksLikeDirectText({ direction: "inbound", remoteNumber: "2144023994" }, "+12144023994"), true);
});

test("buildFeedbackPrompt lists every allowed field with its meaning, and only the allowed fields' current values", () => {
  const { system, user } = buildFeedbackPrompt("bump the salary floor to 130k", prefs, "some context");
  assert.match(system, /salaryFloor: number or null/);
  assert.match(system, /Never invent a value/);
  assert.doesNotMatch(system, /scoringModel/, "pipeline-internal fields must never appear as changeable");
  assert.match(user, /"salaryFloor": 120000/);
  assert.doesNotMatch(user, /"scoringModel"/, "only allow-listed current values are shown to the model");
});

test("buildFeedbackPrompt defaults to an empty conversation history when none is passed", () => {
  const { user } = buildFeedbackPrompt("hello", prefs, "some context");
  assert.match(user, /no prior messages on file/);
});

test("buildFeedbackPrompt includes real conversation history when passed, and tells the model to use it for references", () => {
  const { system, user } = buildFeedbackPrompt("make it higher", prefs, "some context", '[2026-09-10] She said: "bump the floor to 120k"\nChanged: salaryFloor → 120000.');
  assert.match(system, /Use the conversation history below to resolve a reference/);
  assert.match(user, /bump the floor to 120k/);
});

test("buildConversationHistory renders turns oldest-first with what changed and what was replied", () => {
  const turns: ConversationTurn[] = [
    { processedAt: "2026-09-10T12:00:00Z", messageText: "bump the floor to 120k", appliedChanges: [{ field: "salaryFloor", value: 120000 }], replyBody: "Updated: salaryFloor → 120000" },
    { processedAt: "2026-09-12T12:00:00Z", messageText: "any updates?", appliedChanges: [], replyBody: "Nothing new today." },
  ];
  const history = buildConversationHistory(turns);
  assert.match(history, /bump the floor to 120k/);
  assert.match(history, /salaryFloor → 120000/);
  assert.match(history, /any updates\?/);
  assert.match(history, /Nothing new today\./);
  assert.ok(history.indexOf("bump the floor") < history.indexOf("any updates"), "oldest turn appears first");
});

test("buildConversationHistory returns a plain placeholder for an empty history, not an empty string", () => {
  assert.equal(buildConversationHistory([]), "(no prior messages on file)");
});

test("buildConversationHistory skips a turn with no message text rather than rendering a blank quote", () => {
  const turns: ConversationTurn[] = [
    { processedAt: "2026-09-10T12:00:00Z", messageText: "", appliedChanges: [], replyBody: "" },
    { processedAt: "2026-09-12T12:00:00Z", messageText: "any updates?", appliedChanges: [], replyBody: "Nothing new today." },
  ];
  const history = buildConversationHistory(turns);
  assert.doesNotMatch(history, /She said: ""/);
  assert.match(history, /any updates\?/);
});

test("buildConversationHistory keeps only the most recent `limit` turns", () => {
  const turns: ConversationTurn[] = Array.from({ length: 8 }, (_, i) => ({
    processedAt: `2026-09-${10 + i}T12:00:00Z`,
    messageText: `message ${i}`,
    appliedChanges: [],
    replyBody: "",
  }));
  const history = buildConversationHistory(turns, 3);
  assert.doesNotMatch(history, /message 0/);
  assert.doesNotMatch(history, /message 4/);
  assert.match(history, /message 5/);
  assert.match(history, /message 7/);
});

test("buildRunContext falls back honestly when no run data is available", () => {
  const context = buildRunContext(prefs, undefined);
  assert.match(context, /No recent run data available/);
});

test("buildRunContext surfaces real shortlisted roles and filter reasons from the latest run", () => {
  const latestRun: DigestPayload = {
    runId: "run-1",
    startedAt: "2026-09-16T10:00:00Z",
    finishedAt: "2026-09-16T10:05:00Z",
    counts: { fetched: 200, new: 160, duplicates: 40, filtered: 159, scored: 1, shortlisted: 1 },
    filterReasons: [{ reason: "title mismatch", count: 120 }, { reason: "below salary floor", count: 39 }],
    costUsd: 0.12,
    shortlisted: [
      {
        id: "job-1",
        title: "Senior Program Manager",
        company: "Acme Corp",
        locationClass: "remote",
        salaryStated: true,
        salaryMin: 130000,
        salaryMax: 150000,
        score: 82,
        confidence: "high",
        rationale: "Strong match on program management background.",
        gaps: ["No stated healthcare experience"],
        applyUrl: "https://example.com/apply",
        scoreDimensions: null,
      },
    ],
    health: [],
    failures: [],
  };

  const context = buildRunContext(prefs, latestRun);
  assert.match(context, /160 new postings/);
  assert.match(context, /Senior Program Manager at Acme Corp/);
  assert.match(context, /130,000-150,000/);
  assert.match(context, /No stated healthcare experience/);
  assert.match(context, /title mismatch: 120/);
});

test("buildRunContext reports plainly when nothing was shortlisted, rather than omitting the section", () => {
  const latestRun: DigestPayload = {
    runId: "run-2",
    startedAt: "2026-09-16T10:00:00Z",
    finishedAt: "2026-09-16T10:05:00Z",
    counts: { fetched: 50, new: 10, duplicates: 40, filtered: 10, scored: 0, shortlisted: 0 },
    filterReasons: [],
    costUsd: 0,
    shortlisted: [],
    health: [],
    failures: [],
  };
  const context = buildRunContext(prefs, latestRun);
  assert.match(context, /No roles were shortlisted in that run/);
});

test("parseFeedbackClassification returns the empty classification on malformed JSON, never a guess", () => {
  assert.deepEqual(parseFeedbackClassification("not json at all"), {
    hasQuestion: false,
    answerDraft: null,
    changes: [],
    unclear: [],
  });
});

test("parseFeedbackClassification returns the empty classification when the top level isn't an object", () => {
  assert.deepEqual(parseFeedbackClassification("[1,2,3]"), { hasQuestion: false, answerDraft: null, changes: [], unclear: [] });
});

test("parseFeedbackClassification reads a well-formed response with a question and a change", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({
      hasQuestion: true,
      answerDraft: "Your current floor is $120,000.",
      changes: [{ field: "salaryFloor", value: 130000, quote: "bump the floor to 130k" }],
      unclear: [],
    }),
  );
  assert.equal(result.hasQuestion, true);
  assert.equal(result.answerDraft, "Your current floor is $120,000.");
  assert.deepEqual(result.changes, [{ field: "salaryFloor", value: 130000, quote: "bump the floor to 130k" }]);
});

test("parseFeedbackClassification drops a change naming a field outside the allow-list, filing it under unclear instead of applying it", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({
      hasQuestion: false,
      answerDraft: null,
      changes: [{ field: "scoringModel", value: "gpt-5", quote: "use a different model" }],
      unclear: [],
    }),
  );
  assert.equal(result.changes.length, 0);
  assert.equal(result.unclear.length, 1);
  assert.match(result.unclear[0] ?? "", /scoringModel/);
});

test("parseFeedbackClassification drops a malformed change entry rather than crash or half-apply it", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [{ field: "salaryFloor" }], unclear: [] }),
  );
  assert.equal(result.changes.length, 0);
  assert.equal(result.unclear.length, 1);
});

test("parseFeedbackClassification preserves the model's own unclear list", () => {
  const result = parseFeedbackClassification(
    JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [], unclear: ["she mentioned wanting 'better' roles, too vague to act on"] }),
  );
  assert.deepEqual(result.unclear, ["she mentioned wanting 'better' roles, too vague to act on"]);
});

test("classifyFeedback round-trips through a fake scoring client", async () => {
  const client = new FakeScoringClient([
    JSON.stringify({
      hasQuestion: false,
      answerDraft: null,
      changes: [{ field: "metros", value: ["Houston", "Dallas", "New York", "Austin"], quote: "add Austin too" }],
      unclear: [],
    }),
  ]);
  const result = await classifyFeedback("add Austin too", prefs, "160 new, 0 shortlisted today", client, "claude-haiku-4-5");
  assert.equal(result.changes[0]?.field, "metros");
  assert.deepEqual(result.changes[0]?.value, ["Houston", "Dallas", "New York", "Austin"]);
});

test("classifyFeedback passes conversation history all the way through to the actual prompt sent", async () => {
  const client = new FakeScoringClient([JSON.stringify({ hasQuestion: false, answerDraft: null, changes: [], unclear: [] })]);
  await classifyFeedback(
    "make it higher",
    prefs,
    "some context",
    client,
    "claude-haiku-4-5",
    undefined,
    '[2026-09-10] She said: "bump the floor to 120k"\nChanged: salaryFloor → 120000.',
  );
  assert.match(client.requests[0]?.user ?? "", /bump the floor to 120k/);
});

test("applyFeedbackPatch applies a well-typed change and returns it in applied, not rejected", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [{ field: "salaryFloor", value: 130000, quote: "bump it" }]);
  assert.equal(next.salaryFloor, 130000);
  assert.equal(applied.length, 1);
  assert.equal(rejected.length, 0);
});

test("applyFeedbackPatch rejects a type-mismatched value instead of writing something that would corrupt the file", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [{ field: "salaryFloor", value: "a lot", quote: "more money" }]);
  assert.equal(next.salaryFloor, prefs.salaryFloor, "unchanged");
  assert.equal(applied.length, 0);
  assert.equal(rejected.length, 1);
});

test("applyFeedbackPatch replaces an array field wholesale with the model's full new array, not a merge", () => {
  const { next } = applyFeedbackPatch(prefs, [{ field: "titles", value: ["program manager", "project manager"], quote: "also project manager" }]);
  assert.deepEqual(next.titles, ["program manager", "project manager"]);
});

test("applyFeedbackPatch applies multiple changes in one call and reports each outcome separately", () => {
  const { next, applied, rejected } = applyFeedbackPatch(prefs, [
    { field: "scoreCutoff", value: 70, quote: "raise the bar" },
    { field: "remoteOnly", value: "yes", quote: "still remote only" }, // wrong type on purpose
  ]);
  assert.equal(next.scoreCutoff, 70);
  assert.equal(next.remoteOnly, prefs.remoteOnly);
  assert.equal(applied.length, 1);
  assert.equal(rejected.length, 1);
});

test("applyFeedbackPatch out-of-range scoreCutoff is rejected, not clamped or guessed", () => {
  const { applied, rejected } = applyFeedbackPatch(prefs, [{ field: "scoreCutoff", value: 150, quote: "way pickier" }]);
  assert.equal(applied.length, 0);
  assert.equal(rejected.length, 1);
});

test("buildFeedbackReplyBody answers her question when there is one", () => {
  const classification = { hasQuestion: true, answerDraft: "Your floor is currently $120,000.", changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], []);
  assert.equal(body, "Your floor is currently $120,000.");
});

test("buildFeedbackReplyBody is honest when there was a question but no groundable answer, rather than staying silent", () => {
  const classification = { hasQuestion: true, answerDraft: null, changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], []);
  assert.match(body, /not confident I can answer/);
});

test("buildFeedbackReplyBody lists every applied change with its new value", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const applied = [
    { field: "salaryFloor" as const, value: 130000, quote: "bump it" },
    { field: "metros" as const, value: ["Houston", "Austin"], quote: "add Austin" },
  ];
  const body = buildFeedbackReplyBody(classification, applied, []);
  assert.match(body, /salaryFloor → 130000/);
  assert.match(body, /metros → \["Houston","Austin"\]/);
});

test("buildFeedbackReplyBody surfaces both unclear items and rejected changes, inviting a clearer follow-up rather than pretending nothing happened", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: ["wants 'better' roles, too vague"] };
  const rejected = [{ field: "salaryFloor" as const, value: "a lot", quote: "way more money" }];
  const body = buildFeedbackReplyBody(classification, [], rejected);
  assert.match(body, /too vague/);
  assert.match(body, /way more money.*salaryFloor/);
  assert.match(body, /say more and I'll apply it/);
});

test("buildFeedbackReplyBody never goes silent — a message with no question and no change still gets an ack", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], []);
  assert.notEqual(body, "");
  assert.match(body, /Noted — nothing to change/);
});

test("buildFeedbackReplyBody's ack is honest about having no recent run to cite, rather than inventing numbers", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const body = buildFeedbackReplyBody(classification, [], [], undefined);
  assert.match(body, /No recent run on file/);
  assert.doesNotMatch(body, /\d+ source/);
});

test("buildFeedbackReplyBody's ack cites real source and match counts when a recent run is on file", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const latestRun = {
    runId: "r1",
    startedAt: "x",
    finishedAt: "x",
    counts: { fetched: 100, new: 10, duplicates: 90, filtered: 6, scored: 4, shortlisted: 3 },
    filterReasons: [],
    costUsd: 0,
    shortlisted: [],
    health: [
      { sourceId: "a", state: "ok" as const, postingCount: 1, error: null, checkedAt: "x" },
      { sourceId: "b", state: "ok" as const, postingCount: 1, error: null, checkedAt: "x" },
    ],
    failures: [],
  };
  const body = buildFeedbackReplyBody(classification, [], [], latestRun);
  assert.match(body, /Still watching 2 sources; 3 new matches/);
});

test("buildFeedbackReplyBody's ack uses singular wording for exactly one source or one match", () => {
  const classification = { hasQuestion: false, answerDraft: null, changes: [], unclear: [] };
  const latestRun = {
    runId: "r1",
    startedAt: "x",
    finishedAt: "x",
    counts: { fetched: 10, new: 1, duplicates: 9, filtered: 0, scored: 1, shortlisted: 1 },
    filterReasons: [],
    costUsd: 0,
    shortlisted: [],
    health: [{ sourceId: "a", state: "ok" as const, postingCount: 1, error: null, checkedAt: "x" }],
    failures: [],
  };
  const body = buildFeedbackReplyBody(classification, [], [], latestRun);
  assert.match(body, /Still watching 1 source; 1 new match in/);
});

test("buildFeedbackReplyBody still prefers an actual answer/update/unclear body over the pure ack when there's something real to say", () => {
  const classification = { hasQuestion: true, answerDraft: "Your floor is $120,000.", changes: [], unclear: [] };
  const latestRun = {
    runId: "r1",
    startedAt: "x",
    finishedAt: "x",
    counts: { fetched: 1, new: 1, duplicates: 0, filtered: 0, scored: 1, shortlisted: 1 },
    filterReasons: [],
    costUsd: 0,
    shortlisted: [],
    health: [],
    failures: [],
  };
  const body = buildFeedbackReplyBody(classification, [], [], latestRun);
  assert.equal(body, "Your floor is $120,000.");
  assert.doesNotMatch(body, /Noted — nothing to change/);
});

test("validatePreferenceValue gates scoreWeights: null or six non-negative numbers with positive total", () => {
  const good = { title: 1, experience: 1, skills: 2, location: 0.5, salary: 0, recency: 1 };
  assert.equal(validatePreferenceValue("scoreWeights", null), true, "null means use the composite");
  assert.equal(validatePreferenceValue("scoreWeights", good), true, "six non-negative weights accepted");
  assert.equal(validatePreferenceValue("scoreWeights", { title: 1 }), false, "partial set rejected");
  assert.equal(
    validatePreferenceValue("scoreWeights", { title: 0, experience: 0, skills: 0, location: 0, salary: 0, recency: 0 }),
    false,
    "all-zero weights rejected — they'd divide by zero",
  );
  assert.equal(
    validatePreferenceValue("scoreWeights", { title: -1, experience: 1, skills: 1, location: 1, salary: 1, recency: 1 }),
    false,
    "negative weights rejected",
  );
  assert.equal(validatePreferenceValue("scoreWeights", "title matters most"), false, "a string is not a weight set");
});

test("validatePreferenceValue keeps gating tailorSonnetExecution as a boolean", () => {
  assert.equal(validatePreferenceValue("tailorSonnetExecution", true), true);
  assert.equal(validatePreferenceValue("tailorSonnetExecution", false), true);
  assert.equal(validatePreferenceValue("tailorSonnetExecution", "yes"), false);
});
