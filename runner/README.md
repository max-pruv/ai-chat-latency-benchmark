# Headless benchmark runner

Runs the competitor AI-chat benchmark **cold and unattended** — the thing the in-browser extension can't do (it gets a warm session and its background tab is throttled, which corrupts at-depth latency).

## Why headless solves the problems we hit

| Problem with the manual/extension runs | How the runner fixes it |
|---|---|
| Warm sessions (widget state persists in cross-origin storage; parent can't clear it) | **Fresh `browser.newContext()` per vendor+mode** = isolated storage = genuinely cold |
| Background-tab timer throttling → `null`/inflated latency at 10 turns | **Headless** has no background throttling → reliable per-turn timing |
| Can't reach into cross-origin chat iframes from page JS | **Playwright reads cross-origin frames directly** |
| Manual, ~40 clicks/vendor | Scripted: 10-turn Support + 10-turn Shopping pools per vendor |

## Run it

```bash
cd runner
npm install
npm run install:browser      # playwright install chromium
node run.js                  # all vendors, both modes
node run.js --vendor gorgias sierra
node run.js --mode shopping
```

Output: `runner/results/<YYYY-MM-DD>/<vendor>-<mode>.json` — per-turn `ttft_ms` / `complete_ms`, a reply tail for spot-checking, and summary `stats` (n / avg / min / max).

## Files
- `pools.js` — the standardized question pools (10 Support turns shared; 10 Shopping discovery turns adapted per store catalog).
- `vendors.js` — per-vendor harness (open chat, send, where to read the transcript). Built from the reverse-engineering in the main report.
- `run.js` — orchestrator: fresh cold context per vendor+mode, sends each turn, times reply by transcript growth+stability.

## Conversations & the handover red flag
- Pools are deliberately **complex**: compound, multi-constraint turns that build on prior answers, with objections and edge cases — a demanding shopper, not one-line FAQs.
- **No turn ever asks for a human.** So if the assistant initiates a handover ("I'll connect you with our team", "submit a support ticket", a lead-capture form, "all our agents are unavailable"…), the runner detects it and marks `handover: true` on that turn and `red_flag: true` on the vendor — a real capability limitation (it couldn't handle the conversation / couldn't complete the sale). Genuine answers (e.g. a blunt no-returns policy) are *not* flagged.

## Maintenance note
Chat widgets change their DOM/SDK over time, so `vendors.js` selectors are the part to keep current. Each vendor fails soft (records `null` + an `error`) so one broken widget never aborts the run. Ada is included but its bot was down during initial testing — expect nulls until it recovers.

## Monthly automation
`.github/workflows/monthly-benchmark.yml` runs this on the 1st of each month, commits the JSON results, and (optionally) regenerates the report. Each CI run is a brand-new container → every vendor starts cold by construction.
