# Per-vendor breakdown

What each assistant is, how its widget is built, the transport it uses, how to open/drive it, where the session persists (relevant for cold runs), and behavioral observations. This is the reverse-engineering that the report and the headless runner are built on.

> Identifiers shown here (app keys, integration UUIDs, embed paths) are **public client-side values** already readable in each storefront's page source — not secrets. Included for reproducibility.

---

## Sierra — Casper ("Luna")

- **Site:** `casper.com` · **Agent:** "Luna"
- **Widget:** inline **shadow-DOM** component in the page (not an iframe).
- **Transport:** **SSE token streaming** via `https://sierra.chat/-/api/chat`. First byte ~0.4s; tokens stream in.
- **Open:** `window.openSierraChat()` (globals: `loadSierra`, `sierraConfig`).
- **Drive:** within the widget's shadow root — `textarea[aria-label="Add new message"]`, `button[aria-label="Send message"]`; transcript in `ol[aria-label="Chat messages"]` (each `li` prefixed "Agent said" / "You said"; a single reply can span multiple `li`s).
- **Latency signal:** SSE stream open→close (throttle-immune), or shadow-root text growth+stability.
- **Session:** server-side persisted (warm; not resettable from page scripts).
- **Observations:** **richest commerce UI** — renders interactive **product cards** (image, Select Size, **Add to Cart**). Fastest to a recommendation (~8s). Latency varies sharply by query type (FAQ ~4.6s vs rec ~9.7s). Quality 5.0 both modes.

## Siena — Simple Modern ("Maddie")

- **Site:** `simplemodern.com/products/mesa-loop-30oz-49` · **Agent:** "Maddie"
- **Widget:** cross-origin **iframe** `chat.siena.cx/dist/index.html` (+ `webchat.js`). Backend `api-prod.siena.cx`.
- **Transport / API (reverse-engineered):**
  - `POST /v1/live_chat/session?key=<appKey>` → session
  - `POST /v1/live_chat/messages` → submit user message (returns customer UUID)
  - `GET /v1/live_chat/message?page=1&page_size=20` → poll for the reply (delivered **atomically**, not streamed to the client)
  - `POST /v1/live_chat/delivery/confirm` (message_hash), `…/track/customer_interaction`
  - Auth headers: `x-siena-app-key`, `x-siena-organization-uuid`, `x-siena-livechat-session-uuid`, `x-siena-livechat-customer-uuid`, `x-siena-livechat-integration-uuid`. Public app key on Simple Modern: `bd1e796b-6afe-40a3-b42f-77e4eb72e175`; integration `93a746a4-…`; connected helpdesk: **Gorgias**.
- **Open:** `window.SienaLaunchChat()` / `window.SienaLiveChatWidget` (config exposes `IFRAME_SRC`, `API_BASE`, Sentry + Honeycomb keys).
- **Latency signal:** send→reply via the GET poll (atomic).
- **Observations:** answers in rich text with **linked product variants** (each color → its PDP) but **defers** confident product picks to the product pages ("check the product page", "share your email so the team can confirm"). Support FAQ strong; returns answer deflects (quality: FAQ 5.0, product-rec 1.0).

## Gorgias — NouriVida (us) / also EvryJewels

