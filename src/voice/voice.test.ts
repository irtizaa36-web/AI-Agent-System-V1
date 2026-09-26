import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createVoiceDeps, voiceSwitchesFromEnv, type VoiceSwitches } from "./deps";
import { composeReply, sha256 } from "./drafter";
import { readIntents } from "./intent";
import { redactCodes, SecretCode } from "./redact";
import { classifyScam } from "./scam";
import { servicesNamed } from "./services";
import { InMemoryVoiceStateStore, JsonFileVoiceStateStore } from "./store";
import { FakeVoiceReplyTransport, OutboxVoiceReplyTransport, type VoiceReplyTransport } from "./transport";
import type { Listing, VoiceEmailInput, VoiceInbound } from "./types";
import { extractCode, VERIFICATION_WINDOW_MS } from "./verification";
import { parseVoiceEmail, toVoiceEmailInput } from "./voice-email";

// Every number and address here is fictional (555-01xx is reserved for fiction).
const BUYER_REPLY = "15550100001.15550100002.aBcD1234@txt.voice.google.com";
const T0 = new Date("2026-09-26T15:00:00Z");
const HEADER = "<https://voice.google.com>";
const FOOTER = "\n\nTo respond to this message, launch Google Voice (https://voice.google.com) on your mobile device or computer.\nYOUR ACCOUNT HELP CENTER HELP FORUM\nGoogle LLC 1600 Amphitheatre Pkwy";

let seq = 0;
function textEmail(body: string, overrides: Partial<VoiceEmailInput> = {}): VoiceEmailInput {
  seq += 1;
  return {
    id: `msg-${seq}`,
    threadId: overrides.threadId ?? `thread-${seq}`,
    from: `"(555) 010-0001" <${BUYER_REPLY}>`,
    subject: "New text message from (555) 010-0001",
    body: HEADER + "\n" + body + FOOTER,
    receivedAt: T0.toISOString(),
    ...overrides,
  };
}

function inbound(body: string, overrides: Partial<VoiceEmailInput> = {}): VoiceInbound {
  const parsed = parseVoiceEmail(textEmail(body, overrides));
  assert.ok(parsed, "fixture must parse");
  return parsed;
}

const COUCH: Listing = {
  id: "couch",
  title: "grey sectional couch",
  price: 250,
  priceFirm: false,
  localOnly: true,
  pickupWindows: ["Saturday 10am-2pm", "weekdays after 6pm"],
  pickupArea: "the library parking lot on Main St",
  status: "available",
};

const ALL_ON: VoiceSwitches = { codeBroker: true, replyDrafting: true, replySending: true };

