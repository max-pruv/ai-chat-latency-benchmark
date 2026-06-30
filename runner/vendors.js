// Per-vendor harness. Playwright can reach into cross-origin iframes (unlike a
// page script), so for most vendors we read the reply text straight out of the
// chat iframe. Each vendor exposes:
//   url            page to load
//   open(page)     open the chat widget (+ dismiss modals / prechat)
//   send(page,txt) post a user message
//   scope          how to read the transcript: {kind:'frame', match} | {kind:'shadow', match}
// The runner times each turn by watching the transcript text grow + stabilize.

const DUMMY = { name: "Benchmark Test", email: "benchmark.test@example.com" }; // reserved example.com — never a real inbox

async function dismiss(page) {
  // best-effort: close common shopify/marketing popups + cookie banners
  for (const sel of [
    'button:has-text("Reject")', 'button:has-text("Decline")', 'button:has-text("No thanks")',
    'button:has-text("Accept")', '[aria-label="Close"]', 'button:has-text("Close")',
  ]) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 400 })) await b.click({ timeout: 600 }); } catch {}
  }
}

export const VENDORS = {
  gorgias: {
    label: "Gorgias", client: "NouriVida (us)", us: true,
    url: "https://nourivida.myshopify.com/",
    scope: { kind: "frame", match: "chat-window" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => window.GorgiasChat?.open()); await page.waitForTimeout(3500); },
    async send(page, text) { await page.evaluate(t => window.GorgiasChat.sendMessage(t), text); },
  },

  yuma: {
    label: "Yuma", client: "EvryJewels", us: false,
    url: "https://evryjewels.com/",
    scope: { kind: "frame", match: "chat" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => window.GorgiasChat?.open()); await page.waitForTimeout(3500); },
    async send(page, text) { await page.evaluate(t => window.GorgiasChat.sendMessage(t), text); },
  },

  sierra: {
    label: "Sierra", client: "Casper", us: false,
    url: "https://casper.com/",
    scope: { kind: "shadow", match: "Chat messages" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => window.openSierraChat?.()); await page.waitForTimeout(4500); },
    async send(page, text) {
      // Sierra renders in a shadow root in the page. Set the textarea + click send.
      await page.evaluate((t) => {
        let root = null;
        document.querySelectorAll("*").forEach(el => {
          if (el.shadowRoot && el.shadowRoot.querySelector('textarea[aria-label="Add new message"]')) root = el.shadowRoot;
        });
        if (!root) return;
        const ta = root.querySelector('textarea[aria-label="Add new message"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, t); ta.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => root.querySelector('button[aria-label="Send message"]')?.click(), 120);
      }, text);
    },
  },

  siena: {
    label: "Siena", client: "Simple Modern", us: false,
    url: "https://www.simplemodern.com/products/mesa-loop-30oz-49",
    scope: { kind: "frame", match: "siena.cx" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => window.SienaLaunchChat?.()); await page.waitForTimeout(4000); },
    async send(page, text) {
      const f = page.frames().find(fr => fr.url().includes("siena.cx"));
      if (!f) return;
      const input = f.locator('textarea, input[type="text"], [contenteditable="true"]').first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },

  dg: {
    label: "DigitalGenius", client: "Bloom & Wild", us: false,
    url: "https://www.bloomandwild.com/",
    scope: { kind: "frame", match: "dg-chat-widget-iframe" },
    async open(page) {
      await page.waitForTimeout(3500); await dismiss(page);
      await page.evaluate(() => window.dgchat?.methods?.launchWidget());
      await page.waitForTimeout(3500);
      // Prechat lead form (name + email) gates the assistant — fill dummy data.
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
      const f = await findFrame(page, "dg-chat-widget-iframe");
      if (!f) return;
      const input = f.getByPlaceholder(/type a message|message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },

  meta: {
    label: "Meta AI", client: "Dermalogica", us: false,
    url: "https://www.dermalogica.com/",
    scope: { kind: "frame", match: "Messaging window" },
    async open(page) { await page.waitForTimeout(4000); await dismiss(page); await page.evaluate(() => window.zE && window.zE("messenger", "open")); await page.waitForTimeout(4000); },
    async send(page, text) {
      const f = await findFrame(page, "Messaging window");
      if (!f) return;
      const input = f.getByPlaceholder(/type a message|message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },

  ada: {
    label: "Ada", client: "Loop Earplugs", us: false,
    url: "https://www.loopearplugs.com/",
    scope: { kind: "frame", match: "ada-chat-frame" },
    async open(page) { await page.waitForTimeout(3500); await dismiss(page); await page.evaluate(() => window.adaEmbed?.toggle?.()); await page.waitForTimeout(5000); },
    async send(page, text) {
      const f = page.frames().find(fr => /ada\.support/.test(fr.url()) && /chat/.test(fr.url()));
      if (!f) return;
      const input = f.getByPlaceholder(/message/i).first();
      await input.click({ timeout: 5000 }).catch(() => {});
      await input.fill(text).catch(async () => { await input.type(text); });
      await page.keyboard.press("Enter");
    },
  },
};

// Find a frame by element id / title / name / url (chat iframes are usually
// identified by their element id or title, NOT by frame.name()).
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

// Read the current transcript length for a vendor's scope (frame or shadow root).
export async function readTranscript(page, scope) {
  if (scope.kind === "frame") {
    const f = await findFrame(page, scope.match);
    if (!f) return { len: 0, text: "" };
    try { const text = await f.evaluate(() => document.body.innerText || ""); return { len: text.length, text }; }
    catch { return { len: 0, text: "" }; }
  }
  // shadow DOM (Sierra)
  try {
    const text = await page.evaluate((needle) => {
      let root = null;
      document.querySelectorAll("*").forEach(el => { if (el.shadowRoot && el.shadowRoot.textContent.includes(needle)) root = el.shadowRoot; });
      return root ? root.textContent : "";
    }, scope.match);
    return { len: text.length, text };
  } catch { return { len: 0, text: "" }; }
}
