// Headless, COLD-session benchmark runner — 2–3 stores per vendor.
//
// For every STORE and each mode it:
//   1. opens a FRESH browser context (isolated storage = genuinely cold session,
//      no warm carryover — the thing live Chrome can't give us)
//   2. opens the chat widget
//   3. sends each turn of the standardized pool (NO turn asks for a human)
//   4. times each reply at the browser level (transcript grows + stabilizes)
//   5. flags any unprompted handover to a human (incl. "agent joined", transfer,
//      email-gate, FR phrasings) = the failure we measure
//   6. writes results/<date>/<store>-<mode>.json + a summary.json with
//      per-store and per-vendor latency + success rate (% turns, no handover)
//
// Usage:
//   node run.js                          # all stores, both modes
//   node run.js --store gorgias-madura   # one store
//   node run.js --vendor Sierra          # all stores of a vendor
//   node run.js --mode shopping
//   node run.js --skip-candidates        # only verified stores
//
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { WIDGETS, STORES, readTranscript } from "./vendors.js";
import { SUPPORT, SHOPPING } from "./pools.js";

const POLL_MS = 250, STABLE_MS = 4000, GROWTH = 60, SETTLE_MS = 2500;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 60000;
// Real desktop UA — some chat widgets refuse to load for the default headless UA.
const REAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Some AI widgets (Rep AI, Kodif, Humind…) refuse to load in headless — they
// detect the headless browser. --headed launches the real Chrome binary with a
// visible window (still a fresh context per run = cold), which they DO load.
const HEADED = process.argv.includes("--headed") || process.env.HEADED === "1";
// Anti-automation-detection: patch the obvious headless/automation tells.
const STEALTH = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  window.chrome = { runtime: {} };
};

// Unprompted handover = the assistant bailed to a human on its own (failure).
const HANDOVER_PATTERNS = [
  /\bconnect you (with|to)\b/i, /\bi('|’)?ll connect you\b/i,
  /\btransfer(ring)? you (to|over)\b/i, /\btransf[eè]re(r|z)?\b.*(humain|conseiller|agent|ticket|demande)/i,
  /\bspeak (to|with) (a|an|our|one of our) (human|agent|team|representative|specialist|advisor)/i,
  /\b(submit|raise|create|open|log) a (support )?ticket\b/i,
  /\bour (team|agents?|support team) (will|can) (get back|follow up|reach out|be in touch|contact|assist)/i,
  /\ba (member|representative) of our team\b/i, /\bconseiller humain\b/i,
  /\b(fill (in|out)|complete) (the|this|a) form\b/i, /\benter your details\b/i,
  /\bshare (your|a few) (details|email|order number)\b.*(team|agent|connect|assist|follow)/i,
  /\b(joined|entered) the (chat|conversation)\b/i, /\ba rejoint (la )?(conversation|discussion|chat)\b/i,
  /\b\w+ (says|dit)\s*:/i, /\blaissez(\-| )?(nous|moi)?\s*(votre)?\s*(e-?mail|adresse)/i,
  /\b(leave|enter) (your|us) (e-?mail|email address)\b/i,
  /\ball of our agents are (unavailable|busy)\b/i,
];
function detectHandover(text, extra = []) {
  if (!text) return null;
  for (const re of [...HANDOVER_PATTERNS, ...extra]) { const m = text.match(re); if (m) return m[0].trim().slice(0, 80); }
  return null;
}

const args = process.argv.slice(2);
const pick = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); return out; };
const storeFilter = pick("--store");
const vendorFilter = pick("--vendor");
const modeFilter = pick("--mode");
const skipCandidates = args.includes("--skip-candidates");
// Parallelism: each (store,mode) runs in its own incognito context, so they're
// independent. Latency is network/model-bound (not CPU-bound), so modest
// concurrency doesn't skew timing. Default 4; tune with --concurrency N.
const CONC = Math.max(1, Number((pick("--concurrency") || [])[0]) || Number(process.env.CONCURRENCY) || 4);
const MODES = (modeFilter || ["shopping", "support"]);
const STAMP = (process.env.RUN_DATE || new Date().toISOString().slice(0, 10));

let targets = STORES.filter(s => s.url);
if (storeFilter) targets = targets.filter(s => storeFilter.includes(s.key));
if (vendorFilter) targets = targets.filter(s => vendorFilter.map(x => x.toLowerCase()).includes(s.vendor.toLowerCase()));
if (skipCandidates) targets = targets.filter(s => !s.candidate);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Generation/typing indicators — must NOT be treated as a finished reply.
const GEN_RE = /(Thinking|Analyzing|Typing|Searching|Looking|Writing|Processing|Almost there|En train|Réflexion|Analyse|Recherche|escribiendo|pensando)\s*\.*\s*$/i;
const isGen = (t) => GEN_RE.test((t || "").trim());