function harness(switches: VoiceSwitches = ALL_ON, transport: VoiceReplyTransport = new FakeVoiceReplyTransport()) {
  let now = T0;
  const store = new InMemoryVoiceStateStore();
  const voice = createVoiceDeps({ store, transport, switches, now: () => now });
  return { voice, store, transport, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

// ── switches ─────────────────────────────────────────────────────────────

test("switches: every piece is off unless its variable is exactly \"true\"", () => {
  assert.deepEqual(voiceSwitchesFromEnv({}), { codeBroker: false, replyDrafting: false, replySending: false });
  for (const value of ["TRUE", "1", "yes", " true", "true ", "on", ""]) {
    const s = voiceSwitchesFromEnv({ VOICE_CODE_BROKER_ENABLED: value, VOICE_REPLY_DRAFTER_ENABLED: value, VOICE_REPLY_SEND_ENABLED: value });
    assert.deepEqual(s, { codeBroker: false, replyDrafting: false, replySending: false }, `value ${JSON.stringify(value)}`);
  }
  assert.deepEqual(
    voiceSwitchesFromEnv({ VOICE_CODE_BROKER_ENABLED: "true", VOICE_REPLY_DRAFTER_ENABLED: "true", VOICE_REPLY_SEND_ENABLED: "true" }),
    ALL_ON,
  );
});

// ── parsing Voice emails ─────────────────────────────────────────────────

test("parse: a forwarded text keeps the message, drops Google's footer, and keeps the reply address", () => {
  const m = parseVoiceEmail(textEmail("Is the couch still available?"));
  assert.ok(m);
  assert.equal(m.kind, "text");
  assert.equal(m.text, "Is the couch still available?");
  assert.equal(m.counterparty, "(555) 010-0001");
  assert.equal(m.replyAddress, BUYER_REPLY);
});

test("parse: a voicemail has its transcript and no reply address", () => {
  const m = parseVoiceEmail(
    textEmail("Hi, calling about the couch, call me back.\nplay message", {
      from: "Google Voice <voice-noreply@google.com>",
      subject: "New voicemail from (555) 010-0003",
    }),
  );
  assert.ok(m);
  assert.equal(m.kind, "voicemail");
  assert.equal(m.text, "Hi, calling about the couch, call me back.");
  assert.equal(m.replyAddress, undefined);
});

test("parse: anything not from Google Voice, or with an unknown subject, is ignored", () => {
  assert.equal(parseVoiceEmail(textEmail("hi", { from: "someone@example.com" })), undefined);
  assert.equal(parseVoiceEmail(textEmail("hi", { from: "voice-noreply@google.com.evil.example" })), undefined);
  assert.equal(parseVoiceEmail(textEmail("hi", { subject: "Missed call from (555) 010-0004" })), undefined);
  assert.equal(parseVoiceEmail(textEmail("", { body: FOOTER })), undefined);
});

test("parse: the handed-over JSON is validated field by field", () => {
  assert.throws(() => toVoiceEmailInput({ id: "x" }), /message\.threadId/);
  assert.throws(() => toVoiceEmailInput({ ...textEmail("hi"), receivedAt: "yesterday" }), /receivedAt/);
  assert.equal(toVoiceEmailInput(textEmail("hi")).body.includes("\nhi\n"), true);
});

// ── redaction and SecretCode ─────────────────────────────────────────────

test("redact: code-shaped tokens are replaced, long numbers and short numbers are not", () => {
  assert.equal(redactCodes("G-482913 is your Google verification code."), "[code] is your Google verification code.");
  assert.equal(redactCodes("Your code is 482 913"), "Your code is [code]");
  assert.equal(redactCodes("Use 4821 to sign in"), "Use [code] to sign in");
  assert.equal(redactCodes("order 5550100001234"), "order 5550100001234");
  assert.equal(redactCodes("meet at 10:30"), "meet at 10:30");
});

test("SecretCode never prints its value except through reveal()", () => {
  const code = new SecretCode("482913");
  assert.equal(code.reveal(), "482913");
  assert.equal(`${code}`, "[redacted]");
  assert.equal(JSON.stringify({ code }), '{"code":"[redacted]"}');
  assert.equal(inspect(code).includes("482913"), false);
});

test("extractCode: needs verification wording and exactly one distinct code", () => {
  assert.equal(extractCode("G-482913 is your Google verification code")?.reveal(), "482913");
  assert.equal(extractCode("Your Uber code: 4821. Never share this code.")?.reveal(), "4821");
  assert.equal(extractCode("Your code is 482 913")?.reveal(), "482913");
  assert.equal(extractCode("Couch pickup at 4821 Elm St?"), undefined);
  assert.equal(extractCode("Your code is 1111 or 2222"), undefined);
});

// ── verification broker ──────────────────────────────────────────────────

test("broker: off by default. It does nothing and can't open a verification", async () => {
  const h = harness({ codeBroker: false, replyDrafting: false, replySending: false });
  assert.deepEqual(await h.voice.broker.ingest(inbound("Your Google verification code is 482913")), { kind: "disabled" });
  await assert.rejects(h.voice.broker.start("google", { purpose: "test" }), /broker is off/);
});

test("broker: a code for the service the agent is waiting on, within 10 minutes, is consumed exactly once", async () => {
  const h = harness();
  const pending = await h.voice.broker.start("Google", { purpose: "Toozy asked to set up the survey panel's Google login" });
  h.advance(3 * 60 * 1000);
  const message = inbound("G-482913 is your Google verification code.");
  const outcome = await h.voice.broker.ingest(message);
  assert.equal(outcome.kind, "consumed");
  assert.ok(outcome.kind === "consumed");
  assert.equal(outcome.code.reveal(), "482913");
  assert.equal(outcome.pending.id, pending.id);
  assert.equal(outcome.pending.status, "consumed");
  assert.equal(outcome.pending.consumedFromMessageId, message.messageId);

  // Same message again: nothing happens. A second code: the verification is closed, so it's an alert.
  assert.equal((await h.voice.broker.ingest(message)).kind, "already-processed");
  const second = await h.voice.broker.ingest(inbound("G-777123 is your Google verification code."));
  assert.equal(second.kind === "alert" && second.alert.reason, "no-pending-verification");
  assert.equal(h.store.raw().includes("482913"), false);
  assert.equal(h.store.raw().includes("777123"), false);
});

test("broker: a code nobody asked for is an alert, and the code isn't stored", async () => {
  const h = harness();
  const outcome = await h.voice.broker.ingest(inbound("Your Microsoft security code is 90871234"));
  assert.equal(outcome.kind, "alert");
  assert.ok(outcome.kind === "alert");
  assert.equal(outcome.alert.reason, "no-pending-verification");
  assert.equal(outcome.alert.redactedText.includes("90871234"), false);
  assert.match(outcome.alert.redactedText, /\[code\]/);
  assert.equal(h.store.raw().includes("90871234"), false);
});

test("broker: a verification 10 minutes old or older no longer matches", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  h.advance(VERIFICATION_WINDOW_MS);
  const outcome = await h.voice.broker.ingest(inbound("G-482913 is your Google verification code."));
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "pending-expired");
});

