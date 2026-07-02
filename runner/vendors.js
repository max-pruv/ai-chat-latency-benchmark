// Per-STORE harness for the cold headless runner.
//
// We test 2–3 live storefronts per vendor. Stores of the same vendor share a
// widget technology, so harness logic lives in WIDGETS (keyed by widget type)
// and STORES just maps each storefront to a widget + URL.
//
// Playwright can reach into cross-origin iframes (unlike a page script), so for
// iframe widgets we read the reply text straight out of the chat frame; for
// shadow-DOM widgets (Spiffy, Sierra) we read the shadow root.
//
// Each widget exposes:
//   scope          {kind:'frame', match} | {kind:'shadow', match} | {kind:'shadowId', sel}
//   open(page)     open the chat widget (+ dismiss modals / prechat)
//   send(page,txt) post a user message
//   handover       extra handover regexes specific to this widget (optional)

const DUMMY = { name: "Benchmark Test", email: "benchmark.test@example.com" }; // reserved example.com — never a real inbox

async function dismiss(page) {
  for (const sel of [
    'button:has-text("Reject")', 'button:has-text("Decline")', 'button:has-text("No thanks")',
    'button:has-text("Refuser")', 'button:has-text("Tout refuser")', 'button:has-text("Continuer sans accepter")',
    'button:has-text("Accept")', '[aria-label="Close"]', 'button:has-text("Close")',
  ]) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 400 })) await b.click({ timeout: 600 }); } catch {}
  }
}

// Drive a composer that lives inside an OPEN shadow root (headed Chrome). Pierces
// nested shadow roots under `hostSel`, finds the first text input, types, hits Enter.
async function shadowSend(page, hostSel, text) {
  const handle = await page.evaluateHandle((sel) => {
    const host = document.querySelector(sel) || document.getElementsByTagName(sel)[0];
    if (!host) return null;
    let inp = null;
    const walk = (n) => {
      if (!n || inp) return;
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const k of (n.children || [])) walk(k);
      if (!inp && n.nodeType === 1 && (n.tagName === "TEXTAREA" || (n.tagName === "INPUT" && /text|search/i.test(n.type || "text")) || n.getAttribute?.("contenteditable") === "true")) inp = n;
    };
    walk(host); return inp;
  }, hostSel);
  const el = handle.asElement(); if (!el) return false;
  await el.click({ timeout: 4000 }).catch(() => {});
  let ok = false; try { await el.fill(text); ok = true; } catch {}
  if (!ok) { try { await el.type(text, { delay: 10 }); } catch {} }
  await page.keyboard.press("Enter");
  return true;
}

// Click the first button/launcher inside an open shadow host (headed Chrome).
async function shadowClickLauncher(page, hostSel) {
  await page.evaluate((sel) => {
    const host = document.querySelector(sel) || document.getElementsByTagName(sel)[0];
    if (!host) return;
    let btn = null;
    const walk = (n) => {
      if (!n || btn) return;
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const k of (n.children || [])) walk(k);
      if (!btn && n.nodeType === 1 && (n.tagName === "BUTTON" || n.getAttribute?.("role") === "button")) btn = n;
    };
    walk(host); btn && btn.click();
  }, hostSel).catch(() => {});
}

