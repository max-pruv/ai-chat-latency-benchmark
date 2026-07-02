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
import { existsSync, readFileSync } from "node:fs";
import { WIDGETS, STORES, readTranscript } from "./vendors.js";
import { SHOPPING_THEMES, SUPPORT_THEMES } from "./pools.js";
import { isGen, isAck, isNoAnswer, detectHandover, convoValidity } from "./classify.js";

const POLL_MS = 250, STABLE_MS = 5000, GROWTH = 60, SETTLE_MS = 2500;
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
  // A real-ish chrome.runtime stub. The old `{runtime:{}}` had a truthy `runtime` but no
  // sendMessage(), so widgets that do `if (chrome.runtime) chrome.runtime.sendMessage(...)`
  // (e.g. Spiffy/Envive's init) threw and aborted before mounting. Provide no-op functions.
  const _noop = () => {};
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  if (typeof window.chrome.runtime.sendMessage !== "function") window.chrome.runtime.sendMessage = () => Promise.resolve();
  if (typeof window.chrome.runtime.connect !== "function") window.chrome.runtime.connect = () => ({ postMessage: _noop, onMessage: { addListener: _noop }, disconnect: _noop });
  try { if (!("lastError" in window.chrome.runtime)) Object.defineProperty(window.chrome.runtime, "lastError", { get: () => undefined }); } catch {}
  // Sierra: find the shadow root that CONTAINS the composer (its aria-label is never in
  // textContent, so text-needle matching fails). Used by the sierra handler + reader.
  window.__sierraRoot = (composerSel) => {
    let found = null;
    const walk = (n) => {
      if (found || !n) return;
      for (const el of (n.querySelectorAll ? n.querySelectorAll("*") : [])) if (el.shadowRoot) {
        if (el.shadowRoot.querySelector(composerSel)) { found = el.shadowRoot; return; }
        walk(el.shadowRoot); if (found) return;
      }
    };
    walk(document);
    return found;
  };
};

// Handover detection lives in classify.js (imported above) so it can be unit-tested.

const args = process.argv.slice(2);
const pick = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); return out; };
const storeFilter = pick("--store");
const vendorFilter = pick("--vendor");
const modeFilter = pick("--mode");
const skipCandidates = args.includes("--skip-candidates");
const RESUME = !args.includes("--no-resume");   // skip (store,mode) already written this run-date → survives kills
const SERIAL = args.includes("--serial");        // per-store serialize (cleaner latency, slower); default OFF = max throughput
// Parallelism: each (store,mode) runs in its own incognito context, so they're
// independent. Latency is network/model-bound (not CPU-bound), so modest
// concurrency doesn't skew timing. Default 4; tune with --concurrency N.
const CONC = Math.max(1, Number((pick("--concurrency") || [])[0]) || Number(process.env.CONCURRENCY) || 4);
const THEME_LIMIT = Number((pick("--themes") || [])[0]) || 0;   // 0 = all themes
const MODES = (modeFilter || ["shopping", "support"]);
const STAMP = (process.env.RUN_DATE || new Date().toISOString().slice(0, 10));

let targets = STORES.filter(s => s.url);
if (storeFilter) targets = targets.filter(s => storeFilter.includes(s.key));
if (vendorFilter) targets = targets.filter(s => vendorFilter.map(x => x.toLowerCase()).includes(s.vendor.toLowerCase()));
if (skipCandidates) targets = targets.filter(s => !s.candidate);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Typing / stall(ack) / no-answer classifiers now live in classify.js (imported above)
// so they can be unit-tested without a browser.