test("broker: 9m59s still matches", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  h.advance(VERIFICATION_WINDOW_MS - 1000);
  assert.equal((await h.voice.broker.ingest(inbound("G-482913 is your Google verification code."))).kind, "consumed");
});

test("broker: a code naming a different service than the one waited on is an alert", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  const outcome = await h.voice.broker.ingest(inbound("Your Microsoft account code is 482913"));
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "service-mismatch");
  const open = (await h.voice.broker.list()).filter((p) => p.status === "open");
  assert.equal(open.length, 1, "the Google verification stays open");
});

test("broker: a code that names no service is an alert", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  const outcome = await h.voice.broker.ingest(inbound("Your verification code is 482913"));
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "service-not-named");
});

test("broker: a code naming two services the agent is waiting on is ambiguous", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  await h.voice.broker.start("microsoft", { purpose: "p" });
  const outcome = await h.voice.broker.ingest(inbound("Use code 482913 to link your Microsoft account to Google"));
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "ambiguous-service");
});

test("broker: extra aliases let a service outside the catalog match", async () => {
  const h = harness();
  await h.voice.broker.start("acme panel", { purpose: "survey signup", aliases: ["acme"] });
  const outcome = await h.voice.broker.ingest(inbound("Your ACME verification code: 5519"));
  assert.equal(outcome.kind === "consumed" && outcome.code.reveal(), "5519");
});

test("broker: X, payment apps and exchanges are refused (real mobile only)", async () => {
  const h = harness();
  for (const service of ["X", "paypal", "Polymarket", "Venmo"]) {
    await assert.rejects(h.voice.broker.start(service, { purpose: "p" }), /real mobile/);
  }
  assert.equal((await h.voice.broker.list()).length, 0);
});

test("broker: cancelling closes the window", async () => {
  const h = harness();
  const p = await h.voice.broker.start("google", { purpose: "p" });
  await h.voice.broker.cancel(p.id);
  const outcome = await h.voice.broker.ingest(inbound("G-482913 is your Google verification code."));
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "no-pending-verification");
});

test("broker: ordinary texts are left for the drafter", async () => {
  const h = harness();
  assert.equal((await h.voice.broker.ingest(inbound("Is the couch still available?"))).kind, "not-a-code");
});

// ── scam classifier ──────────────────────────────────────────────────────

test("scam: each scheme is flagged", () => {
  const cases: [string, string][] = [
    ["Before I come, I'm sending you a code to verify you're real, just text it back", "verification-code-request"],
    ["Can you read me the 6 digit code google sent you?", "verification-code-request"],
    ["I'll pay with a cashier's check for $400 and you refund the rest", "overpayment-scheme"],
    ["I sent $350 by Zelle but it's pending until you upgrade to a business account", "overpayment-scheme"],
    ["I accidentally overpaid, please send back the difference", "overpayment-scheme"],
    ["What's your email so I can pay you through PayPal?", "paypal-email-phishing"],
    ["Please scan this QR code to receive payment", "qr-code"],
  ];
  for (const [text, flag] of cases) assert.ok(classifyScam(text, COUCH).includes(flag as never), `${flag}: ${text}`);
});

test("scam: shipping-only buyers are flagged on local listings only", () => {
  const text = "I'm out of town, can you ship it? I'll cover FedEx";
  assert.ok(classifyScam(text, COUCH).includes("shipping-only-local"));
  assert.equal(classifyScam(text, { ...COUCH, localOnly: false }).includes("shipping-only-local"), false);
});

test("scam: ordinary buyer questions raise no flag", () => {
  for (const text of ["Is this still available?", "How much for the couch?", "Can I pick up Saturday morning?", "I can pay cash or Zelle when I pick up"]) {
    assert.deepEqual(classifyScam(text, COUCH), [], text);
  }
});

