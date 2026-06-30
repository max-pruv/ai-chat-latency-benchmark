# AI Chat Benchmark — Shopping Assistant vs Support

Live, reproducible **latency + answer-quality** benchmark of competitor on-site AI chat assistants, split into the two jobs a storefront assistant actually does:

- **🛍️ Shopping Assistant** — sales discovery that must end in a real product recommendation
- **🎧 Support** — shipping, delivery, returns, policy

It measures end-to-end response **latency**, scores **answer quality** with a blind LLM-judge panel, and **red-flags** any assistant that hands the conversation to a human instead of doing the job.

**📊 Live report:** https://gorgias.github.io/ai-chat-latency-benchmark/
&nbsp;&nbsp;(toggle Shopping Assistant ⇄ Support at the top)

> Built by Gorgias R&D as competitor intelligence. Latency reflects specific test windows (2026-06-29/30) and varies with load, query type, and session state — treat cross-vendor numbers as **directional**, and read the per-question-type and quality sections, not just a single average.

---

## Contents

- [Vendors tested](#vendors-tested)
- [Headline results](#headline-results)
- [How it works (short)](#how-it-works-short)
- [Repository map](#repository-map)
- [Running it](#running-it)
- [Deep documentation](#deep-documentation)
- [Key caveats](#key-caveats)

---

## Vendors tested

| Vendor | Customer site tested | Widget tech | Native storefront chat? |
|---|---|---|---|
| **Sierra** | Casper ("Luna") | inline shadow-DOM widget, SSE streaming | ✅ |
| **Siena** | Simple Modern ("Maddie") | iframe (`chat.siena.cx`) + REST API | ✅ |
| **Gorgias** *(us)* | NouriVida (Gorgias demo store) | Gorgias Chat, WebSocket | ✅ |
| **Yuma** | EvryJewels | none of its own — runs behind **Gorgias Chat** | ❌ (back-end automation) |
| **DigitalGenius** | Bloom & Wild ("Willow") | Sunshine Conversations + Pusher | ✅ (gated by prechat form) |
| **Meta AI**¹ | Dermalogica | Zendesk "Virtual Assistant" | ✅ |
| **Ada** | Loop Earplugs | `static.ada.support` embed | ✅ (deployed; **backend down** both test days) |

¹ Requested as "Meta AI"; client-side the widget is Zendesk's messaging Virtual Assistant — the underlying model isn't verifiable from the browser. Labeled as requested with that caveat.

## Headline results

**Shopping Assistant** — time to a real product recommendation + recommendation quality (0–5):

| Vendor | Latency | Quality | Notes |
|---|---|---|---|
| Sierra | ~8.2s | 5.0 | streams; interactive Add-to-Cart product cards |
| Gorgias *(us)* | ~17.1s | 5.0 | product cards + SKU links + discount code; **slowest of the rec-capable** |
| Yuma | ~13.8s | 2.7 | text rec, only gestures at collections |
| Siena | ~10s | 1.0 | defers to product pages |
| DigitalGenius | 🚩 | 0 | **hands off to a human** — no recommendation |
| Meta AI | 🚩 | 0 | **hands off to a lead-capture form** — no recommendation |
| Ada | — | — | backend down |

**Support** — time to a full answer + answer quality (0–5):

| Vendor | Latency | Quality |
|---|---|---|
| Sierra | ~6.5s | 5.0 |
| Meta AI | ~5s | 3.5 |
| Gorgias *(us)* | ~8.7s | 3.9 |
| Siena | ~9.5s | 3.4 |
| DigitalGenius | ~10.2s | 4.3 |
| Yuma | ~13.5s | 4.4 |
| Ada | down | — |

**Three things that pop out** (full analysis in [`docs/FINDINGS.md`](docs/FINDINGS.md)):

1. **Speed ≠ quality.** The fastest support responder (Meta AI ~5s) is among the lowest quality and won't recommend at all. Sierra is fastest *and* highest quality.
2. **Product recommendation splits the field.** Only Sierra, Gorgias, Yuma and Siena attempt it; **DigitalGenius and Meta AI hand off to a human** (red flag). Gorgias (us) ties Sierra on rec quality (5.0) but is the slowest to produce one (~17s).
3. **Question type drives latency more than the vendor.** Product-recommendation turns are ~2–3× slower than FAQs everywhere (catalog retrieval + reasoning + card rendering).

## How it works (short)

Each assistant is driven on its **live customer site**. For every turn we record wall-clock from message-sent to the full response, using the most reliable signal for that vendor's transport (REST poll / SSE stream close / WebSocket frame / same-origin iframe DOM). Two standardized, deliberately **complex** 10-turn conversations are run per vendor (Shopping + Support). Recorded answers are then scored 0–5 by a **blind 3-judge LLM panel** on anonymized vendors. Any unprompted **human handover is flagged as a red-flag limitation**.

Full detail: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

## Repository map

```
.
├── index.html                 Landing page
├── report.html                Main report (Shopping ⇄ Support toggle)  ← the deliverable
├── results.html               Original Siena (Simple Modern) deep-dive page
├── benchmark.py / benchmark.js Original Siena harness (API method + browser runner)
├── data_*.json                Raw per-vendor results + recorded answers
│   ├── data_sierra.json  data_gorgias.json  data_yuma.json
│   ├── data_digitalgenius.json  data_metaai.json
│   └── data_quality_eval.json   blind-judge quality scores
├── runner/                    Headless, cold-session runner (the monthly engine)
│   ├── run.js                 orchestrator: cold context per vendor+mode, timing, handover flag
│   ├── vendors.js             per-vendor harness (open / send / read transcript)
│   ├── pools.js               standardized 10-turn Shopping + Support pools
│   └── README.md              runner docs
├── docs/
│   ├── METHODOLOGY.md         how latency, quality, cold sessions, handover are measured
│   ├── VENDORS.md             per-vendor widget tech, transport, harness, observations
│   └── FINDINGS.md            full results + analysis + caveats
└── .github/workflows/
    └── monthly-benchmark.yml  runs the runner on the 1st of each month (fresh container = cold)
```

## Running it

**The report** is static — open `report.html` or the live URL.

**The headless runner** (deep, cold, both modes):

```bash
cd runner
npm install
npm run install:browser     # playwright install chromium
node run.js                 # all vendors, both modes → runner/results/<date>/*.json
node run.js --vendor gorgias sierra
node run.js --mode shopping
```

**Original Siena reproduction** (browser console): paste `benchmark.js` into DevTools on the Simple Modern product page with the chat open; or `python3 benchmark.py` to print the recorded run.

## Deep documentation

- **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** — measurement design: latency timing per transport, the blind quality eval, the cold-vs-warm session problem (and what does/doesn't work), and the handover red-flag detector.
- **[docs/VENDORS.md](docs/VENDORS.md)** — per-vendor breakdown: site, widget technology, transport, how the chat is opened and driven, where the session persists, and behavioral observations.
- **[docs/FINDINGS.md](docs/FINDINGS.md)** — full results for both modes, latency-by-question-type, quality scores, handover red flags, and the strategic takeaways.
- **[runner/README.md](runner/README.md)** — the headless runner and monthly automation.

## Key caveats

- **Different stores/domains** (mattresses, supplements, jewelry, flowers, skincare, drinkware, earplugs) — answers are judged in each store's own context; cross-vendor numbers are directional, not a controlled lab.
- **Gorgias (us) ran on its own NouriVida demo store** — a sales-tuned, best-case configuration.
- **Warm sessions slightly inflate latency** (measured: DigitalGenius 12.7s cold vs 14.3s warm). The monthly runner uses a fresh container per run, which is cold by construction. See [`docs/METHODOLOGY.md#cold-sessions`](docs/METHODOLOGY.md#cold-sessions).
- **Ada** was deployed but its bot was unavailable on both test days.
- **Public client-side identifiers** (e.g. Siena's `appKey`) that appear in this repo are already readable in the storefronts' page source — they are not secrets, and are included only for reproducibility.

---

*Competitor intelligence · Gorgias R&D · 2026.*
