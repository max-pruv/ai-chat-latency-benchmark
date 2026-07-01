# Gorgias AI Agent — Competitive Benchmark

A reproducible benchmark of competitor **on-site AI chat assistants**, measured on their **live customer storefronts**, across the two jobs a storefront assistant actually does:

- **Shopping Assistant** — product discovery that must end in a real recommendation
- **Support AI Agent** — shipping, delivery, returns, policy

For every conversation it records three things:

1. **Latency** — true end-to-end, from message sent to the *final* answer rendered.
2. **Success rate** — % of turns the AI handled itself, with **no spontaneous human handover**.
3. **Answer quality** — an LLM-judge score against a grounded rubric (Relevance for Shopping, Resolution for Support).

**Live report:** https://gorgias.github.io/ai-chat-latency-benchmark/report.html
&nbsp;&nbsp;(toggle Shopping Assistant ⇄ Support AI Agent at the top; filter by date range)

> Built by Gorgias R&D as competitor intelligence. Latency reflects specific capture windows and varies with load, query type, and session state — treat cross-vendor numbers as **directional**, and read the success + quality columns alongside speed, not a single average.

---

## What the report shows

The report is a **static snapshot** (baked data, no auto-refresh). Each run **adds** a new dated batch of conversations; the date-range picker at the top defaults to the last 30 days and lets you scope any window. Sections top-to-bottom:

- **Summary — by vendor.** One row per vendor for the current mode: stores, conversations, avg latency, avg success, avg quality, avg turns. Sortable.
- **Best AI agent — by category.** Ranks vendors by a single **composite of the two things that matter most — success and speed** — shown side-by-side for Shopping and Support, with where Gorgias lands in each.
  - `composite = 0.6 × success% + 0.4 × speed`, where `speed = 100 at ≤3s, 0 at ≥22s` (linear).
  - This is deliberately transparent: success is the outcome, speed is the experience. It surfaces the real trade-off — e.g. Gorgias tends to **lead on success but is dragged down by latency**.
- **Results — per store.** Every live store as its own row: latency, success, quality, turns, and a one-line "what happened".
- **Capabilities** (Shopping only) — per **vendor**: quick replies, product cards, reviews, completes-the-sale-without-handoff.
- **Recorded conversations** — drill into the actual multi-turn transcript per store, with per-message latency and where any human handover occurred.

## How it works