- **Sites:** `nourivida.myshopify.com` (Gorgias's **demo store**, sales-tuned), `evryjewels.com`.
- **Widget:** **Gorgias Chat** (`config.gorgias.chat`); newer AI-Agent UI on NouriVida. Launcher + input + **`chat-window`** iframe (same-origin under the Shopify domain — readable).
- **Transport:** **WebSocket** (`us-east1-*.gorgias.chat/ws`). Replies arrive as frames; `data.fromAgent === true` marks the bot. Frame events are network-driven → accurate timing even under tab throttling.
- **Open / drive:** `window.GorgiasChat.open()`; **`window.GorgiasChat.sendMessage(text)` works programmatically** (no UI needed) → ideal for automation.
- **Latency signal:** first `fromAgent` WS frame, or `chat-window` iframe text growth+stability.
- **Observations (NouriVida):** **most sales-forward** — renders product cards, recommends specific SKUs with links, applies a **discount code**, and proactively upsells (even on a returns answer). Strongest rec quality (5.0, tied with Sierra) but **slowest to a rec (~17s)**; returns answer is thin and pivots to upsell (quality 2.7). Note: best-case demo.

## Yuma — EvryJewels

- **Site:** `evryjewels.com` (also referenced: Glossier).
- **Key finding:** **Yuma has no storefront chat widget of its own.** On every reference customer the on-site chat is **Gorgias Chat**; Yuma is a **back-end ticket-automation layer** on top of the helpdesk. So "Yuma latency" = the in-chat AI reply a shopper experiences through Gorgias Chat; attribution between Yuma and Gorgias's own AI can't be confirmed client-side.
- **Transport:** Gorgias Chat WebSocket (`fromAgent` frames).
- **Observations:** replies delivered in a **single block** (no streaming); uniformly slower (~14s); a product-rec ("necklace for a birthday") only gestured at collections rather than a specific item (quality 2.7); one question got **no in-chat reply within 70s**.

## DigitalGenius — Bloom & Wild ("Willow")

- **Site:** `bloomandwild.com` · **Agent:** "Willow"
- **Widget:** `chat.digitalgenius.com` built on **Sunshine Conversations** (`sunco.js`) + **Pusher** (WebSocket, EU cluster). Transcript renders in the same-origin **`dg-chat-widget-iframe`**.
- **Open / drive:** `window.dgchat.methods.launchWidget()`, `sendMessage()`; SDK methods `initialiseSDK` / `sendMessageToSDK`. Pusher WS lives in the iframe (not the parent).
- **Gate:** a **prechat lead-capture form (name + email)** blocks the assistant until filled — unique among the set. A throwaway `example.com` identity is used to start the chat.
- **Session:** stored in the **parent origin** → **the only vendor resettable from page scripts** (clearing storage brings the prechat form back). Used to measure cold vs warm: **12.7s cold vs 14.3s warm**.
- **Observations:** solid, specific FAQ/policy answers. On a product-recommendation question it **🚩 hands off to a human** ("I'll connect you with someone from our team"); when agents are unavailable it falls into a support-ticket flow that **locks the chat**. Quality: FAQ 4.3, product-rec 0.

## Meta AI¹ — Dermalogica

- **Site:** `dermalogica.com` · **Agent:** "Dermalogica's Virtual Assistant · AI"
- **Widget:** **Zendesk messaging** (`zE` / `zEmbed`). Transcript in the same-origin **"Messaging window"** iframe, which **re-mounts on each turn** (so DOM polling must re-acquire the frame; latency here is screenshot-approx, ~5s for FAQ).
- **Open:** `window.zE('messenger','open')`.
- **¹Naming:** requested as "Meta AI"; client-side it is Zendesk's Virtual Assistant — the underlying model isn't verifiable from the browser. Labeled as requested with that caveat.
- **Observations:** fast, clear FAQ/policy (returns answer strong). On a product-recommendation question it **🚩 hands off to a human** and opens a lead-capture form (Name/email), which then locks the chat. Quality: returns 5.0, shipping vague 2.0, product-rec 0.

## Ada — Loop Earplugs

- **Site:** `loopearplugs.com` (geo instance `loopearplugs-gr.ada.support`).
- **Widget:** `static.ada.support/embed2.js`; `window.adaEmbed.toggle()`; cross-origin **`ada-chat-frame`** iframe.
- **Status:** **deployed but the bot backend was down on both test days** ("The chat is experiencing technical difficulties…") across EU and US instances. No latency/quality measured — an availability data point in itself. Re-test when it recovers (the runner includes it and will record `null` + error until then).

---

### Quick reference — automation hooks

| Vendor | Open | Send | Read transcript |
|---|---|---|---|
| Sierra | `openSierraChat()` | shadow textarea + send button | shadow `ol[aria-label="Chat messages"]` |
| Siena | `SienaLaunchChat()` | iframe input + Enter | `chat.siena.cx` iframe / REST poll |
| Gorgias | `GorgiasChat.open()` | `GorgiasChat.sendMessage(t)` | `chat-window` iframe / WS `fromAgent` |
| Yuma | `GorgiasChat.open()` | `GorgiasChat.sendMessage(t)` | Gorgias WS `fromAgent` |
| DigitalGenius | `dgchat.methods.launchWidget()` (+ prechat form) | iframe input + Enter | `dg-chat-widget-iframe` |
| Meta AI | `zE('messenger','open')` | "Messaging window" iframe input | "Messaging window" iframe (re-mounts) |
| Ada | `adaEmbed.toggle()` | `ada-chat-frame` input | `ada-chat-frame` iframe |
