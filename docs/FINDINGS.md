# Findings

Full results for both modes — latency, answer quality, latency-by-question-type, handover red flags — plus the strategic takeaways. Test windows: 2026-06-29/30.

> Cross-vendor numbers are **directional** (different stores/domains, single test windows, some warm sessions). Read alongside [METHODOLOGY.md](METHODOLOGY.md) and [VENDORS.md](VENDORS.md). Raw data: the repo's `data_*.json`.

## Shopping Assistant mode

Time to a real product recommendation, and recommendation quality (blind judges, 0–5; 0 = handed off / didn't recommend).

| Vendor | Latency | Rec quality | What it does |
|---|---|---|---|
| **Sierra** (Casper) | ~8.2s | **5.0** | Streams; renders interactive **Add-to-Cart product cards** |
| **Gorgias** *(us, NouriVida)* | ~17.1s | **5.0** | Product cards + SKU links + **discount code** + CTA |
| **Yuma** (EvryJewels) | ~13.8s | 2.7 | Text rec; only gestures at collections |
| **Siena** (Simple Modern) | ~10s | 1.0 | Defers to product pages instead of picking |
| **DigitalGenius** (Bloom & Wild) | 🚩 handover | 0 | "I'll connect you with our team" → no rec |
| **Meta AI** (Dermalogica) | 🚩 handover | 0 | Opens a lead-capture form → no rec |
| **Ada** (Loop) | — | — | Backend down |

**Read:** only **4 of 7** even attempt a product recommendation. Of those, Sierra and Gorgias (us) are top quality (5.0); Gorgias matches Sierra on quality but is **the slowest to produce a rec (~17s vs ~8s)**. Two vendors (DigitalGenius, Meta AI) **🚩 hand off to a human** rather than sell — a real capability limitation, not a fast result.

## Support mode

Time to a full answer on shipping/returns/policy, and answer quality (0–5).

| Vendor | Latency | Quality |
|---|---|---|
| **Sierra** | ~6.5s | **5.0** |
| **Meta AI** | ~5s | 3.5 |
| **Gorgias** *(us)* | ~8.7s | 3.9 |
| **Siena** | ~9.5s | 3.4 |
| **DigitalGenius** | ~10.2s | 4.3 |
| **Yuma** | ~13.5s | 4.4 |
| **Ada** | down | — |

**Read:** support is closer across the field — table stakes. Sierra leads on both speed and quality. Gorgias (us) is mid-pack on speed; its **returns answer is the quality weak spot (3.9 overall)** — judges flagged it as thin and noted it pivots straight to an upsell instead of explaining the policy.

## Latency by question type

The biggest driver of latency is **what you ask**, not the vendor. Product-recommendation turns are consistently the slowest (catalog retrieval + reasoning + card rendering).

| Vendor | Simple FAQ | Policy / returns | Product recommendation |
|---|---|---|---|
| Sierra | ~7.0s | 4.6s | ~8.2s |
| Siena | ~9.0s | 11.3s | ~10.0s |
| Gorgias *(us)* | 6.4s | 13.5s | **~17.1s** |
| Yuma | ~12.5s | 16.3s | 13.8s |
| DigitalGenius | ~10.0s | — | 🚩 handover |
| Meta AI | ~5s | ~5s | 🚩 handover |

On the Gorgias demo, a simple FAQ returns in ~6.4s but "which product do you recommend?" takes ~17s (**≈2.7× slower**). Sierra is the exception — it streams (first words ~0.4s) and uses a prebuilt product-card system, so a rec isn't much slower than an FAQ.

## Answer quality — blind 3-judge panel

Vendors anonymized as Store A–F; 3 independent judges; mean reported. (`data_quality_eval.json`)

| Vendor | FAQ | Policy | Product rec | Overall |
|---|---|---|---|---|
| Sierra | 5.0 | 5.0 | 5.0 | **5.0** |
| Gorgias *(us)* | 5.0 | 2.7 | 5.0 | **4.0** |
| Yuma | 5.0 | 3.7 | 2.7 | **3.3** |
| Siena | 5.0 | 1.7 | 1.0 | **2.7** |
| Meta AI | 2.0 | 5.0 | 0 | **2.0** |
| DigitalGenius | 4.3 | n/a | 0 | **2.0** |

Judge agreement was high (e.g. Sierra 5/5/5, Gorgias 4/4/4 on overall), so the ranking is stable, not noise.

## Handover red flags 🚩

No question in either pool asks for a human, so any handover is unprompted = the assistant couldn't do the job.

- **DigitalGenius** — escalates the product-recommendation question to a human; with agents unavailable, drops into a support-ticket flow that **locks the chat**.
- **Meta AI** (Dermalogica) — escalates the product-recommendation question to a **lead-capture form** (Name/email), which locks the chat.
- **Siena** — *soft* handover on returns ("share your email or order number so the team can confirm") rather than answering.

The headless runner flags these automatically (`red_flag: true` + which turns), so the monthly run tracks whether vendors improve.

## Strategic takeaways

1. **Speed ≠ quality.** The fastest support responder (Meta AI ~5s) is among the lowest quality and won't recommend at all; Sierra is fastest *and* highest quality. A low latency number from an assistant that escalates is not a win.
2. **Product recommendation is where assistants separate.** Half the field hands off to a human. Only Sierra and Gorgias (us) deliver top-quality recommendations.
3. **For Gorgias (us), the two clear improvement targets are:** (a) **recommendation latency** (~17s vs Sierra's ~8s), and (b) the **returns/policy answer quality** (3.9 — thin, jumps to upsell). Recommendation *quality* is already best-in-class (5.0).
4. **Sierra is the benchmark to beat** — streaming for instant first-token, prebuilt product cards with Add-to-Cart, and top quality in both modes.

## Status / coverage notes

- **Ada** deployed but backend down both test days — no data.
- **Gorgias** measured on its own NouriVida demo (best-case).
- Some latency figures were captured on warm sessions (slightly inflated; see cold-vs-warm in METHODOLOGY). The monthly runner produces cold, deep (10-turn) numbers going forward.