- **Two clean lanes.** The Shopping Assistant lane is *pre-sales only* (product discovery → recommendation → add-to-cart). The Support lane is *post-purchase only* (tracking, returns, damaged item, order changes, shipping/returns/payment policy). The two never mix — the support themes contain no discount/promo/loyalty questions, so there's no ambiguity between support and pre-sales.
- Each assistant is driven on its **live customer site** in a **fresh, cold browser context** per conversation (private/incognito-equivalent — no warm session state).
- We run **5 standardized themes per lane** per store, each a **single continuous ~7-turn conversation** (consecutive turns in the *same* session), adapted to each catalog so it's apples-to-apples.
- **Latency is timed to the true final answer.** Typing indicators and stall/ack messages ("one moment, let me check…") are skipped so a two-part reply can't fake a fast number. Human replies are never timed.
- We **never click quick-reply chips** — always free-typed text — because canned chips can trigger cached responses and distort latency.
- We **never request a human**; any handover is unprompted, **stops the conversation** (we don't keep scripting a live agent), and counts against success.

### Data integrity — the validity gate

A conversation is only admitted to the report if it is a **real data point**: it either hit a genuine handover, or produced **≥3 cleanly-timed AI answers**. Anything else — a chip/menu-only widget, an offline/"leave a message" state, or a pure timeout with no measurable answer — is marked **invalid and excluded** (never shown as a latency-less conversation). This logic lives in [`runner/classify.js`](runner/classify.js) as pure functions and is covered by unit tests ([`runner/classify.test.js`](runner/classify.test.js), `node --test`), including the regression guards: a bot's own "AI says:" / "Virtual Assistant says:" is *not* a handover, a named human ("Sarah says:") *is*, and offline/menu text never counts as an answer.

### Quality scoring

Recorded transcripts are scored by an LLM judge against a grounded 0–100 rubric, written to [`runner/quality-scores.json`](runner/quality-scores.json) and merged into the report by `gen.js`:

| Shopping — **Relevance** | Support — **Resolution** |
|---|---|
| R1 Answer relevance /35 | R1 Resolution correctness /35 |
| R2 Recommendation specificity /25 | R2 Groundedness of policy facts /25 |
| R3 Right rich element (card/reviews/cart) /25 | R3 Self-served / containment /25 |
| R4 Closed without handover /15 | R4 Completeness / actionability /15 |

## Vendors

11 vendors, each sourced to **≥5 verified customer storefronts**. Captured coverage varies because most widgets only load in a real (headed) browser.

| Vendor | Widget / transport | Headless-drivable? |
|---|---|---|
| **Gorgias** *(us)* | Gorgias Chat, same-origin iframe + WebSocket | ✅ (only vendor that captures headless) |
| **Envive** (formerly Spiffy.ai) | `cdn.spiffy.ai` PDP modal, shadow DOM | headed-only |
| **Sierra** | inline shadow-DOM widget, SSE streaming | headed-only |
| **Siena** | `chat.siena.cx` iframe + REST | headed-only |
| **Yuma** | runs behind Gorgias/Zendesk (back-end automation) | partial |
| **DigitalGenius** | Sunshine Conversations + Pusher, prechat form | headed-only (≈2 sites load) |
| **Meta AI** ¹ | Zendesk messaging "Virtual Assistant" | partial |
| **Ada** | `static.ada.support` embed (help pages) | headed-only |
| **Rep AI** | `server.myrepai.com` (network-timed) | headed-only |
| **Kodif** | `chatwidget.kodif.ai` iframe | headed-only |
| **Humind** | `humind-gift-finder` shadow, FR | headed-only |

¹ Client-side the widget is Zendesk's messaging Virtual Assistant; the underlying model isn't verifiable from the browser. Labeled "Meta AI" as originally requested, with that caveat.

## Headline results — 2026-07-01 snapshot

*(the live report is authoritative and updates each run; these are the current composite standings)*

**Shopping Assistant** — composite (success + speed):

1. **Siena — 54** (49% success, ~10.1s)
2. **Gorgias *(us)* — 49** (highest success **69%**, but ~18.5s latency)
3. Rep AI 48 · Kodif 46 · Sierra 44 · Envive 41 · DigitalGenius 34 · Ada 30 · Humind 25

**Support AI Agent** — composite:

1. **Siena — 84** (100% success, ~10.7s)
2. DigitalGenius 57 · Ada 51 · Envive 48 · **Gorgias *(us)* 45** (#5 of 6) · Sierra 45

**Top quality (0–100):** Shopping — Envive/Supergoop **97**, Gorgias/Beekman **97**, Gorgias/Shoebacca 96. Support — Siena/Simple Modern **97**, Gorgias/Beekman 96, Yuma/EvryJewels 95.

**The through-line:** Gorgias is competitive-to-leading on **success and answer quality**, but its **~18s latency is the gap** — it's what drops it in the speed-weighted composite. Full analysis in [`docs/FINDINGS.md`](docs/FINDINGS.md).

## Repository map

```
.
├── report.html                Main report (Shopping ⇄ Support toggle)  ← the deliverable, deployed to Pages
├── index.html                 Landing page
├── runner/                    Capture + report pipeline
│   ├── run.js                 orchestrator: cold context per store+mode+theme, timing, handover flag,
│   │                          per-conversation durable writes, theme-level resume
│   ├── vendors.js             per-vendor harness (open / send / read transcript) + STORES site lists
│   ├── pools.js               the 5 Shopping + 5 Support themes
│   ├── detect.js              widget-signature detection (network + globals + DOM)
│   ├── gen.js                 aggregates results/<date>/conv/*.json → injects data into report.html
│   ├── quality-scores.json    LLM-judge Relevance/Resolution scores, keyed by store
│   ├── run-benchmark.sh       one-command finisher (headless default; `headed` = all vendors)
│   ├── refresh-loop.sh        local dev only: re-runs gen.js periodically while capturing
│   └── results/<date>/conv/   one JSON per conversation (durable, accumulates per run)
├── docs/
│   ├── METHODOLOGY.md         latency timing, quality rubric, cold sessions, handover detection
│   ├── VENDORS.md             per-vendor widget tech, transport, harness, observations
│   └── FINDINGS.md            full results + analysis + caveats
└── .github/workflows/
    ├── deploy-pages.yml       deploys repo root to GitHub Pages on push to master
    └── monthly-benchmark.yml  runs the runner on the 1st of each month (fresh container = cold)
```

## Running it

**The report** is static — open `report.html` or the live URL. To regenerate its data after a capture: `cd runner && node gen.js`.

**Capture (headless — Gorgias + whatever loads without a real browser):**

```bash
cd runner
npm install
npx playwright install --with-deps chromium
node run.js                       # all vendors, both modes, 5 themes → results/<date>/conv/*.json
node run.js --mode shopping
```

**Capture (headed — required for most competitor widgets):**

```bash
cd runner && caffeinate -i bash run-benchmark.sh headed   # real Chrome, resumable, residential IP
```

Runner writes one JSON per conversation the instant it finishes (resumable at the theme level), then `gen.js` aggregates on read and injects `STORES`/`SUPPORT` into `report.html`. Invalid/no-latency captures are re-tried on the next run, never treated as done.

**Unit tests:**

```bash
cd runner && node --test        # classify.test.js — validity gate, handover & typing/stall detection
```

## Deploy

GitHub Pages serves the repository root of `master` (`deploy-pages.yml`). **Pushing `report.html` to `master` publishes it** at `https://gorgias.github.io/ai-chat-latency-benchmark/report.html`.

## Key caveats

- **Different stores/domains** — answers are judged in each store's own context; cross-vendor numbers are directional, not a controlled lab.
- **Static snapshot** — the report no longer auto-refreshes; the badge shows the latest capture date. Re-run `gen.js` and re-deploy to update.
- **Coverage is honest, not uniform.** Only Gorgias captures headless; competitor widgets are headed-only, and some have hard ceilings (DigitalGenius ≈2 live on-site sites, some Yuma/Ada endpoints offline on capture days). Stores with no timed AI turn are left unscored rather than invented.
- **Gorgias (us)** is tested on real customer storefronts (Madura, Jade, Beekman 1802, Baby Bee, Shoebacca) with production guardrails — a fairer, tougher baseline than a sales-tuned demo.
- **Public client-side identifiers** (appKeys, shop handles) that appear here are already readable in the storefronts' page source — not secrets, included only for reproducibility.

---

*Competitor intelligence · Gorgias R&D · 2026.*