// Some chats gate behind an email prechat form. Fill a dummy (reserved
// example.com) address and submit so the conversation can start.
async function fillEmailGate(page, frame) {
  try {
    const email = frame.locator('input[type="email"], input[placeholder*="@"], input[placeholder*="mail" i], input[name*="mail" i], input[aria-label*="mail" i]').first();
    if (!(await email.count().catch(() => 0))) return false;
    if (!(await email.isVisible().catch(() => false))) return false;
    await email.click({ timeout: 3000 }).catch(() => {});
    await email.fill(DUMMY.email).catch(async () => { await email.type(DUMMY.email).catch(() => {}); });
    const btn = frame.locator('button:has-text("Start"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Chat"), button:has-text("Send"), button[type="submit"]').first();
    if (await btn.count().catch(() => 0)) await btn.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Widget harnesses
// ---------------------------------------------------------------------------
export const WIDGETS = {
  // Gorgias Chat — same-origin chat-window iframe; programmatic open + sendMessage.
  gorgias: {
    scope: { kind: "frame", match: "chat-window" },
    handover: [/joined the chat/i, /a rejoint (la )?(conversation|discussion|chat)/i,
               /conseiller humain/i, /transf[eè]re(r|z)?\b.*(humain|conseiller|agent|ticket)/i, /laissez(\-| )?(nous|moi)?\s*(votre)?\s*(e-?mail|adresse)/i],
    async open(page) {
      await dismiss(page);
      // widget bundle loads a couple seconds after a real-UA 'load'; wait for it
      await page.waitForFunction(() => typeof window.GorgiasChat !== "undefined", null, { timeout: 30000 }).catch(() => {});
      await page.evaluate(async () => {
        const isOpen = () => { try { return !!window.GorgiasChat.isOpen(); } catch (e) { return false; } };
        for (let i = 0; i < 14 && !isOpen(); i++) { try { window.GorgiasChat.open(); } catch (e) {} await new Promise(r => setTimeout(r, 900)); }
      });
      await page.waitForTimeout(3500);
      // If the conversation window didn't open, click the launcher button.
      if (!(await findFrame(page, "chat-window"))) {
        const fb = await findFrame(page, "chat-button");
        if (fb) { try { await fb.locator('button, [role="button"], div').first().click({ timeout: 3000 }); } catch (e) {} }
        await page.evaluate(() => { try { document.querySelector('#chat-button, [aria-label*="chat" i]')?.click?.(); } catch (e) {} });
        await page.waitForTimeout(3500);
      }
      const f = await findFrame(page, "chat-window");
      if (f) await fillEmailGate(page, f);   // dummy email if the chat gates on one
    },
    async send(page, text) {
      // The message box is the "Ask anything" textarea INSIDE the chat-window
      // iframe; typing + Enter posts (GorgiasChat.sendMessage no-ops on the home
      // screen in a cold context). Avoid the email-capture input if present.
      const f = await findFrame(page, "chat-window");
      if (!f) { try { await page.evaluate(t => window.GorgiasChat.sendMessage(t), text); } catch (e) {} return; }
      let inp = f.locator('textarea').first();
      if (!(await inp.count().catch(() => 0))) inp = f.locator('[contenteditable="true"], input[type="text"], input:not([type="email"])').first();
      await inp.click({ timeout: 5000 }).catch(() => {});
      await inp.fill(text).catch(async () => { await inp.type(text).catch(() => {}); });
      await page.keyboard.press("Enter");
    },
  },

  // Spiffy.ai — shadow-DOM modal (#spiffy-modal-container). Open via a PDP
  // suggestion chip / floating button; send via the modal's input + Send button.
  spiffy: {
    scope: { kind: "shadowId", sel: "#spiffy-modal-container" },
    handover: [/customer care team/i, /human (agent|representative)/i, /connect you (with|to)/i],
    async open(page) {
      // Requires: STEALTH's real chrome.runtime stub + localStorage spiffy_on=true (set in
      // run.js) — else Spiffy's init throws / the A/B gate leaves it unmounted in a cold
      // context. Poll for the auto-mounted composer; if the app mounted but the modal is
      // closed, click the launcher inside the floating-button/container shadow (never a chip).
      await page.waitForTimeout(2000); await dismiss(page);
      for (let i = 0; i < 25; i++) {
        const st = await page.evaluate(() => {
          const modal = document.querySelector('#spiffy-modal-container');
          const composer = modal?.shadowRoot?.querySelector('[data-testid="spiffy-chat-reply-input"], input[placeholder*="Ask" i]');
          return { composer: !!composer, container: !!document.querySelector('#spiffy-ai-container'), fbtn: !!document.querySelector('#spiffy-ai-floating-button') };
        });
        if (st.composer) break;
        if (st.fbtn || st.container) await page.evaluate(() => {
          const host = document.querySelector('#spiffy-ai-floating-button') || document.querySelector('#spiffy-ai-container');
          const r = host && (host.shadowRoot || host); const btn = r && r.querySelector('button,[role=button]'); btn && btn.click();
        }).catch(() => {});
        await page.waitForTimeout(800);
      }
      await page.waitForTimeout(1000);
    },
    async send(page, text) {
      await page.evaluate((t) => {
        const sr = document.querySelector('#spiffy-modal-container')?.shadowRoot; if (!sr) return;
        const inp = sr.querySelector('[data-testid="spiffy-chat-reply-input"]') || sr.querySelector('input[placeholder*="Ask" i]') || sr.querySelector('input[type="text"]'); if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        inp.focus(); setter.call(inp, t); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
          const btn = sr.querySelector('[data-testid="spiffy-chat-reply-input-send-button"]') || [...sr.querySelectorAll('button')].find(b => /send message|send/i.test(b.getAttribute('aria-label') || ''));
          if (btn && !btn.disabled) btn.click(); else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }, 150);
      }, text);
    },
  },

  // Sierra — shadow-DOM widget, SSE streaming. HEADED-ONLY (headless echoes the user but
  // the backend returns NO assistant reply — bot wall). Two SDK builds: hosted embed
  // (Casper) window.openSierraChat() + <textarea aria-label="Add new message">; self-hosted
  // (BARK) window.sierra.openChatModal() + contenteditable [aria-label="Message Input"].
  // scope.match = the composer selector; the shared reader finds the shadow root by it.
  sierra: {
    scope: { kind: "shadow", match: 'textarea[aria-label*="message" i], [contenteditable][aria-label*="message" i], [role="textbox"][aria-label*="message" i]' },
    handover: [/recorded by .* service provider/i],
    async open(page) {
      await page.waitForTimeout(3500); await dismiss(page);
      await page.evaluate(() => { const hit = (root) => { for (const b of (root.querySelectorAll ? root.querySelectorAll('button,[role="button"]') : [])) { const t = (b.getAttribute("aria-label") || b.textContent || "").trim(); if (/^(accept all|accept|reject all|i agree|got it|ok)$/i.test(t)) { try { b.click(); return true; } catch (e) {} } } return false; }; const walk = (n) => { if (hit(n)) return true; for (const el of (n.querySelectorAll ? n.querySelectorAll("*") : [])) if (el.shadowRoot && walk(el.shadowRoot)) return true; return false; }; walk(document); }).catch(() => {});
      await page.waitForTimeout(800);
      const composerSel = WIDGETS.sierra.scope.match;
      const has = () => page.evaluate((sel) => !!(window.__sierraRoot && window.__sierraRoot(sel)), composerSel);
      const panelOpen = () => page.evaluate(() => { let open = false; const walk = (n) => { if (open) return; for (const el of (n.querySelectorAll ? n.querySelectorAll("*") : [])) if (el.shadowRoot) { if (/chat (sessions? )?(are|is) recorded|record your chat|virtual agent|i'?m .{0,20}(ai|assistant)/i.test(el.shadowRoot.textContent || "")) { open = true; return; } walk(el.shadowRoot); } }; walk(document); return open; });
      for (let i = 0; i < 14; i++) {
        if (await has()) break;
        if (!(await panelOpen())) {
          await page.evaluate(() => { try { if (typeof window.openSierraChat === "function") window.openSierraChat(); } catch (e) {} try { if (window.sierra && typeof window.sierra.openChatModal === "function") window.sierra.openChatModal(); } catch (e) {} }).catch(() => {});
          if (!(await panelOpen())) { for (const sel of ["#sierra-chat-button", "#sierra-chat-launcher"]) { try { const l = page.locator(sel).first(); if (await l.count()) { await l.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {}); await l.click({ timeout: 2500, force: true }); break; } } catch {} } }
        }
        await page.waitForTimeout(1600);
      }
      await page.waitForTimeout(2000);
    },
    async send(page, text) {
      const composerSel = WIDGETS.sierra.scope.match;
      const handle = await page.evaluateHandle((sel) => { const r = window.__sierraRoot && window.__sierraRoot(sel); return r ? r.querySelector(sel) : null; }, composerSel);
      const el = handle.asElement(); if (!el) return;
      await el.click({ timeout: 4000 }).catch(() => {});
      const isTextarea = await el.evaluate(n => n.tagName === "TEXTAREA").catch(() => false);
      if (isTextarea) { await el.evaluate((n, t) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; setter.call(n, t); n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); }, text).catch(() => {}); }
      else { await el.evaluate(n => { n.focus(); n.textContent = ""; }).catch(() => {}); await page.keyboard.type(text, { delay: 8 }).catch(() => {}); await el.evaluate(n => n.dispatchEvent(new Event("input", { bubbles: true }))).catch(() => {}); }
      await page.waitForTimeout(300);
      const clicked = await page.evaluate((sel) => { const r = window.__sierraRoot && window.__sierraRoot(sel); if (!r) return false; const btn = [...r.querySelectorAll('button,[role="button"]')].find(b => /send\s*message|^send$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim())); if (btn && !btn.disabled) { btn.click(); return true; } return false; }, composerSel);
      if (!clicked) await el.press("Enter").catch(async () => { await page.keyboard.press("Enter").catch(() => {}); });
    },
  },

  // Siena — iframe (chat.siena.cx). Loader fires on window 'load' (can miss under
  // automation) → force it; launcher is the #SIENA_CHAT_IFRAME bubble (must click);
  // pre-chat gate = name+email OR email-only. NEVER a quick-reply chip. (HEADED path.)
  siena: {
    scope: { kind: "frame", match: "siena.cx" },
    async open(page) {
      await page.waitForTimeout(1500); await dismiss(page);
      const sframe = () => page.frames().find(fr => fr.url().includes("siena.cx"));
      const hasIframe = async () => page.evaluate(() => !!document.querySelector('#SIENA_CHAT_IFRAME, iframe[src*="siena.cx" i]')).catch(() => false);
      for (let i = 0; i < 6 && !(await hasIframe()); i++) { if (i === 2) await page.evaluate(() => { try { window.dispatchEvent(new Event("load")); } catch (e) {} }).catch(() => {}); await page.waitForTimeout(1000); }
      if (!(await hasIframe())) {
        const loaderUrl = await page.evaluate(() => { const m = document.documentElement.innerHTML.match(/https?:\/\/chat\.siena\.cx\/dist\/webchat\.js[^"'\s]*/); return m ? m[0] : null; }).catch(() => null);
        if (loaderUrl) await page.evaluate((src) => { const s = document.createElement("script"); s.async = true; s.src = src; document.body.appendChild(s); }, loaderUrl).catch(() => {});
      }
      for (let i = 0; i < 20 && !sframe(); i++) await page.waitForTimeout(800);
      await page.evaluate(() => { try { window.SienaLaunchChat && window.SienaLaunchChat(); } catch (e) {} }).catch(() => {});
      await page.waitForTimeout(800);
      for (let i = 0; i < 6; i++) {
        const f = sframe();
        if (f) { const ready = await f.evaluate(() => !!document.querySelector('textarea,[contenteditable="true"]') || /enter your name|start the chat|start chat/i.test(document.body.innerText || "")).catch(() => false); if (ready) break; }
        await page.locator('#SIENA_CHAT_IFRAME, iframe[src*="siena.cx" i]').first().click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      const f = sframe();
      if (f) {
        const composerReady = () => f.evaluate(() => !!document.querySelector('textarea,[contenteditable="true"]')).catch(() => false);
        for (let attempt = 0; attempt < 4 && !(await composerReady()); attempt++) {
          const nameI = f.locator('input[placeholder*="name" i], input[aria-label*="name" i]').first();
          if (await nameI.count().catch(() => 0)) { await nameI.click({ timeout: 2000 }).catch(() => {}); await nameI.fill(DUMMY.name).catch(() => {}); }
          const mailI = f.locator('input[type="email"], input[placeholder*="@" i], input[placeholder*="mail" i], input[aria-label*="mail" i]').first();
          if (await mailI.count().catch(() => 0)) { await mailI.click({ timeout: 2000 }).catch(() => {}); await mailI.fill(DUMMY.email).catch(async () => { await mailI.type(DUMMY.email, { delay: 15 }).catch(() => {}); }); }
          const startBtn = f.locator('button:has-text("Start chat"), button:has-text("Start"), button:has-text("Continue")').first();
          if (await startBtn.count().catch(() => 0)) await startBtn.click({ timeout: 3000 }).catch(() => {});
          else { const skip = f.locator('button:has-text("Skip for now"), button:has-text("Skip")').first(); if (await skip.count().catch(() => 0)) await skip.click({ timeout: 3000 }).catch(() => {}); else await page.keyboard.press("Enter").catch(() => {}); }
          for (let i = 0; i < 8 && !(await composerReady()); i++) await page.waitForTimeout(700);
        }
      }
    },
    async send(page, text) {
      const f = page.frames().find(fr => fr.url().includes("siena.cx")); if (!f) return;
      let inp = f.locator('textarea').first();
      if (!(await inp.count().catch(() => 0))) inp = f.locator('[contenteditable="true"], input[type="text"]:not([placeholder*="name" i])').first();
      await inp.click({ timeout: 5000 }).catch(() => {});
      await inp.fill(text).catch(async () => { await inp.type(text, { delay: 8 }).catch(() => {}); });
      await page.keyboard.press("Enter");
    },
  },

  // DigitalGenius — Sunshine Conversations iframe, gated by a prechat lead form.
  // DigitalGenius — DG bundle loads late; launchWidget() only mounts the launcher bubble
  // (dg-chat-widget-launcher-iframe); the conversation panel (dg-chat-widget-iframe) mounts
  // only after that bubble is clicked. Some stores gate on a name+email pre-chat form
  // (Bloom & Wild); others go straight to the composer (G-Star). Composer mounts only after
  // the greeting renders. HEADED-ONLY (headless stalls at "Bot is typing").
  dg: {
    scope: { kind: "frame", match: "dg-chat-widget-iframe" },
    handover: [/connect you (with|to) (one of )?(our|an?) (agent|team|advisor|colleague)/i, /transfer(ring)? you (to|over)/i, /someone available to help/i, /a member of our team/i, /reply to you via email/i, /in the queue/i],
    async open(page) {
      await page.waitForTimeout(3000); await dismiss(page);
      await page.waitForFunction(() => !!(window.dgchat && window.dgchat.methods && window.dgchat.methods.launchWidget), null, { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => { try { window.dgchat.methods.launchWidget(); } catch (e) {} }).catch(() => {});
      let launcher = null;
      for (let i = 0; i < 40 && !launcher; i++) { launcher = await findFrame(page, "dg-chat-widget-launcher-iframe"); if (!launcher) await page.waitForTimeout(500); }
      if (launcher) { const btn = launcher.locator('button.dg-chat-launcher, button[aria-label*="open chat" i], button[aria-label*="chat" i], button').first(); await btn.click({ timeout: 6000 }).catch(() => {}); }
      let wf = null;
      for (let i = 0; i < 40 && !wf; i++) { wf = await findFrame(page, "dg-chat-widget-iframe"); if (!wf) await page.waitForTimeout(500); }
      if (!wf) return;
      await page.waitForTimeout(1000);
      const nameI = wf.locator('input[placeholder*="name" i], input[name="name"], input[aria-label*="name" i]').first();
      const mailI = wf.locator('input[type="email"], input[placeholder*="email" i], input[name*="email" i], input[aria-label*="email" i]').first();
      if (await nameI.count().catch(() => 0)) { await nameI.click({ timeout: 3000 }).catch(() => {}); await nameI.fill(DUMMY.name).catch(async () => { await nameI.type(DUMMY.name, { delay: 15 }).catch(() => {}); }); }
      if (await mailI.count().catch(() => 0)) { await mailI.click({ timeout: 3000 }).catch(() => {}); await mailI.fill(DUMMY.email).catch(async () => { await mailI.type(DUMMY.email, { delay: 15 }).catch(() => {}); }); }
      const start = wf.locator('button:has-text("Start Chat"), button:has-text("Start chat"), button[type="submit"]').first();
      if (await start.count().catch(() => 0)) await start.click({ timeout: 6000 }).catch(() => {});
      const composer = wf.locator('textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="type" i], [contenteditable="true"]').first();
      await composer.waitFor({ state: "visible", timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(1000);
    },
    async send(page, text) {
      const f = await findFrame(page, "dg-chat-widget-iframe"); if (!f) return;
      let inp = f.locator('textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="type" i], textarea').first();
      if (!(await inp.count().catch(() => 0))) inp = f.locator('[contenteditable="true"], input[type="text"]:not([placeholder*="name" i]):not([placeholder*="email" i])').first();
      await inp.click({ timeout: 5000 }).catch(() => {});
      await inp.fill(text).catch(async () => { await inp.type(text, { delay: 12 }).catch(() => {}); });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      try { const still = await inp.inputValue().catch(() => ""); if (still && still.trim()) { const b = f.locator('button[aria-label*="send" i], button[title*="send" i], button[type="submit"]').first(); if (await b.count()) await b.click({ timeout: 2500 }).catch(() => {}); } } catch {}
    },
  },

  // Zendesk messaging Virtual Assistant ("Meta AI" front-end).
  zendesk: {
    scope: { kind: "frame", match: "Messaging window" },
    async open(page) { await page.waitForTimeout(4000); await dismiss(page); await page.evaluate(() => { try { window.zE && window.zE("messenger", "open"); } catch (e) {} }); await page.waitForTimeout(4000); },
    async send(page, text) {
      const f = await findFrame(page, "Messaging window"); if (!f) return;
      const input = f.getByPlaceholder(/type a message|message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },

  // Ada — static.ada.support iframe.
  ada: {
    // Ada injects 3 iframes; the CONVERSATION is #ada-chat-frame (the loose "ada" match
    // hit the empty ada-x-storage-frame → empty read). Target the chat frame by id.
    scope: { kind: "frame", match: "ada-chat-frame" },
    async open(page) {
      await dismiss(page);
      await page.waitForFunction(() => typeof window.adaEmbed !== "undefined", null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.evaluate(async () => { try { if (window.adaEmbed?.toggle) await window.adaEmbed.toggle(); else if (window.adaEmbed?.open) await window.adaEmbed.open(); } catch (e) {} }).catch(() => {});
      await page.waitForFunction(() => !!document.querySelector("#ada-chat-frame"), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);
      if (!(await findFrame(page, "ada-chat-frame"))) {   // fallback: click the launcher INSIDE the button frame (never a chip)
        const bf = page.frames().find(fr => /ada-button-frame/.test(fr.name() || "") || /ada\.support\/embed\/button/i.test(fr.url() || ""));
        if (bf) { try { const b = bf.locator('button, [role="button"]').first(); if (await b.count()) await b.click({ timeout: 2500 }).catch(() => {}); } catch {} await page.waitForFunction(() => !!document.querySelector("#ada-chat-frame"), null, { timeout: 12000 }).catch(() => {}); }
      }
      try { await page.frameLocator("#ada-chat-frame").locator('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]').first().waitFor({ state: "attached", timeout: 20000 }); } catch {}
      await page.waitForTimeout(1200);
    },
    async send(page, text) {
      if (!(await page.waitForSelector("#ada-chat-frame", { timeout: 8000 }).then(() => true).catch(() => false))) return;
      const fl = page.frameLocator("#ada-chat-frame");   // stable id → survives Ada's post-message frame navigation
      const cand = ['textarea[placeholder*="message" i]', 'textarea[placeholder*="ask" i]', 'textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'];
      let inp = null; const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !inp) { for (const sel of cand) { const loc = fl.locator(sel).first(); if (await loc.count().catch(() => 0)) { inp = loc; break; } } if (!inp) await page.waitForTimeout(500); }
      if (!inp) return;
      await inp.click({ timeout: 5000 }).catch(() => {});
      await inp.fill(text).catch(async () => { await inp.type(text, { delay: 15 }).catch(() => {}); });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      try { const still = await inp.inputValue().catch(() => ""); if (still && still.trim()) { const b = fl.locator('button[aria-label*="send" i], button[type="submit"], button:has-text("Send")').first(); if (await b.count()) await b.click({ timeout: 2000 }).catch(() => {}); } } catch {}
    },
  },

  // ---- NEW vendor harnesses (best-effort scaffolds; verify per widget) ----
  // Rep AI — loads via initRep(); widget usually in a rep.ai / hellorep iframe.
  // Rep AI — HEADED only. In real Chrome the #ads-agent-host shadow is reachable, so we
  // drive the composer there; the assistant REPLY is read at the network layer
  // (server.myrepai.com/web/events carries it in sm[].t). transport:"net".
  repai: {
    transport: "net",
    scope: { kind: "shadowId", sel: "#ads-agent-host" },
    net: {
      match: /server\.myrepai\.com\/web\/events/i,
      parse(body) {
        const out = [];
        try {
          const arr = JSON.parse(body);
          for (const el of (Array.isArray(arr) ? arr : [arr])) {
            const sm = el && el.sm;
            if (Array.isArray(sm)) for (const m of sm) { const t = typeof m === "string" ? m : (m && (m.t || m.text || m.message)); if (typeof t === "string" && t.trim()) out.push(t.trim()); }
          }
        } catch {}
        return out;
      },
    },
    async open(page) {
      await page.waitForTimeout(4000); await dismiss(page);
      await page.evaluate(() => { try { window.initRep && window.initRep(); } catch (e) {} }).catch(() => {});
      await page.waitForTimeout(1500);
      await shadowClickLauncher(page, "#ads-agent-host");
      await page.waitForTimeout(4000);
    },
    async send(page, text) { await shadowSend(page, "#ads-agent-host", text); },
  },
  // Kodif — kodif-chat-widget iframe.
  kodif: {
    scope: { kind: "frame", match: "kodif" },
    async open(page) {
      await page.waitForTimeout(4000); await dismiss(page);
      await page.evaluate(() => document.querySelector('#kodif-chat-widget, [id*="kodif" i], [class*="kodif" i]')?.click?.());
      const f = await findFrame(page, "kodif");
      if (f) { try { await f.locator('button, [role="button"]').first().click({ timeout: 2500 }); } catch (e) {} }
      await page.waitForTimeout(3500);
    },
    async send(page, text) {
      const f = await findFrame(page, "kodif"); if (!f) return;
      const i = f.locator('textarea, input[type="text"], [contenteditable="true"]').first();
      await i.click({ timeout: 5000 }).catch(() => {}); await i.fill(text).catch(async () => { await i.type(text).catch(() => {}); });
      await page.keyboard.press("Enter");
    },
  },
  // Humind — boostWidgetIntegration (FR). Widget tech TBD; best-effort.
  // Humind — HEADED only. Renders in an OPEN shadow on a <humind-gift-finder> custom
  // element; the assistant REPLY streams from api.thehumind.com/chat-service/chat/stream.
  // transport:"net" (timing = stream completion; text reconstructed from SSE data lines).
  humind: {
    transport: "net",
    scope: { kind: "shadowId", sel: "humind-gift-finder" },
    net: {
      match: /api\.thehumind\.com\/chat-service\/chat\/stream/i,
      parse(body) {
        const texts = [];
        for (const ln of String(body).split(/\r?\n/)) {
          const m = ln.match(/^data:\s*(.+)$/); if (!m) continue;
          const raw = m[1].trim(); if (!raw || raw === "[DONE]") continue;
          try { const j = JSON.parse(raw); const t = j.text ?? j.content ?? j.delta ?? j.message ?? (j.choices && j.choices[0] && (j.choices[0].delta?.content ?? j.choices[0].text)); if (typeof t === "string" && t) texts.push(t); }
          catch { texts.push(raw); }
        }
        const joined = texts.join("");
        return joined.trim() ? [joined.trim()] : [];
      },
    },
    async open(page) {
      await page.waitForTimeout(4000); await dismiss(page);
      await page.evaluate(() => (document.querySelector("humind-gift-finder, [class*='humind' i], [aria-label*='chat' i]"))?.click?.()).catch(() => {});
      await shadowClickLauncher(page, "humind-gift-finder");
      await page.waitForTimeout(4000);
    },
    async send(page, text) { await shadowSend(page, "humind-gift-finder", text); },
  },
};

// ---------------------------------------------------------------------------
// Stores under test — 2–3 per vendor. `candidate:true` = needs verification that
// the widget is live/drivable; the runner attempts it and records an error if not.
// ---------------------------------------------------------------------------
export const STORES = [
  // Gorgias (us) — Glamnetic intentionally excluded
  { key: "gorgias-madura",   vendor: "Gorgias", store: "Madura",        url: "https://www.madura.com/en",            widget: "gorgias", us: true, locale: "en-US" },
  { key: "gorgias-jade",     vendor: "Gorgias", store: "Jade",          url: "https://shop.jadeofficial.com/",       widget: "gorgias", us: true },
  { key: "gorgias-jshealth", vendor: "Gorgias", store: "JSHealth Vitamins", url: "https://us.jshealthvitamins.com/", widget: "gorgias", us: true },
  { key: "gorgias-beekman",  vendor: "Gorgias", store: "Beekman 1802",  url: "https://beekman1802.com/",             widget: "gorgias", us: true },
  { key: "gorgias-babybee",  vendor: "Gorgias", store: "Baby Bee",      url: "https://babybeeonline.com/",           widget: "gorgias", us: true },
  { key: "gorgias-shoebacca", vendor: "Gorgias", store: "Shoebacca",    url: "https://www.shoebacca.com/",           widget: "gorgias", us: true },

  // Spiffy.ai
  { key: "spiffy-supergoop", vendor: "Envive", store: "Supergoop",  url: "https://supergoop.com/products/everyday-sunscreen?variant=31189086634082", widget: "spiffy" },
  { key: "spiffy-2",         vendor: "Spiffy.ai", store: "(2nd store)", url: "",                                widget: "spiffy", candidate: true, todo: "find a 2nd Spiffy.ai storefront" },

  // Sierra
  { key: "sierra-casper",   vendor: "Sierra", store: "Casper",         url: "https://casper.com/",              widget: "sierra" },
  { key: "sierra-sonos",    vendor: "Sierra", store: "Sonos",          url: "https://www.sonos.com/",           widget: "sierra", candidate: true },
  { key: "sierra-chubbies", vendor: "Sierra", store: "Chubbies",       url: "https://www.chubbiesshorts.com/", widget: "sierra", candidate: true },

  // Siena
  { key: "siena-simplemodern", vendor: "Siena", store: "Simple Modern", url: "https://www.simplemodern.com/products/mesa-loop-30oz-49", widget: "siena" },
  { key: "siena-figs",         vendor: "Siena", store: "FIGS",          url: "https://www.wearfigs.com/pages/men-home", widget: "siena" },
  { key: "siena-jonesroad",    vendor: "Siena", store: "Jones Road",    url: "https://www.jonesroadbeauty.com/", widget: "siena", candidate: true },

  // Yuma (runs behind a helpdesk; 2nd drivable store TBD)
  { key: "yuma-evryjewels", vendor: "Yuma", store: "EvryJewels",       url: "https://evryjewels.com/",          widget: "gorgias" },
  { key: "yuma-2",          vendor: "Yuma", store: "(2nd store)",      url: "",                                 widget: "gorgias", candidate: true, todo: "find a 2nd Yuma storefront with a drivable widget" },

  // DigitalGenius
  { key: "dg-bloomwild", vendor: "DigitalGenius", store: "Bloom & Wild", url: "https://www.bloomandwild.com/",  widget: "dg", candidate: true },
  { key: "dg-gstar",     vendor: "DigitalGenius", store: "G-Star RAW",   url: "https://www.g-star.com/en_us",    widget: "dg", candidate: true },
  // on.com — NOT DigitalGenius on-site (verified 2026-07-01); removed from DG list.

  // Meta AI (front-end = Zendesk Virtual Assistant)
  { key: "meta-dermalogica", vendor: "Meta AI", store: "Dermalogica",   url: "https://www.dermalogica.com/",    widget: "zendesk" },
  { key: "meta-2",           vendor: "Meta AI", store: "(2nd store)",   url: "",                                widget: "zendesk", candidate: true, todo: "find a 2nd Meta/Zendesk AI storefront" },

  // Ada
  { key: "ada-loop", vendor: "Ada", store: "Loop Earplugs",            url: "https://www.loopearplugs.com/",    widget: "ada" },
  { key: "ada-2",    vendor: "Ada", store: "(2nd store)",             url: "",                                 widget: "ada", candidate: true, todo: "find a 2nd Ada retail storefront" },

  // ---- Added on request (refresh). Detected chat tech in comments. ----
  { key: "sierra-scotts",  vendor: "Sierra",  store: "Scotts Miracle-Gro", url: "https://scottsmiraclegro.com/", widget: "sierra" },
  { key: "yuma-tediber",   vendor: "Yuma",    store: "Tediber",            url: "https://www.tediber.com/",      widget: "gorgias", locale: "fr-FR" }, // Yuma runs behind Gorgias Chat
  { key: "envive-kut",     vendor: "Envive",  store: "Kut from the Kloth", url: "https://www.kutfromthekloth.com/", widget: "gorgias" }, // chat shell is Gorgias
  { key: "repai-fresh",    vendor: "Rep AI",  store: "Fresh Roasted Coffee", url: "https://www.freshroastedcoffee.com/", widget: "repai", candidate: true },
  { key: "kodif-dsc",      vendor: "Kodif",   store: "Dollar Shave Club",  url: "https://us.dollarshaveclub.com/", widget: "kodif", candidate: true },
  { key: "humind-chaiselongue", vendor: "Humind", store: "La Chaise Longue", url: "https://www.lachaiselongue.fr/", widget: "humind", candidate: true, locale: "fr-FR" },
  // Nordstrom — Google Agentic: SKIPPED (redirects to siteclosed.nordstrom.com; not accessible to us).

  // ===== Expanded verified storefronts (2026-07-01 sourcing campaign) =====
  // Spiffy = Envive (same company; on-site shopping assistant). widget=spiffy.
  { key: "envive-bandolier",  vendor: "Envive", store: "Bandolier",   url: "https://bandolierstyle.com/", widget: "spiffy" },
  { key: "envive-tushbaby",   vendor: "Envive", store: "Tushbaby",    url: "https://tushbaby.com/",       widget: "spiffy" },
  { key: "envive-greenpan",   vendor: "Envive", store: "GreenPan",    url: "https://www.greenpan.us/",    widget: "spiffy" },
  { key: "envive-fracture",   vendor: "Envive", store: "Fracture",    url: "https://fracture.me/",        widget: "spiffy" },
  { key: "envive-nanit",      vendor: "Envive", store: "Nanit",       url: "https://nanit.com/",          widget: "spiffy" },
  // Sierra (widget loads from sierra.chat; sierraConfig global)
  { key: "sierra-bark",       vendor: "Sierra", store: "BARK",        url: "https://bark.co/",            widget: "sierra" },
  { key: "sierra-sunandski",  vendor: "Sierra", store: "Sun & Ski",   url: "https://www.sunandski.com/",  widget: "sierra" },
  { key: "sierra-madisonreed",vendor: "Sierra", store: "Madison Reed",url: "https://www.madison-reed.com/", widget: "sierra" },
  // Siena (chat.siena.cx webchat)
  { key: "siena-mudwtr",      vendor: "Siena",  store: "MUD\\WTR",    url: "https://mudwtr.com/",         widget: "siena" },
  { key: "siena-spanx",       vendor: "Siena",  store: "Spanx",       url: "https://spanx.com/",          widget: "siena" },
  // Yuma (runs behind Gorgias helpdesk → drive the Gorgias widget)
  { key: "yuma-goclove",      vendor: "Yuma",   store: "Clove",       url: "https://www.goclove.com/",    widget: "gorgias" },
  { key: "yuma-javvy",        vendor: "Yuma",   store: "Javvy Coffee",url: "https://www.javvycoffee.com/",widget: "gorgias" },
  // Zendesk AI ("Meta AI")
  { key: "meta-cottonon",     vendor: "Meta AI",store: "Cotton On",   url: "https://cottonon.com/US/",    widget: "zendesk" },
  { key: "meta-quip",         vendor: "Meta AI",store: "quip",        url: "https://www.getquip.com/",    widget: "zendesk" },
  { key: "meta-grove",        vendor: "Meta AI",store: "Grove",       url: "https://www.grove.co/",       widget: "zendesk" },
  // Ada (often loads on the help/support page, not the homepage)
  { key: "ada-endy",          vendor: "Ada",    store: "Endy",        url: "https://www.endy.com/",       widget: "ada" },
  { key: "ada-ipsy",          vendor: "Ada",    store: "IPSY",        url: "https://help.ipsy.com/",      widget: "ada" },
  { key: "ada-yeti",          vendor: "Ada",    store: "YETI",        url: "https://www.yeti.com/",       widget: "ada" },
  { key: "ada-indigo",        vendor: "Ada",    store: "Indigo",      url: "https://www.indigo.ca/",      widget: "ada" },
  // top-ups to reach ≥5 sourced sites/vendor (most DG widgets lazy-load → may need headed)
  // Snipes / Beauty Pie — no DigitalGenius on-site widget (verified); DG on-site footprint = Bloom & Wild + G-Star only.
  { key: "meta-motelrocks",   vendor: "Meta AI", store: "Motel Rocks", url: "https://www.motelrocks.com/", widget: "zendesk" },
  { key: "yuma-cabaia",       vendor: "Yuma",   store: "CABAIA",      url: "https://cabaia.com/",         widget: "zendesk" },

  // Headed-only vendors (widget loads only in real Chrome). candidate=excluded from headless runs.
  { key: "humind-900care",    vendor: "Humind", store: "900.care",    url: "https://www.900.care/",       widget: "humind", candidate: true, locale: "fr-FR" },
  { key: "humind-puressentiel",vendor:"Humind", store: "Puressentiel",url: "https://fr.puressentiel.com/",widget: "humind", candidate: true, locale: "fr-FR" },
  { key: "humind-yumi",       vendor: "Humind", store: "Yumi",        url: "https://www.yumi.fr/",        widget: "humind", candidate: true, locale: "fr-FR" },
  { key: "humind-stormrock",  vendor: "Humind", store: "Stormrock",   url: "https://stormrock.fr/",       widget: "humind", candidate: true, locale: "fr-FR" },
  // Rep AI — headed-only (concierge injects ~12-15s after load). candidate=excluded from headless runs.
  { key: "repai-olly",        vendor: "Rep AI", store: "OLLY",            url: "https://www.olly.com/",          widget: "repai", candidate: true },
  { key: "repai-higherdose",  vendor: "Rep AI", store: "HigherDOSE",      url: "https://higherdose.com/",        widget: "repai", candidate: true },
  { key: "repai-nutrabio",    vendor: "Rep AI", store: "NutraBio",        url: "https://nutrabio.com/",          widget: "repai", candidate: true },
  { key: "repai-satya",       vendor: "Rep AI", store: "Satya Jewelry",   url: "https://www.satyajewelry.com/",  widget: "repai", candidate: true },
  { key: "repai-bikesonline", vendor: "Rep AI", store: "BikesOnline",     url: "https://bikesonline.com.au/",    widget: "repai", candidate: true },
  { key: "repai-kinn",        vendor: "Rep AI", store: "Kinn Studio",     url: "https://kinnstudio.com/",        widget: "repai", candidate: true },
  { key: "repai-cwspirits",   vendor: "Rep AI", store: "Country Wine & Spirits", url: "https://cwspirits.com/",  widget: "repai", candidate: true },
  // Kodif — headed-only (kodif-chat-widget iframe). DSC + JustFoodForDogs + Neuro independent; Babyletto/daVinci/Namesake share one parent (Million Dollar Baby Co.).
  { key: "kodif-jffd",        vendor: "Kodif",  store: "JustFoodForDogs", url: "https://www.justfoodfordogs.com/", widget: "kodif", candidate: true },
  { key: "kodif-neuro",       vendor: "Kodif",  store: "Neuro",           url: "https://neurogum.com/",          widget: "kodif", candidate: true },
  { key: "kodif-babyletto",   vendor: "Kodif",  store: "Babyletto",       url: "https://babyletto.com/",         widget: "kodif", candidate: true },
  { key: "kodif-davinci",     vendor: "Kodif",  store: "daVinci Baby",    url: "https://davincibaby.com/",       widget: "kodif", candidate: true },
  { key: "kodif-namesake",    vendor: "Kodif",  store: "Namesake",        url: "https://namesakehome.com/",      widget: "kodif", candidate: true },
];

// Find a frame by element id / title / name / url.
export async function findFrame(page, match) {
  for (const f of page.frames()) {
    if ((f.name() || "").includes(match) || f.url().includes(match)) return f;
    try {
      const el = await f.frameElement();
      const id = (await el.getAttribute("id")) || "";
      const title = (await el.getAttribute("title")) || "";
      if (id.includes(match) || title.includes(match)) return f;
    } catch {}
  }
  return null;
}

// Read the current transcript (frame | shadow-by-text | shadow-by-id).
export async function readTranscript(page, scope) {
  if (scope.kind === "frame") {
    const f = await findFrame(page, scope.match);
    if (!f) return { len: 0, text: "" };
    try { const text = await f.evaluate(() => document.body.innerText || ""); return { len: text.length, text }; }
    catch { return { len: 0, text: "" }; }
  }
  if (scope.kind === "shadowId") {
    try {
      // Deep-walk the OPEN shadow tree under the host, gathering innerText from leaf
      // elements only, skipping <style>/<script> (the old first-<div> read leaked CSS).
      const text = await page.evaluate((sel) => {
        const host = document.querySelector(sel) || document.getElementsByTagName(sel)[0];
        const root = host && host.shadowRoot ? host.shadowRoot : host;
        if (!root) return "";
        let out = "";
        const walk = (n) => {
          if (!n) return;
          if (n.nodeType === 1) { const tag = n.tagName; if (tag === "STYLE" || tag === "SCRIPT" || tag === "NOSCRIPT") return; if (n.shadowRoot) walk(n.shadowRoot); }
          if (n.nodeType === 1 && !n.shadowRoot && n.childElementCount === 0) { const t = (n.innerText || n.textContent || "").trim(); if (t) out += t + "\n"; return; }
          for (const k of (n.childNodes || [])) walk(k);
        };
        walk(root);
        return out;
      }, scope.sel);
      return { len: text.length, text };
    } catch { return { len: 0, text: "" }; }
  }
  // shadow DOM (Sierra): find the root that CONTAINS the composer (scope.match is the
  // composer selector). The old code matched textContent against the aria-label "Add new
  // message" — an attribute, never in textContent → always 0.
  try {
    const text = await page.evaluate((composerSel) => {
      const root = (window.__sierraRoot && window.__sierraRoot(composerSel)) || null;
      return root ? (root.innerText || root.textContent || "") : "";
    }, scope.match);
    return { len: text.length, text };
  } catch { return { len: 0, text: "" }; }
}
