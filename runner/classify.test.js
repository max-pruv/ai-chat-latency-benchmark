// Unit tests for the crawler's decision logic.  Run:  node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGen, isAck, isNoAnswer, detectHandover, convoValidity } from "./classify.js";

// ---- typing / stall indicators ----------------------------------------------
// GEN_RE / ACK_RE are END-anchored by design: they flag a *bare* typing/stall bubble
// ("Thinking…", "One moment"). Longer messages are gated by the REPLY_MIN length threshold
// in run.js, not by these regexes.
test("isGen: a bare typing indicator is 'still working', real answers are not", () => {
  assert.equal(isGen("Thinking…"), true);
  assert.equal(isGen("Searching"), true);
  assert.equal(isGen("Our 90-day return policy covers unworn items."), false);
});

test("isAck: a bare stall message is detected, substantive answers pass through", () => {
  assert.equal(isAck("One moment"), true);
  assert.equal(isAck("Let me check"), true);
  assert.equal(isAck("Un instant"), true);
  assert.equal(isAck("Standard shipping takes 3-5 business days and is free over $50."), false);
});

// ---- no-answer (offline / menu) --------------------------------------------
test("isNoAnswer: offline & 'leave a message' menus are NOT real answers", () => {
  assert.equal(isNoAnswer("You're offline. Reconnecting..."), true);
  assert.equal(isNoAnswer("Track and manage my orders. Here to help! Leave a message"), true);
  assert.equal(isNoAnswer("Select an option"), true);
  assert.equal(isNoAnswer("Yes — we ship to Canada; duties are calculated at checkout."), false);
});

// ---- handover detection (the Zendesk-VA regression) -------------------------
test("detectHandover: a bot's own 'AI says:' / 'Virtual Assistant says:' is NOT a handover", () => {
  assert.equal(detectHandover("Dermalogica's Virtual Assistant · AI says: Was this helpful?"), null);
  assert.equal(detectHandover("Assistant says: here are three cleansers you might like"), null);
});

test("detectHandover: a NAMED human agent IS a handover", () => {
  assert.ok(detectHandover("Sarah says: hi, taking over from here"));
  assert.ok(detectHandover("Sébastien a rejoint la conversation"));
});

test("detectHandover: explicit human-escalation phrases ARE a handover", () => {
  assert.ok(detectHandover("Please share a few details and I'll connect you with someone from our team"));
  assert.ok(detectHandover("A member of our team will get back to you"));
  assert.ok(detectHandover("Let me transfer you to an agent"));
});

test("detectHandover: a normal AI answer is not a handover", () => {
  assert.equal(detectHandover("Our best-seller is the Daily Microfoliant — great for beginners."), null);
});

// ---- conversation validity gate --------------------------------------------
const aiTurn = (ms) => ({ by: "ai", complete_ms: ms, handover: false });

test("convoValidity: no timed answers + no handover = INVALID (menu/offline/timeout noise)", () => {
  // Yuma-support / JSHealth style: widget never gave a measurable answer
  const turns = [aiTurn(null), aiTurn(null), aiTurn(null), aiTurn(null), aiTurn(null)];
  const v = convoValidity(turns);
  assert.equal(v.valid, false);
  assert.equal(v.timed, 0);
});

test("convoValidity: a handover with too few timed answers is still INVALID (no latency to report)", () => {
  // Immediate/early bail (e.g. Yuma/Meta) has a handover but < minTimed measured answers.
  const turns = [aiTurn(9000), aiTurn(8000), { by: "human", complete_ms: null, handover: true }];
  const v = convoValidity(turns);
  assert.equal(v.valid, false);          // 2 timed < 3 → excluded despite handover
  assert.equal(v.hadHandover, true);
});

test("convoValidity: enough timed answers THEN a handover = VALID (real latency + a finding)", () => {
  const turns = [aiTurn(9000), aiTurn(8000), aiTurn(7000), aiTurn(6000), { by: "human", complete_ms: null, handover: true }];
  const v = convoValidity(turns);
  assert.equal(v.valid, true);
  assert.equal(v.hadHandover, true);
});

test("convoValidity: enough cleanly-timed answers = VALID", () => {
  const turns = [aiTurn(9000), aiTurn(8000), aiTurn(5900), aiTurn(7000), aiTurn(14900)];
  assert.equal(convoValidity(turns).valid, true);
});

test("convoValidity: 2 timed and no handover = INVALID (below minTimed=3)", () => {
  const turns = [aiTurn(9000), aiTurn(8000), aiTurn(null), aiTurn(null)];
  assert.equal(convoValidity(turns).valid, false);
});

test("convoValidity: 'unsent' post-handover placeholders don't count as attempts", () => {
  const turns = [
    aiTurn(9000), aiTurn(8000), aiTurn(7000), { by: "human", complete_ms: null, handover: true },
    { by: "human", unsent: true, complete_ms: null }, { by: "human", unsent: true, complete_ms: null },
  ];
  const v = convoValidity(turns);
  assert.equal(v.valid, true);
  assert.equal(v.aiAttempted, 3);
});
