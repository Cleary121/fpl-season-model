# FPL Season Model — pre-chewer & insights engine

Automated data pipeline for the FPL team **Premier FC** (entry 3509857), season 2026/27.
Fetches the official FPL API on a schedule, boils the ~2MB feed down to a compact
briefing, and publishes it where an AI assistant's simple web reader can consume it.

## The output

**Briefing (markdown, ~20KB):**
`https://raw.githubusercontent.com/Cleary121/fpl-season-model/main/docs/briefing.md`

Sections: alerts (injuries, double/blank gameweeks, league rank move) · squad with
per-player flags · La liga money standings + rival tracker · captaincy ranking ·
model-score top targets per position · DefCon bankers · xGI buy-low/sell-high ·
price watch (incl. changes since last build) · differentials · fixture difficulty.

## Schedule

- Daily 06:00 UTC (fresh data for ad-hoc checks)
- Thursday 15:30 UTC (feeds the weekly Claude report at ~17:00 UTC)
- Manual: Actions tab → "FPL pre-chew" → Run workflow

## Model score v1

`score = form×1.4 (or PPG×1.2 early season) + ep_next×1.6 + min(xGI/90, 1.2)×4 +
min(DefCon90/threshold, 1)×2 + (3.5 − avg FDR next 3)×1.5 − 6 if flagged`

Heuristic, not gospel — tune weights in `scripts/build.mjs`.

## History

Weekly squad/price/rank snapshots are kept in `snapshots/` for trend analysis.