// TRUE end-to-end latency: t0 = the instant the user message is sent; complete_ms
// = the instant the AI's FULL reply finished rendering (last text change) − t0.
// We skip the user-message echo (require growth past it) and never stop on a
// "Thinking…/Almost there" indicator — that was making latencies look impossibly low.
async function timeTurn(page, scope, sendFn, q) {
  const before = (await readTranscript(page, scope)).len;
  const echoApprox = (q ? q.length : 80) + 70;   // "HH:MM. You said: <q> HH:MM"
  const REPLY_MIN = echoApprox + 40;              // growth beyond this = a real reply, not the echo
  const t0 = Date.now();
  await sendFn();
  let lastLen = before, lastChange = t0, ttft = null, sawGen = false, grownReply = false, complete = null;
  const deadline = t0 + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const { len, text } = await readTranscript(page, scope);
    if (len !== lastLen) { lastChange = Date.now(); lastLen = len; }
    if (isGen(text)) sawGen = true;
    if (len > before + REPLY_MIN) { grownReply = true; if (ttft == null) ttft = Date.now() - t0; }
    const settled = Date.now() - lastChange > STABLE_MS;
    if (settled && !isGen(text) && (grownReply || (sawGen && len > before + 40))) { complete = lastChange - t0; break; }
  }
  return { ttft_ms: ttft, complete_ms: complete, grew: lastLen - before };
}

