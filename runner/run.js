// Headless, cold-session benchmark runner.
//
// For every vendor and both modes (support, shopping) it:
//   1. opens a FRESH browser context (isolated storage = genuinely cold session)
//   2. opens the chat widget
//   3. sends each turn of the 10-question pool
//   4. times each reply at the browser level (transcript text grows + stabilizes)
//      — headless has no background-tab throttling, so timing is reliable at depth
//   5. writes results/<date>/<vendor>-<mode>.json
//
// Usage:
//   node run.js                 # all vendors, both modes
//   node run.js --vendor gorgias sierra
//   node run.js --mode shopping
//
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { VENDORS, readTranscript } from "./vendors.js";
import { SUPPORT, SHOPPING } from "./pools.js";

const POLL_MS = 250, STABLE_MS = 4000, TURN_TIMEOUT_MS = 60000, GROWTH = 40;

// ---- Handover / escalation detection (RED FLAG) ----
// None of the pool turns ask for a human, so any handover the assistant initiates
// is unprompted = a real capability limitation: it couldn't handle the conversation.
const HANDOVER_PATTERNS = [
  /\bconnect you (with|to)\b/i,
  /\bi('|’)?ll connect you\b/i,
  /\btransfer(ring)? you (to|over)\b/i,
  /\bspeak (to|with) (a|an|our|one of our) (human|agent|team|representative|specialist|advisor)/i,
  /\b(submit|raise|create|open|log) a (support )?ticket\b/i,
  /\bour (team|agents?|support team) (will|can) (get back|follow up|reach out|be in touch|contact|assist)/i,
  /\ba (member|representative) of our team\b/i,
  /\bplease (hold|wait)\b.*(agent|available|team|connect)/i,
  /\b(fill (in|out)|complete) (the|this|a) form\b/i,
  /\benter your details\b/i,
  /\bshare (your|a few) (details|email|order number)\b.*(team|agent|connect|assist|follow)/i,
  /\b(contact|reach out to) (our|the) (support|customer) (team|service)/i,
  /\ball of our agents are (unavailable|busy)\b/i,
];
function detectHandover(text) {
  if (!text) return null;
  for (const re of HANDOVER_PATTERNS) { const m = text.match(re); if (m) return m[0].trim().slice(0, 80); }
  return null;
}

const args = process.argv.slice(2);
const pick = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.slice(i + 1).filter(a => !a.startsWith("--")) : null; };
const vendorFilter = pick("--vendor");
const modeFilter = pick("--mode");
const MODES = (modeFilter || ["support", "shopping"]);
const VENDOR_KEYS = (vendorFilter || Object.keys(VENDORS));
const STAMP = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function timeTurn(page, scope, sendFn) {
  const before = (await readTranscript(page, scope)).len;
  const t0 = Date.now();
  await sendFn();
  let lastLen = before, lastChange = t0, ttft = null, grown = false, complete = null;
  const deadline = t0 + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const { len } = await readTranscript(page, scope);
    if (len > before + GROWTH) { grown = true; if (ttft == null) ttft = Date.now() - t0; if (len !== lastLen) lastChange = Date.now(); }
    lastLen = len;
    if (grown && Date.now() - lastChange > STABLE_MS) { complete = lastChange - t0; break; }
  }
  return { ttft_ms: ttft, complete_ms: complete };
}

async function runVendorMode(browser, key, mode) {
  const v = VENDORS[key];
  const pool = mode === "support" ? SUPPORT : (SHOPPING[key] || []);
  const out = { vendor: v.label, client: v.client, us: !!v.us, mode, date: STAMP, turns: [] };
  // fresh context per (vendor,mode) => cold session, no carryover from any prior run
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  try {
    await page.goto(v.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await v.open(page);
    for (let i = 0; i < pool.length; i++) {
      const q = pool[i];
      let r;
      try { r = await timeTurn(page, v.scope, () => v.send(page, q)); }
      catch (e) { r = { ttft_ms: null, complete_ms: null, error: String(e).slice(0, 120) }; }
      const tail = (await readTranscript(page, v.scope)).text.slice(-600);
      const handover = detectHandover(tail);
      out.turns.push({ turn: i + 1, q, ...r, handover: !!handover, handover_hit: handover, replyTail: tail });
      console.log(`  [${v.label}/${mode}] T${i + 1} complete=${r.complete_ms ?? "—"}ms${handover ? "  ⛔ HANDOVER: " + handover : ""}`);
      await sleep(2500);
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
    console.log(`  [${v.label}/${mode}] FAILED: ${out.error}`);
  } finally {
    await context.close();
  }
  const valid = out.turns.map(t => t.complete_ms).filter(x => x != null);
  const handoverTurns = out.turns.filter(t => t.handover).map(t => t.turn);
  out.stats = {
    n: valid.length,
    avg_ms: valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null,
    min_ms: valid.length ? Math.min(...valid) : null,
    max_ms: valid.length ? Math.max(...valid) : null,
  };
  // RED FLAG: the assistant handed the conversation to a human on its own.
  out.red_flag = handoverTurns.length > 0;
  out.handover_turns = handoverTurns;
  if (out.red_flag) {
    out.red_flag_note = `🚩 Handover to human on turn(s) ${handoverTurns.join(", ")} of ${out.turns.length} — the assistant could not handle the conversation itself` +
      (mode === "shopping" ? " (failed to complete the sale)." : ".");
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await mkdir(`results/${STAMP}`, { recursive: true });
  for (const key of VENDOR_KEYS) {
    if (!VENDORS[key]) { console.log(`unknown vendor: ${key}`); continue; }
    for (const mode of MODES) {
      console.log(`▶ ${VENDORS[key].label} · ${mode}`);
      const res = await runVendorMode(browser, key, mode);
      await writeFile(`results/${STAMP}/${key}-${mode}.json`, JSON.stringify(res, null, 2));
      console.log(`  → avg ${res.stats.avg_ms ?? "n/a"}ms over ${res.stats.n} turns${res.red_flag ? "  🚩 RED FLAG: " + res.red_flag_note : ""}\n`);
    }
  }
  await browser.close();
  console.log(`Done. Results in results/${STAMP}/`);
})();
