# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only Express REST API that exposes SCADA historian data from a SQL Server (`192.168.100.100`, config in `config.js`) for a manufacturing plant. Data originates from Kepware/FactoryTalk tag logging at ~10s cadence into per-machine `REPL_*` databases.

**This repo went live on 2026-07-09** as the production API on port 3334 (overridable via `PORT`), serving Node-RED dashboards and other consumers at `http://172.30.1.112:3334`. It replaced the previous production copy after a full endpoint differential (`test/live/test-full-endpoint-diff.js`) showed byte-identical behavior except the deliberate improvements (gap-filled `count*` defaults, BM2_con `/avg` fix, threshold 400). To test risky changes side by side again, run a second copy with `PORT=3336 node server.js`.

## Running

```
node server.js
```

`npm test` runs the offline unit suite (`test/fillgaps-unit.js` — no network/DB needed). `test/live/` holds differential tests that byte-compare a candidate copy on :3336 against the running production server on :3334 on fixed historical windows; they need the plant network and both servers up (see `test/live/README.md`). They were written for the 2026-07-09 go-live (old production on :3334); to reuse them for a future change, run the new candidate on :3336 and re-check the whitelisted expected diffs. No lint, no build step. Fresh clone: `npm install`, then copy `config.example.js` to `config.js` and fill in credentials (or set `DB_USER`/`DB_PASSWORD`/`DB_SERVER` env vars).

## Architecture

- `server.js` → `app.js` → mounts `api/routes/plants.js` at `/plants` (the only route file).
- `config.js` (gitignored; template in `config.example.js`) exports `{dbConfig_PROD}` — a single shared `mssql` pool config (pool created once at the top of `plants.js`). Credentials come from `DB_USER`/`DB_PASSWORD`/`DB_SERVER` env vars with hardcoded fallbacks.
- `utils.js` — shared aggregation helpers (`findMax`, `findMin`, `calculateAverage`, `countValues`, `countValuesHour`, `calCap`, `isHoliday`/`isHolidayUTC`, `fillGaps` and friends) plus a hardcoded Thai holiday list (2025–2027) that needs annual updating (2027 carries a TODO to re-verify against the Cabinet announcement).

### plants.js route pattern (the big picture)

`plants.js` (~2000 lines) is one repeated block per machine/plant, copy-pasted ~15 times. Each plant (e.g. `BM2`, `BM2_con`, `CT6_con`, `CT6_heater`, `CT7_con`, `CT7_heater`, `CSH`, `FeedRaw`, `HYD`, `RMM1`, `RMM2`, `RRM`, `LC_CSH`, `Hour_OFIL`, `WL`) maps to its own database + tag/float table pair (e.g. `[REPL_BallMill_Log].[dbo].[TagBallMill]` / `[FloatBallMill]`) and gets the same 6 routes:

- `GET /plants/{plant}` — list tags (TagName/TagIndex)
- `GET /plants/{plant}/all` — top 1000 raw rows
- `GET /plants/{plant}/:tagIndex` — latest value for a tag
- `GET /plants/{plant}/:tagIndex/:tbf/:taf` — raw rows in a time window (`tbf`/`taf` = time before/after, format `2024-07-01 00:00:00.000`, URL-encoded)
- `GET /plants/{plant}/:tagIndex/:tbf/:taf/avg` — min/max/avg computed in JS from the fetched rows
- `GET /plants/count{plant}?tagIndex=&tbf=&taf=&threshold=` — counts samples above threshold, converts to run-hours (÷360 samples/hour), and splits hours into tariff buckets A/B/C/D (weekday/holiday × time-of-day, Asia/Bangkok via `tzOffsetMinutes: -420`) using `countValuesHour` + `isHoliday`

`WL` (wheel loader weights) deviates from the pattern: pivot queries, `/sum`, `/datacal`. `GET /plants/` is self-documenting — it returns usage examples plus every plant's tag list.

When adding a new plant, copy an existing block, swap the database/table/column names (each DB uses differently-named tag tables — check the `/` route at the top of plants.js for the exact names), and add it to the root `/` listing. When fixing a bug in one plant's route, check whether the same copy-paste bug exists in all the other blocks (this has happened before, e.g. `TagIndex <> 'E'` instead of `Status <> 'E'` in the BM2_con avg route).

### Data-quality context

