#!/bin/bash
# ============================================================================
# CAPTURE-ONLY driver — deepens coverage WITHOUT the live auto-refresh.
# Unlike run-benchmark.sh, this does NOT start the http.server and does NOT run
# the gen.js-every-40s regenerator, so report.html stays a STATIC snapshot until
# you explicitly re-run `node gen.js` and redeploy.
#
#   caffeinate -i bash capture-only.sh          # headless (Gorgias + shell vendors)
#   caffeinate -i bash capture-only.sh headed   # ALL vendors, real browser (resumable)
#
# Resumable: RESUME skips any conversation already on disk with turns; 0-turn/failed
# files are retried. One final gen.js bakes the latest data into report.html locally
# (no deploy). Run exactly ONE of these at a time.
# ============================================================================
cd "$(dirname "$0")"
DATE=${RUN_DATE:-2026-07-01}
MODE_ARG="--skip-candidates"
if [ "$1" = "headed" ]; then MODE_ARG='--headed'; fi
echo "▶ CAPTURE-ONLY ($MODE_ARG) — run-date $DATE — static report (no auto-refresh)"

CONC=3; [ "$1" = "headed" ] && CONC=1   # headed=1: the machine (user's Chrome + system) is often loaded; parallel headed browsers deadlock
for i in $(seq 1 200); do
  echo "── pass $i @ $(date +%H:%M:%S) ──"
  OUT=$(TURN_TIMEOUT_MS=70000 RUN_DATE="$DATE" node run.js $MODE_ARG --concurrency $CONC 2>&1)
  echo "$OUT" | grep -E "RESUME|Running [0-9]|✔ \[|Done|ALL DONE" | tail -20
  if echo "$OUT" | grep -q "ALL DONE"; then echo "✅ COMPLETE — every drivable conversation captured."; break; fi
  sleep 3
done
# Bake the latest captures into report.html locally (does NOT deploy).
node gen.js --date "$DATE" >/dev/null 2>&1
echo "Done. Local report refreshed (static). Redeploy manually when ready."