// ── intents ──────────────────────────────────────────────────────────────

test("intents: availability, price and pickup are routine; offers and item questions need Toozy", () => {
  assert.deepEqual(readIntents("Is this still available? How much? When can I pick up?").routine, ["availability", "price", "pickup"]);
  assert.deepEqual(readIntents("Is this still available?").needsToozy, []);
  assert.ok(readIntents("Would you take $150?").needsToozy.length > 0);
  assert.ok(readIntents("Still available? Any stains or pet smell?").needsToozy.includes("question about the item itself"));
  assert.ok(readIntents("hello").needsToozy.length > 0);
});

// ── reply drafter ────────────────────────────────────────────────────────

test("drafter: off by default", async () => {
  const h = harness({ codeBroker: false, replyDrafting: false, replySending: false });
  assert.deepEqual(await h.voice.drafter.handle(inbound("Is this still available?")), { kind: "disabled" });
});

test("drafter: a routine question gets a templated draft that waits for approval", async () => {
  const h = harness();
  await h.voice.drafter.addListing(COUCH);
  const outcome = await h.voice.drafter.handle(inbound("Hey is this still available? what's the price and when can I pick up"));
  assert.equal(outcome.kind, "drafted");
  assert.ok(outcome.kind === "drafted");
  assert.equal(outcome.draft.status, "pending_approval");
  assert.equal(outcome.draft.replyAddress, BUYER_REPLY);
  assert.equal(
    outcome.draft.body,
    "Hi! Yes, the grey sectional couch is still available. It's $250. Pickup at the library parking lot on Main St works Saturday 10am-2pm or weekdays after 6pm. What works best for you?",
  );
});

test("drafter: a scam text gets an alert and no draft", async () => {
  const h = harness();
  await h.voice.drafter.addListing(COUCH);
  const outcome = await h.voice.drafter.handle(inbound("Still available? What's your email for PayPal, I'll pay now"));
  assert.equal(outcome.kind, "scam-alert");
  assert.ok(outcome.kind === "scam-alert");
  assert.deepEqual(outcome.flags, ["paypal-email-phishing"]);
  const doc = await h.store.load();
  assert.equal(doc.drafts.length, 0);
  assert.equal(doc.alerts.length, 1);
  assert.equal(doc.alerts[0].reason, "scam-suspected");
});

test("drafter: code-relay requests are flagged even when they contain digits", async () => {
  const h = harness();
  await h.voice.drafter.addListing(COUCH);
  const outcome = await h.voice.drafter.handle(inbound("I need to verify you are real. Send me the verification code 482913 I texted"));
  assert.equal(outcome.kind, "scam-alert");
  assert.equal(h.store.raw().includes("482913"), false);
});

test("drafter: no listing, several unlinked listings, offers and item questions all need Toozy", async () => {
  const h = harness();
  assert.equal((await h.voice.drafter.handle(inbound("Still available?"))).kind, "needs-toozy");
  await h.voice.drafter.addListing(COUCH);
  await h.voice.drafter.addListing({ ...COUCH, id: "lamp", title: "floor lamp", price: 20 });
  const unlinked = await h.voice.drafter.handle(inbound("Still available?", { threadId: "t-lamp" }));
  assert.equal(unlinked.kind, "needs-toozy");
  await h.voice.drafter.linkThread("t-lamp2", "lamp");
  const linked = await h.voice.drafter.handle(inbound("Still available?", { threadId: "t-lamp2" }));
  assert.equal(linked.kind === "drafted" && linked.draft.listingId, "lamp");
  await h.voice.drafter.linkThread("t-offer", "lamp");
  assert.equal((await h.voice.drafter.handle(inbound("Would you take $10?", { threadId: "t-offer" }))).kind, "needs-toozy");
});

test("drafter: voicemails and verification texts are never drafted against", async () => {
  const h = harness({ codeBroker: false, replyDrafting: true, replySending: false });
  await h.voice.drafter.addListing(COUCH);
  const vm = inbound("Calling about the couch", { from: "voice-noreply@google.com", subject: "New voicemail from (555) 010-0003" });
  assert.equal((await h.voice.drafter.handle(vm)).kind, "not-a-text");
  assert.equal((await h.voice.drafter.handle(inbound("Your Google verification code is 482913"))).kind, "verification-text");
});