Kepware periodically reconnects, leaving 10–30s logging gaps in the historian that can look like machine downtime. `2026-07-07-fillgap-kepware-gaps.md` (repo root) documents the bounded, bracket-checked gap-fill algorithm — read it before doing anything with gap/downtime/uptime calculations.

Implemented 2026-07-07: `fillGaps`/`applyFillGaps` live in `utils.js`, wired into 13 of the standard `/{plant}/:tagIndex/:tbf/:taf` window routes as an opt-in `?fillGaps=true&cadence=10&cap=90&tolerance=0.2` query param. Without the param the raw array passes through byte-identical; with it the response becomes `{fillGapsOptions, totalReadings, filledReadings, flaggedGaps, readings}` (chronological, synthetic rows marked `Filled:true`). On the `count{plant}` routes gap fill is **on by default** (changed 2026-07-09): gaps are bridged *before* counting, so run-hours aren't undercounted by logging blips, and a `fillGaps` audit block (`realReadings`/`filledReadings`/`flaggedGaps`) is appended to the response. Pass `?fillGaps=false` (the `fillGap` spelling also works) for the legacy raw count, byte-identical to the pre-2026-07-09 production behavior. The gate lives in `fillGapsForCount` in `utils.js`. Deliberately NOT wired to **WL** (event data — filling would fabricate weighing cycles), **Hour_OFIL** (cumulative counters — holding a counter flat understates it), or **countLC_CSH** (on-change logging, no cadence to fill against); these ignore the param everywhere. (LC_CSH's *window* route still honors opt-in `?fillGaps=true` if a caller insists, but the values are not meaningful.) Callers must pass `cadence` matching the tag's real logging rate. **LC_CSH logs on-change with no fixed cadence** (measured intervals 1–56s) — neither `fillGaps` nor sample-count run-hours are meaningful for it; a time-weighted calculation would be needed instead.

## Gotchas

- Queries use `mssql` tagged-template literals (`` pool.request().query`...${param}...` ``), which parameterize inputs — keep that form; don't switch to string concatenation.
- All rows are fetched into Node and aggregated in JS (not SQL `AVG`/`COUNT`), so wide time windows are memory/latency heavy — that's why `requestTimeout` is 60s.
- Run-hour math in `count{plant}` routes defaults to 360 points/hour (10s cadence); callers override with `&pointsPerHour=` for other fixed cadences (Hour_OFIL 60s ⇒ 60). The default is intentionally kept at 360 — even where it's physically wrong — so existing downstream consumers see unchanged values. LC_CSH has no fixed cadence (on-change logging), so its count-based `hour` values are meaningless with any parameter.
- **RMM1 logs at 15s since 2026-07-09 09:18:12 plant time** (Kepware interval changed as a test; was 10s). `countRMM1` handles this **automatically**: the changeover instant is hardcoded as `RMM1_CADENCE_CHANGE` in plants.js and the route era-splits the window, computing each side with its own cadence (360/10s before, 240/15s after) and merging count/hour/distHour/fillGaps — old, new, and spanning windows are all correct with no query parameters. Passing `&pointsPerHour=` or `&cadence=` forces single-era math over the whole window (old workaround still honored). The RMM1 *window* route's opt-in fill defaults to cadence 15 (no era-split — raw rows are cadence-independent). If Kepware is rolled back to 10s, add/adjust the era boundary in `RMM1_ERAS` rather than deleting the mechanism — history logged at 15s stays 15s forever.
- Timestamps: the DB stores naive Bangkok-local datetimes; the mssql driver (default `useUTC`) parses them as UTC, so JSON responses show local wall-clock time with a fake `Z` suffix. **This is intentional wire format — downstream apps depend on it; do not "fix" it by setting `useUTC:false`.** Internally, tariff bucketing reads the Date's UTC fields (`clock:'utc'` + `isHolidayUTC` in `utils.js`), which yields plant-local time on any server OS timezone.
- `count{plant}` routes return 400 if `threshold` is missing or non-numeric (previously they silently returned count 0).
- `count{plant}` responses are gap-filled by default, so their `count`/`hour`/`distHour` values intentionally sit higher than the pre-2026-07-09 numbers wherever logging gaps exist; `&fillGaps=false` reproduces the old behavior exactly. The window routes are unaffected — there `fillGaps` remains opt-in.