async function runStoreMode(browser, store, mode) {
  const w = WIDGETS[store.widget];
  const pool = mode === "support" ? SUPPORT : SHOPPING;
  const out = { key: store.key, vendor: store.vendor, store: store.store, url: store.url, us: !!store.us, widget: store.widget, mode, date: STAMP, turns: [] };
  // INCOGNITO/COLD: a brand-new Playwright context has zero cookies/localStorage/
  // IndexedDB/cache for ANY origin (the widget's cross-origin storage included),
  // so there is never a pre-existing conversation. storageState is left undefined
  // (no profile) and we clear cookies as belt-and-suspenders.
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: store.locale || "en-US", timezoneId: "America/New_York", userAgent: REAL_UA, extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }, storageState: undefined });
  await context.addInitScript(STEALTH);
  await context.clearCookies().catch(() => {});
  const page = await context.newPage();

  // Capture the Gorgias ticket id + account subdomain so we can build a direct
  // agent-dashboard link to each conversation.
  const cap = { shop: null, accountId: null, appId: null, conversations: new Set(), ticketIds: new Set(), hosts: new Set() };
  if (store.widget === "gorgias") {
    const scan = (s) => {
      if (!s) return;
      let m;
      if (!cap.shop && (m = s.match(/"shopName"\s*:\s*"([^"]+)"/))) cap.shop = m[1];
      if (!cap.accountId && (m = s.match(/"account"\s*:\s*\{\s*"id"\s*:\s*(\d+)/))) cap.accountId = m[1];
      if (!cap.appId && (m = s.match(/"applicationId"\s*:\s*(\d+)/))) cap.appId = m[1];
      let re = /"conversationId"\s*:\s*"([a-f0-9-]{36})"/g; while ((m = re.exec(s))) cap.conversations.add(m[1]);
      re = /"ticket(?:_?[Ii]d)?"\s*:\s*(\d{4,})/g; while ((m = re.exec(s))) cap.ticketIds.add(m[1]);
      re = /\/tickets\/(\d{4,})/g; while ((m = re.exec(s))) cap.ticketIds.add(m[1]);
    };
    page.on("websocket", (ws) => {
      ws.on("framereceived", (f) => { try { scan(typeof f.payload === "string" ? f.payload : ""); } catch {} });
      ws.on("framesent", (f) => { try { scan(typeof f.payload === "string" ? f.payload : ""); } catch {} });
    });
    page.on("response", async (resp) => {
      try {
        const u = resp.url(); if (!/gorgias/.test(u)) return;
        cap.hosts.add(new URL(u).hostname);
        if (/ticket|message|conversation|application|widget|config/i.test(u)) { const t = await resp.text(); scan(t.slice(0, 200000)); }
      } catch {}
    });
  }

  try {
    await page.goto(store.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await w.open(page);
    let handedOver = false;
    for (let i = 0; i < pool.length; i++) {
      const q = pool[i];
      let r;
      try { r = await timeTurn(page, w.scope, () => w.send(page, q), q); }
      catch (e) { r = { ttft_ms: null, complete_ms: null, error: String(e).slice(0, 120) }; }
      const tail = (await readTranscript(page, w.scope)).text.slice(-700);
      const handover = detectHandover(tail, w.handover);
      if (handover) handedOver = true;
      // Once a human owns the thread, every later turn is human too. We NEVER
      // count a human reply's latency — only the AI's own responses are timed.
      const by = handedOver ? "human" : "ai";
      out.turns.push({ turn: i + 1, q, by, ...r, ai_latency_ms: by === "ai" ? r.complete_ms : null, handover: !!handover, handover_hit: handover, replyTail: tail.slice(-300) });
      console.log(`  [${store.key}/${mode}] T${i + 1} ${by === "ai" ? (r.complete_ms ?? "—") + "ms" : "(human)"}${handover ? "  ⛔ HANDOVER: " + handover : ""}`);
      await sleep(SETTLE_MS);
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
    console.log(`  [${store.key}/${mode}] FAILED: ${out.error}`);
  } finally {
    // Build the Gorgias agent-dashboard ticket link(s) from what we captured.
    if (store.widget === "gorgias") {
      const tids = [...cap.ticketIds], convs = [...cap.conversations];
      const sub = cap.shop, tid = tids[tids.length - 1] || null;
      out.ticket = {
        subdomain: sub, account_id: cap.accountId, application_id: cap.appId,
        ticket_id: tid, conversation_id: convs[convs.length - 1] || null,
        url: (sub && tid) ? `https://${sub}.gorgias.com/app/ticket/${tid}` : (sub ? `https://${sub}.gorgias.com/app/tickets` : null),
        all_ticket_ids: tids, all_conversations: convs, hosts: [...cap.hosts],
      };
      console.log(`  [${store.key}] ticket: shop=${sub} acct=${cap.accountId} tid=${tid} conv=${out.ticket.conversation_id}`);
    }
    await context.close();
  }

  // Latency is computed ONLY over AI turns — human replies are never timed.
  const aiValid = out.turns.filter(t => t.by === "ai").map(t => t.complete_ms).filter(x => x != null);
  const firstHandover = out.turns.find(t => t.handover);
  const answered = out.turns.filter(t => t.by === "ai" && t.complete_ms != null).length;
  out.stats = {
    turns: out.turns.length,
    answered_no_handover: answered,
    success_rate: out.turns.length ? Math.round((answered / out.turns.length) * 100) : null,
    avg_ms: aiValid.length ? Math.round(aiValid.reduce((a, b) => a + b, 0) / aiValid.length) : null,
    min_ms: aiValid.length ? Math.min(...aiValid) : null,
    max_ms: aiValid.length ? Math.max(...aiValid) : null,
    latency_basis: "AI turns only (human replies excluded)",
    handover_turn: firstHandover ? firstHandover.turn : null,
  };
  return out;
}

(async () => {
  let browser;
  const launchOpts = { headless: !HEADED, args: ["--disable-blink-features=AutomationControlled"] };
  try { browser = await chromium.launch({ ...launchOpts, channel: HEADED ? "chrome" : undefined }); }
  catch (e) { browser = await chromium.launch(launchOpts); }
  console.log(HEADED ? "Running HEADED (visible Chrome) — bot-blocked widgets load here." : "Running headless.");
  await mkdir(`results/${STAMP}`, { recursive: true });
  const summary = [];

  // Build the full (store,mode) task list and run it through a concurrency pool.
  const tasks = [];
  for (const store of targets) for (const mode of MODES) tasks.push({ store, mode });
  console.log(`Running ${tasks.length} (store×mode) jobs at concurrency ${CONC}, each in a fresh incognito context.\n`);

  let next = 0;
  async function worker(wid) {
    while (true) {
      const t = tasks[next++];               // single-threaded event loop → no race
      if (!t) break;
      console.log(`▶ [w${wid}] ${t.store.vendor} · ${t.store.store} · ${t.mode}`);
      const res = await runStoreMode(browser, t.store, t.mode);
      await writeFile(`results/${STAMP}/${t.store.key}-${t.mode}.json`, JSON.stringify(res, null, 2));
      summary.push({ key: t.store.key, vendor: t.store.vendor, store: t.store.store, us: res.us, mode: t.mode, ...res.stats, error: res.error || null });
      console.log(`  ← [${t.store.key}/${t.mode}] success ${res.stats.success_rate ?? "n/a"}% · avg ${res.stats.avg_ms ?? "n/a"}ms${res.stats.handover_turn ? `  🚩 handover @T${res.stats.handover_turn}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, (_, i) => worker(i + 1)));
  await browser.close();

  // per-vendor rollup (one line per vendor per mode), matching the report's top table
  const byVendorMode = {};
  for (const s of summary) {
    const k = s.vendor + "|" + s.mode;
    (byVendorMode[k] = byVendorMode[k] || []).push(s);
  }
  const vendorRollup = Object.entries(byVendorMode).map(([k, arr]) => {
    const [vendor, mode] = k.split("|");
    const sr = arr.map(a => a.success_rate).filter(x => x != null);
    const la = arr.map(a => a.avg_ms).filter(x => x != null);
    return {
      vendor, mode, stores: arr.length,
      avg_success_rate: sr.length ? Math.round(sr.reduce((a, b) => a + b, 0) / sr.length) : null,
      avg_latency_ms: la.length ? Math.round(la.reduce((a, b) => a + b, 0) / la.length) : null,
    };
  });
  await writeFile(`results/${STAMP}/summary.json`, JSON.stringify({ date: STAMP, perStore: summary, perVendor: vendorRollup }, null, 2));
  console.log(`Done. Per-store + summary.json in results/${STAMP}/`);
})();