test("drafter: sold and pending listings get a short no, never a yes", () => {
  assert.equal(composeReply({ ...COUCH, status: "sold" }, ["availability", "price"]), "Sorry, the grey sectional couch has sold.");
  assert.match(composeReply({ ...COUCH, status: "pending" }, ["availability"]), /pickup pending/);
  assert.equal(composeReply({ ...COUCH, priceFirm: true }, ["price"]), "Hi! It's $250, and the price is firm.");
});

// ── approval and sending ─────────────────────────────────────────────────

async function drafted(h: ReturnType<typeof harness>) {
  await h.voice.drafter.addListing(COUCH);
  const outcome = await h.voice.drafter.handle(inbound("Is this still available?"));
  assert.ok(outcome.kind === "drafted");
  return outcome.draft;
}

test("send: nothing leaves without Toozy's approval of the exact text", async () => {
  const transport = new FakeVoiceReplyTransport();
  const h = harness(ALL_ON, transport);
  const draft = await drafted(h);
  await assert.rejects(h.voice.drafter.send(draft.id), /Only a draft Toozy approved/);
  await assert.rejects(h.voice.drafter.approve(draft.id, 1, draft.body + " "), /doesn't match/);
  await assert.rejects(h.voice.drafter.approve(draft.id, 2, draft.body), /revision 1, not 2/);
  assert.equal(transport.sent.length, 0);

  const approved = await h.voice.drafter.approve(draft.id, 1, draft.body);
  assert.equal(approved.approvedBodySha256, sha256(draft.body));
  const sent = await h.voice.drafter.send(draft.id);
  assert.equal(sent.status, "sent");
  assert.deepEqual(transport.sent, [
    { draftId: draft.id, threadId: draft.threadId, inReplyToMessageId: draft.inReplyToMessageId, to: BUYER_REPLY, body: draft.body },
  ]);
  await assert.rejects(h.voice.drafter.send(draft.id), /is sent/);
  assert.equal(transport.sent.length, 1);
});

test("send: the send switch is separate from drafting", async () => {
  const transport = new FakeVoiceReplyTransport();
  const h = harness({ codeBroker: false, replyDrafting: true, replySending: false }, transport);
  const draft = await drafted(h);
  await h.voice.drafter.approve(draft.id, 1, draft.body);
  await assert.rejects(h.voice.drafter.send(draft.id), /Sending is off/);
  assert.equal(transport.sent.length, 0);
});

test("send: editing after approval needs a fresh approval", async () => {
  const transport = new FakeVoiceReplyTransport();
  const h = harness(ALL_ON, transport);
  const draft = await drafted(h);
  await h.voice.drafter.approve(draft.id, 1, draft.body);
  const edited = await h.voice.drafter.edit(draft.id, "Yes, still available! Saturday works.");
  assert.equal(edited.status, "pending_approval");
  assert.equal(edited.revision, 2);
  assert.equal(edited.approvedBodySha256, undefined);
  await assert.rejects(h.voice.drafter.send(draft.id), /Only a draft Toozy approved/);
  await h.voice.drafter.approve(draft.id, 2, "Yes, still available! Saturday works.");
  await h.voice.drafter.send(draft.id);
  assert.equal(transport.sent[0].body, "Yes, still available! Saturday works.");
});

test("send: refused when the listing's status changed after the draft was written", async () => {
  const transport = new FakeVoiceReplyTransport();
  const h = harness(ALL_ON, transport);
  const draft = await drafted(h);
  await h.voice.drafter.approve(draft.id, 1, draft.body);
  await h.voice.drafter.setListingStatus("couch", "sold");
  await assert.rejects(h.voice.drafter.send(draft.id), /status changed/);
  assert.equal(transport.sent.length, 0);
});

test("send: a transport failure leaves the draft approved and is not retried", async () => {
  const transport = new FakeVoiceReplyTransport();
  transport.failNext = new Error("gmail down");
  const h = harness(ALL_ON, transport);
  const draft = await drafted(h);
  await h.voice.drafter.approve(draft.id, 1, draft.body);
  await assert.rejects(h.voice.drafter.send(draft.id), /gmail down/);
  assert.equal((await h.voice.drafter.drafts())[0].status, "approved");
  assert.equal(transport.sent.length, 0);
});

test("send: the outbox transport releases once, then mark-sent records the Gmail reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-outbox-"));
  try {
    const h = harness(ALL_ON, new OutboxVoiceReplyTransport(dir));
    const draft = await drafted(h);
    await assert.rejects(h.voice.drafter.markSent(draft.id, "gm-1"), /only a released draft/);
    await h.voice.drafter.approve(draft.id, 1, draft.body);
    const released = await h.voice.drafter.send(draft.id);
    assert.equal(released.status, "released");
    const files = await readdir(dir);
    assert.deepEqual(files, [`${draft.id}.json`]);
    const handed = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
    assert.equal(handed.body, draft.body);
    assert.equal(handed.to, BUYER_REPLY);
    const sent = await h.voice.drafter.markSent(draft.id, "gm-1");
    assert.equal(sent.status, "sent");
    assert.equal(sent.sendReference, "gm-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── file storage ─────────────────────────────────────────────────────────

test("file store: state round-trips, contains no code value, and a corrupt file is never reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-state-"));
  try {
    const path = join(dir, "voice", "state.json");
    const store = new JsonFileVoiceStateStore(path);
    const voice = createVoiceDeps({ store, transport: new FakeVoiceReplyTransport(), switches: ALL_ON, now: () => T0 });
    await voice.broker.start("google", { purpose: "p" });
    const consumed = await voice.broker.ingest(inbound("G-482913 is your Google verification code."));
    assert.equal(consumed.kind, "consumed");
    await voice.broker.ingest(inbound("Your Microsoft code is 90871234"));
    const text = await readFile(path, "utf8");
    assert.equal(text.includes("482913"), false);
    assert.equal(text.includes("90871234"), false);
    assert.equal((await store.load()).alerts.length, 1);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not json");
    await assert.rejects(store.load(), /not valid JSON/);
    assert.equal(await readFile(path, "utf8"), "{not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── real-email regressions (gaps found by the 2026-09-26 self-test) ───────
// Fictional codes only; nothing here touches the network or a real account.

test("parse: Google's own header and footer are chrome, never message text", () => {
  const m = parseVoiceEmail(textEmail("Your Retell AI verification code is: 482916"));
  assert.ok(m);
  assert.equal(m.text, "Your Retell AI verification code is: 482916");
  assert.ok(!servicesNamed(m.text).has("google"), "Google's chrome must not count as naming Google");
});

test("broker: an open Google verification does not take a Retell code", async () => {
  const h = harness();
  await h.voice.broker.start("google", { purpose: "p" });
  const outcome = await h.voice.broker.ingest(inbound("Your Retell AI verification code is: 482916"));
  // The message names no service the broker knows, so it alerts instead of
  // being consumed by the open Google verification.
  assert.equal(outcome.kind === "alert" && outcome.alert.reason, "service-not-named");
  const open = (await h.voice.broker.list()).filter((p) => p.status === "open");
  assert.equal(open.length, 1, "the Google verification stays open");
});

test("broker: a Retell code matches an open Retell verification", async () => {
  const h = harness();
  await h.voice.broker.start("retell ai", { purpose: "voice agent signup", aliases: ["retell"] });
  const outcome = await h.voice.broker.ingest(inbound("Your Retell AI verification code is: 482916"));
  assert.equal(outcome.kind === "consumed" && outcome.code.reveal(), "482916");
});

test("services: X, banks and medical terms are named", () => {
  assert.ok(servicesNamed("X: your code is 482916").has("x"));
  assert.ok(servicesNamed("Chase: your verification code is 482916").has("chase"));
  assert.ok(servicesNamed("Dr. Smith: your code is 482916").has("medical"));
  assert.ok(servicesNamed("Your appointment is confirmed for Tuesday").has("medical"));
});

test("broker: banks are real-mobile-only, medical is never verified", async () => {
  const h = harness();
  await assert.rejects(h.voice.broker.start("chase", { purpose: "p" }), /real mobile/);
  await assert.rejects(h.voice.broker.start("medical", { purpose: "p" }), /never verified/);
  assert.equal((await h.voice.broker.list()).length, 0);
});

test("scam: a code relay that avoids the words code/PIN/digits is flagged", () => {
  assert.ok(classifyScam("read back the number Google texts you", COUCH).includes("verification-code-request"));
  assert.deepEqual(
    classifyScam("give me your number, I'll text you about the couch", COUCH).filter((f) => f === "verification-code-request"),
    [],
  );
});

test("intent: 'what time works Saturday?' is a pickup question", () => {
  const r = readIntents("what time works Saturday?");
  assert.ok(r.routine.includes("pickup"));
  assert.deepEqual(r.needsToozy, []);
  assert.ok(readIntents("does it still work?").needsToozy.includes("question about the item itself"));
});