// TRUE end-to-end latency: t0 = the instant the user message is sent; complete_ms
// = the instant the AI's FULL, FINAL reply finished rendering (last text change) − t0.
// We skip the user-message echo, never stop on a "Thinking…" indicator, and never stop on
// an intermediate stall ("let me check…") — the clock runs to the real final answer.
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
    // "still working" = a typing indicator, OR a short stall/ack message that will be
    // followed by the real answer. A long reply (>240 chars) is accepted even if it
    // coincidentally ends acknowledgement-like.
    const shortSoFar = (len - before) < 240;
    const working = isGen(text) || (isAck(text) && shortSoFar);
    const settled = Date.now() - lastChange > STABLE_MS;
    // A settled transcript that's just an offline/reconnecting state or a chip/"leave a
    // message" menu is NOT a real answer — never stop the clock on it (leaves complete_ms
    // null → the conversation's validity gate will drop it as noise).
    const realAnswer = (grownReply || (sawGen && len > before + 40)) && !isNoAnswer(text);
    if (settled && !working && realAnswer) { complete = lastChange - t0; break; }
  }
  return { ttft_ms: ttft, complete_ms: complete, grew: lastLen - before };
}

// NETWORK-timed turn — for closed widgets (Rep AI, Humind) whose DOM is awkward but
// whose assistant reply arrives on a known backend endpoint. t0 = send; complete =
// when the last new reply payload arrived after t0 and then went quiet for STABLE_MS.
// `net.replies` is the live buffer filled by the page 'response' listener.
async function timeTurnNet(page, net, sendFn) {
  const base = net.replies.length;
  const t0 = Date.now();
  await sendFn();
  let lastNew = null, count = base, ttft = null, complete = null;
  const deadline = t0 + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (net.replies.length > count) { const r = net.replies[net.replies.length - 1]; if (r.t >= t0) { lastNew = r.t; if (ttft == null) ttft = lastNew - t0; } count = net.replies.length; }
    // don't settle on a short stall/ack ("let me check…") — wait for the real final answer
    const chunk = net.replies.slice(base);
    const joined = chunk.map(r => r.text).join("  ");
    const working = chunk.length && isAck(chunk[chunk.length - 1].text) && joined.length < 240;
    if (lastNew && !working && Date.now() - lastNew > STABLE_MS) { complete = lastNew - t0; break; }
  }
  return { ttft_ms: ttft, complete_ms: complete, grew: count - base, replyText: net.replies.slice(base).map(r => r.text).join("  ") };
}

