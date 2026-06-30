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
    'button:has-text("Refuser")', 'button:has-text("Tout refuser")',
    'button:has-text("Accept")', '[aria-label="Close"]', 'button:has-text("Close")',
  ]) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 400 })) await b.click({ timeout: 600 }); } catch {}
  }
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
    handover: [/joined the chat/i, /a rejoint (la )?(conversation|discussion|chat)/i, /\b\w+ (says|dit)\s*:/i,
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
      await page.waitForTimeout(5000); await dismiss(page);
      await page.evaluate(async () => {
        for (let i = 0; i < 12; i++) {
          const modal = document.querySelector('#spiffy-modal-container');
          if (modal?.shadowRoot?.querySelector('input')) {
            // ensure it's actually visible; if not, click a launcher
            const visible = [...modal.shadowRoot.querySelectorAll('div')].some(d => d.innerText && d.innerText.length > 50);
            if (visible) break;
          }
          const fb = document.querySelector('#spiffy-ai-floating-button');
          try { (fb?.shadowRoot?.querySelector('button,div[role=button],div') || fb)?.click(); } catch (e) {}
          // also try a top suggestion chip
          const bar = document.querySelector('#spiffy-top-suggestion-bar-id');
          try { bar?.shadowRoot?.querySelector('button,[role=button]')?.click(); } catch (e) {}
          await new Promise(r => setTimeout(r, 800));
        }
      });
      await page.waitForTimeout(2500);
    },
    async send(page, text) {
      await page.evaluate(t => {
        const sr = document.querySelector('#spiffy-modal-container')?.shadowRoot; if (!sr) return;
        const inp = sr.querySelector('input[placeholder*="Ask" i]') || sr.querySelector('input');
        const btn = [...sr.querySelectorAll('button')].find(b => /send message/i.test(b.getAttribute('aria-label') || ''));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, t); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => { if (btn) btn.click(); else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 150);
      }, text);
    },
  },

  // Sierra — shadow-DOM widget, SSE streaming.
  sierra: {
    scope: { kind: "shadow", match: "Add new message" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => { try { window.openSierraChat?.(); } catch (e) {} document.querySelector('[aria-label*="chat" i],[class*="launcher" i]')?.click?.(); }); await page.waitForTimeout(4500); },
    async send(page, text) {
      await page.evaluate((t) => {
        let root = null;
        document.querySelectorAll("*").forEach(el => { if (el.shadowRoot && el.shadowRoot.querySelector('textarea[aria-label="Add new message"]')) root = el.shadowRoot; });
        if (!root) return;
        const ta = root.querySelector('textarea[aria-label="Add new message"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, t); ta.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => root.querySelector('button[aria-label="Send message"]')?.click(), 150);
      }, text);
    },
  },

  // Siena — iframe (chat.siena.cx) + REST.
  siena: {
    scope: { kind: "frame", match: "siena.cx" },
    async open(page) {
      await page.waitForTimeout(3500); await dismiss(page);
      await page.evaluate(() => { try { window.SienaLaunchChat?.(); } catch (e) {} });
      await page.waitForTimeout(4000);
      const f = page.frames().find(fr => fr.url().includes("siena.cx"));
      if (f) await fillEmailGate(page, f);   // FIGS etc. gate on an email
    },
    async send(page, text) {
      const f = page.frames().find(fr => fr.url().includes("siena.cx")); if (!f) return;
      const input = f.locator('textarea, input[type="text"], [contenteditable="true"]').first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },

  // DigitalGenius — Sunshine Conversations iframe, gated by a prechat lead form.
  dg: {
    scope: { kind: "frame", match: "dg-chat-widget-iframe" },
    async open(page) {
      await page.waitForTimeout(3500); await dismiss(page);
      await page.evaluate(() => { try { window.dgchat?.methods?.launchWidget(); } catch (e) {} });
      await page.waitForTimeout(3500);
      try {
        const frame = await findFrame(page, "dg-chat-widget-iframe");
        if (frame) {
          await frame.getByPlaceholder(/name/i).fill(DUMMY.name, { timeout: 4000 }).catch(() => {});
          await frame.getByPlaceholder(/email/i).fill(DUMMY.email, { timeout: 4000 }).catch(() => {});
          await frame.getByText(/Start Chat/i).click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }
      } catch {}
    },
    async send(page, text) {
      const f = await findFrame(page, "dg-chat-widget-iframe"); if (!f) return;
      const input = f.getByPlaceholder(/type a message|message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
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
    scope: { kind: "frame", match: "ada" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => { try { window.adaEmbed?.toggle?.(); } catch (e) {} }); await page.waitForTimeout(5000); },
    async send(page, text) {
      const f = page.frames().find(fr => /ada\.support/.test(fr.url())); if (!f) return;
      const input = f.getByPlaceholder(/message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },
};

// ---------------------------------------------------------------------------
// Stores under test — 2–3 per vendor. `candidate:true` = needs verification that
// the widget is live/drivable; the runner attempts it and records an error if not.
// ---------------------------------------------------------------------------
export const STORES = [
  // Gorgias (us) — Glamnetic intentionally excluded
  { key: "gorgias-madura",   vendor: "Gorgias", store: "Madura",        url: "https://www.madura.com/en",            widget: "gorgias", us: true, locale: "en-US" },
  { key: "gorgias-masderm",  vendor: "Gorgias", store: "Masderm",       url: "https://masderm.com/fr",               widget: "gorgias", us: true, locale: "fr-FR" },
  { key: "gorgias-alpine",   vendor: "Gorgias", store: "Alpine Hearing Protection", url: "https://www.alpinehearingprotection.com/", widget: "gorgias", us: true },
  { key: "gorgias-jade",     vendor: "Gorgias", store: "Jade",          url: "https://shop.jadeofficial.com/",       widget: "gorgias", us: true },
  { key: "gorgias-jshealth", vendor: "Gorgias", store: "JSHealth Vitamins", url: "https://us.jshealthvitamins.com/", widget: "gorgias", us: true },

  // Spiffy.ai
  { key: "spiffy-supergoop", vendor: "Spiffy.ai", store: "Supergoop",  url: "https://supergoop.com/products/everyday-sunscreen?variant=31189086634082", widget: "spiffy" },
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
  { key: "dg-bloomwild", vendor: "DigitalGenius", store: "Bloom & Wild", url: "https://www.bloomandwild.com/",  widget: "dg" },
  { key: "dg-on",        vendor: "DigitalGenius", store: "On",           url: "https://www.on.com/en-us",        widget: "dg", candidate: true },
  { key: "dg-gstar",     vendor: "DigitalGenius", store: "G-Star RAW",   url: "https://www.g-star.com/en_us",    widget: "dg", candidate: true },

  // Meta AI (front-end = Zendesk Virtual Assistant)
  { key: "meta-dermalogica", vendor: "Meta AI", store: "Dermalogica",   url: "https://www.dermalogica.com/",    widget: "zendesk" },
  { key: "meta-2",           vendor: "Meta AI", store: "(2nd store)",   url: "",                                widget: "zendesk", candidate: true, todo: "find a 2nd Meta/Zendesk AI storefront" },

  // Ada
  { key: "ada-loop", vendor: "Ada", store: "Loop Earplugs",            url: "https://www.loopearplugs.com/",    widget: "ada" },
  { key: "ada-2",    vendor: "Ada", store: "(2nd store)",             url: "",                                 widget: "ada", candidate: true, todo: "find a 2nd Ada retail storefront" },
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
      const text = await page.evaluate((sel) => { const e = document.querySelector(sel); const d = e?.shadowRoot?.querySelector('div'); return d ? (d.innerText || "") : ""; }, scope.sel);
      return { len: text.length, text };
    } catch { return { len: 0, text: "" }; }
  }
  // shadow DOM by needle text (Sierra)
  try {
    const text = await page.evaluate((needle) => {
      let root = null;
      document.querySelectorAll("*").forEach(el => { if (el.shadowRoot && el.shadowRoot.textContent.includes(needle)) root = el.shadowRoot; });
      return root ? (root.innerText || root.textContent) : "";
    }, scope.match);
    return { len: text.length, text };
  } catch { return { len: 0, text: "" }; }
}