async function runStoreMode(browser, store, mode, theme) {
  const w = WIDGETS[store.widget];
  const pool = theme.turns;
  const out = { key: store.key, vendor: store.vendor, store: store.store, url: store.url, us: !!store.us, widget: store.widget, mode, theme: theme.key, themeLabel: theme.label, date: STAMP, capturedAt: new Date().toISOString(), turns: [] };
  // INCOGNITO/COLD: a brand-new Playwright context has zero cookies/localStorage/
  // IndexedDB/cache for ANY origin (the widget's cross-origin storage included),
  // so there is never a pre-existing conversation. storageState is left undefined
  // (no profile) and we clear cookies as belt-and-suspenders.
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: store.locale || "en-US", timezoneId: "America/New_York", userAgent: REAL_UA, extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }, storageState: undefined });
  await context.addInitScript(STEALTH);
  // Spiffy/Envive gates its widget behind an A/B rollout bucket that a cold context re-rolls
  // to "disabled"; this sanctioned flag forces it ON before the session-bucket check.
  if (store.widget === "spiffy") await context.addInitScript(() => { try { localStorage.setItem("spiffy_on", "true"); } catch (e) {} });
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

  // NETWORK-transport widgets (Rep AI, Humind): the assistant's reply text arrives on
  // a backend endpoint, not the DOM. Buffer every parsed reply with its arrival time.
  const net = { replies: [], seen: new Set() };
  if (w.transport === "net" && w.net) {
    page.on("response", async (resp) => {
      try {
        if (!w.net.match.test(resp.url())) return;
        const body = await resp.text();
        const t = Date.now();                 // for streams, text() resolves at stream END
        for (const txt of (w.net.parse(body, resp.url()) || [])) {
          const k = txt.slice(0, 120);
          if (txt && txt.trim() && !net.seen.has(k)) { net.seen.add(k); net.replies.push({ t, text: txt }); }
        }
      } catch {}
    });
  }

  try {
    await page.goto(store.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await w.open(page);
    let handedOver = false;
    const useNet = w.transport === "net" && w.net;
    for (let i = 0; i < pool.length; i++) {
      const q = pool[i];
      // Handed to a human on an earlier turn → STOP talking to the human. We do NOT
      // keep sending scripted shopper messages to a live agent. The remaining turns
      // are recorded as "not sent" (by:human) so the full-journey denominator — and
      // therefore the success rate — is preserved (a bail-out at T3 of 7 stays 2/7,
      // it doesn't get flattered to 2/3).
      if (handedOver) {
        out.turns.push({ turn: i + 1, q, by: "human", ttft_ms: null, complete_ms: null,
          ai_latency_ms: null, handover: false, handover_hit: null, unsent: true,
          replyTail: "(not sent — conversation was handed to a human)" });
        console.log(`  [${store.key}/${mode}/${theme.key}] T${i + 1} (not sent — handed to human)`);
        continue;
      }
      let r, tail;
      if (useNet) {
        try { r = await timeTurnNet(page, net, () => w.send(page, q)); }
        catch (e) { r = { ttft_ms: null, complete_ms: null, error: String(e).slice(0, 120) }; }
        tail = net.replies.slice(-3).map(x => x.text).join("  ").slice(-700);
      } else {
        try { r = await timeTurn(page, w.scope, () => w.send(page, q), q); }
        catch (e) { r = { ttft_ms: null, complete_ms: null, error: String(e).slice(0, 120) }; }
        tail = (await readTranscript(page, w.scope)).text.slice(-700);
      }
      // Pass the store/vendor name so the bot's own brand label ("Tediber says:") isn't
      // misread as a human agent named "Tediber".
      const handover = detectHandover(tail, w.handover, [store.store, store.vendor]);
      if (handover) handedOver = true;
      // Once a human owns the thread, every later turn is human too. We NEVER
      // count a human reply's latency — only the AI's own responses are timed.
      const by = handedOver ? "human" : "ai";
      out.turns.push({ turn: i + 1, q, by, ...r, ai_latency_ms: by === "ai" ? r.complete_ms : null, handover: !!handover, handover_hit: handover, replyTail: tail.slice(-500) });
      console.log(`  [${store.key}/${mode}/${theme.key}] T${i + 1} ${by === "ai" ? (r.complete_ms ?? "—") + "ms" : "(human)"}${handover ? "  ⛔ HANDOVER: " + handover : ""}`);
      await sleep(SETTLE_MS);
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
    console.log(`  [${store.key}/${mode}/${theme.key}] FAILED: ${out.error}`);
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
  // Validity gate: a conversation is a real data point only if it hit a handover (a genuine
  // finding) OR produced enough cleanly-timed answers. Otherwise it's noise (menu/offline/
  // timeout) and must not pollute the report.
  const v = convoValidity(out.turns);
  out.valid = v.valid;
  out.invalid_reason = v.reason;
  out.stats = {
    turns: out.turns.length,
    answered_no_handover: answered,
    success_rate: out.turns.length ? Math.round((answered / out.turns.length) * 100) : null,
    avg_ms: aiValid.length ? Math.round(aiValid.reduce((a, b) => a + b, 0) / aiValid.length) : null,
    min_ms: aiValid.length ? Math.min(...aiValid) : null,
    max_ms: aiValid.length ? Math.max(...aiValid) : null,
    latency_basis: "AI turns only (human replies excluded)",
    handover_turn: firstHandover ? firstHandover.turn : null,
    valid: v.valid, timed_turns: v.timed,
  };
  console.log(`  [${store.key}/${mode}/${theme.key}] ${v.valid ? "VALID" : "INVALID — " + v.reason} (timed ${v.timed}/${v.aiAttempted}${v.hadHandover ? ", handover" : ""})`);
  return out;
}

(async () => {
  let browser;
  const launchOpts = { headless: !HEADED, args: ["--disable-blink-features=AutomationControlled"] };
  try { browser = await chromium.launch({ ...launchOpts, channel: HEADED ? "chrome" : undefined }); }
  catch (e) { browser = await chromium.launch(launchOpts); }
  console.log(HEADED ? "Running HEADED (visible Chrome) — bot-blocked widgets load here." : "Running headless.");
  const CONV_DIR = `results/${STAMP}/conv`;
  await mkdir(CONV_DIR, { recursive: true });   // one file PER CONVERSATION (theme)

  // Build the (store,mode,theme) task list. EACH theme is one independent ~7-turn
  // conversation in its own cold context. RESUME is THEME-level: we skip any
  // conversation already on disk, so a kill loses at most the one in flight —
  // relaunch continues exactly where it stopped. Aggregation happens on READ (gen.js).
  const convFile = (k, mode, theme) => `${CONV_DIR}/${k}-${mode}-${theme}.json`;
  const tasks = [];
  let skipped = 0;
  for (const store of targets) for (const mode of MODES) {
    let themes = mode === "support" ? SUPPORT_THEMES : SHOPPING_THEMES;
    if (THEME_LIMIT) themes = themes.slice(0, THEME_LIMIT);
    for (const theme of themes) {
      // RESUME: skip only if a VALID capture exists. Network/load failures (0 turns) AND
      // noise captures (invalid: menu/offline/timeout with no handover) are re-tried,
      // never treated as done — so a re-run keeps trying to get a clean measurement.
      if (RESUME && existsSync(convFile(store.key, mode, theme.key))) {
        try { const j = JSON.parse(readFileSync(convFile(store.key, mode, theme.key), "utf8")); if (j.turns && j.turns.length > 0 && j.valid !== false) { skipped++; continue; } } catch {}
      }
      tasks.push({ store, mode, theme });
    }
  }
  if (skipped) console.log(`↩︎ RESUME: skipping ${skipped} conversations already on disk.`);
  // INTERLEAVE by vendor so early captures span ALL vendors — under frequent kills the
  // report fills in representatively (every vendor gets some data) instead of one vendor
  // at a time; depth accrues on later passes.
  if (!SERIAL && tasks.length) {
    const byV = {}; for (const t of tasks) (byV[t.store.vendor] = byV[t.store.vendor] || []).push(t);
    const lists = Object.values(byV); const rr = [];
    for (let i = 0; rr.length < tasks.length; i++) for (const l of lists) if (l[i]) rr.push(l[i]);
    tasks.length = 0; tasks.push(...rr);
  }
  if (!tasks.length) { console.log("ALL DONE — every conversation already captured for this run-date."); await browser.close(); return; }
  console.log(`Running ${tasks.length} conversations at concurrency ${CONC}, each in a fresh incognito context.\n`);

  const remaining = tasks.slice();
  const inflight = new Set();
  let done = 0, failed = 0;
  async function worker(wid) {
    while (true) {
      let t;
      if (SERIAL) {
        const idx = remaining.findIndex(x => !inflight.has(x.store.key));
        if (idx < 0) { if (remaining.length === 0) break; await sleep(300); continue; }
        t = remaining.splice(idx, 1)[0]; inflight.add(t.store.key);
      } else { t = remaining.shift(); if (!t) break; }
      try {
        const res = await runStoreMode(browser, t.store, t.mode, t.theme);
        // WRITE THIS CONVERSATION IMMEDIATELY — finest-grained durability.
        await writeFile(convFile(t.store.key, t.mode, t.theme.key), JSON.stringify(res)).catch(e => console.log("write err", e.message));
        done++;
        console.log(`  ✔ [${done}/${tasks.length}] ${t.store.key}/${t.mode}/${t.theme.key} · success ${res.stats.success_rate ?? "n/a"}% · avg ${res.stats.avg_ms ?? "n/a"}ms${res.stats.handover_turn ? `  🚩 handover@T${res.stats.handover_turn}` : ""}`);
      } catch (e) { failed++; console.log(`  ✗ ${t.store.key}/${t.mode}/${t.theme.key} ERR ${String(e).slice(0, 100)}`); }
      finally { if (SERIAL) inflight.delete(t.store.key); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, (_, i) => worker(i + 1)));
  await browser.close();
  console.log(`Done. Wrote ${done} conversations (${failed} failed) to ${CONV_DIR}/`);
})();
