# Live differential tests

These compare this test copy (`http://localhost:3336`) against the production
API (`http://localhost:3334`) byte-for-byte on identical historical windows.
They require:

- the plant network (SQL Server `192.168.100.100` reachable),
- production running on :3334,
- this repo's server running on :3336 (`node server.js`).

Run with `node test/live/<script>.js`. Exit code 0 = all checks passed.

- `test-count-default-flip.js` — main regression: `/count*` gap fill on by
  default, `&fillGaps=false` byte-identical to production, WL/Hour_OFIL/LC_CSH
  excluded, window routes still opt-in, threshold validation.
- `test-prod-diff.js` — broad endpoint diff vs production (tariff-boundary
  windows).
- `test-24h-diff.js` — full-day (24h) count diff + per-machine gap-fill
  runtime table + tariff bucket integrity. Slow (wide windows).
- `test-plants-perf-diff.js` — regression for the 2026-07-20 performance
  rework (SQL-side `/avg`+`/calCap`, trimmed window/count fetches, parallel
  root listing): every plant's window/avg/count routes byte-compared on fixed
  July 2026 windows, plus edge cases (unknown tag, empty window, missing
  threshold) and untouched WL routes. Only whitelisted diff: `avg`/`cap` may
  differ in the last decimals (compared at relative 1e-9).

Note: `test-prod-diff.js` and `test-24h-diff.js` predate the default flip, so
their default `/count*` comparisons now show expected diffs on gap-affected
machines; add `&fillGaps=false` legs when adapting them. The golden values in
`test-count-default-flip.js` use fixed July 2026 windows and stay valid as
long as the historian retains that data.

- `test-cadence-eras.js` — regression for the per-machine logging-cadence
  eras (`CADENCE_ERAS` in plants.js). **Does not need a candidate server**:
  it starts the app in-process on an ephemeral port, and only needs
  production on :3334 to diff history against. Covers post-changeover
  windows reading a full 1.0 h, pre-changeover windows staying
  byte-identical to production, straddling windows totalling 1.0 h across
  both eras with the boundary row counted exactly once, the
  `&pointsPerHour=`/`&cadence=` force path, `&fillGaps=false`, the
  excluded machines, and the window routes' default fill cadence.

- `test-ofil.js` — the OFIL plant (`REPL_OFIL_LOG`, added 2026-08-13).
  **Needs neither a candidate server nor production**: it starts the app
  in-process and checks against the historian directly. Covers the display
  layer (friendly names, Val ÷100 to Hz, `&threshold=` in Hz, per-row
  conversion on `/all`), the single-era 15s `CADENCE_ERAS` entry (a full hour
  reads 1.0 h, divides by 240), `&fillGaps=false` / `&pointsPerHour=360` /
  `&cadence=` overrides, and the usual edge cases (missing threshold, unknown
  tag, window predating the database). OFIL is deliberately **not** in the
  other scripts' plant lists — they diff against production on :3334, which
  404s on OFIL until it runs this code.

- `test-silo.js` — the Silo plant (`REPL_Silo_LOG`, added 2026-08-14).
  **Needs neither a candidate server nor production**, same in-process pattern
  as `test-ofil.js`. Covers the 60s single-era `CADENCE_ERAS` entry (a full
  hour reads 1.0 h, divides by 60 — the 360 fallback would read 0.1667), the
  `&fillGaps=false` / `&pointsPerHour=` / `&cadence=` overrides, and the usual
  edge cases. It also pins the rename-only display layer: all 28 plant names
  asserted verbatim, no raw historian fragment (`SiemensOPC`, `PLC_Ofil`,
  `Coating7_Con`, …) anywhere on the wire, and values byte-identical to the
  historian (divisor 1 everywhere). Same :3334 caveat as OFIL — deliberately
  not in the other scripts' plant lists.

- `test-csh-display.js` — the CSH display layer (added 2026-09-01).
  **Needs neither a candidate server nor production**, same in-process pattern
  as `test-silo.js`. CSH is the first *partial* entry in `api/tagDisplay.js`:
  only tags 8 (`Grizzly_Hz`) and 19 (`Screen_Hz`) — ÷100 to Hz — and 20
  (`Hopper_level`, rename-only) are mapped. The script pins both halves: the
  three mapped tags are renamed and converted on every route (tag list, `/all`,
  latest, window including gap-filled synthetic rows, `/avg`, `countCSH`), and
  a sample of **unmapped** tags stays byte-identical to a direct SQL read in
  both name and value — a regression that scaled the whole plant would pass the
  first half and fail the second. Also checks `countCSH&threshold=` is in Hz for
  tag 19 (30 counts what raw 3000 counts), that the 15s era still reads 1.0 h
  from 240 samples, and the usual edge cases.

Note: adding CSH to the display layer makes **`test-plants-perf-diff.js` report
one diff** — `byteEqual('/plants/')`, because the root listing now carries the
renamed CSH tags. Its per-plant window/avg/count checks use `tags[0].TagIndex`
= 0 for CSH, which is unmapped and therefore unaffected. The diff disappears
once :3334 runs this code. `test-prod-diff.js`, `test-24h-diff.js` and
`test-count-default-flip.js` all use tagIndex 0 for CSH and are unaffected.
`test-full-endpoint-diff.js` *is* affected (it hits the CSH tag list, `/all` and
the last tag's latest value) and handles it through the shared display
transform, which is now driven by `DISPLAY_PLANTS = ['RRM','CSH']`.

Logging cadence changed 10s → 15s for the whole plant on 2026-08-06
(each machine between 11:27:15 and 11:31:28), and for RMM1 a month
earlier on 2026-07-09 09:18:12. Count routes era-split at those instants
automatically. When diffing against a server built before the era-split,
`count*` rows differ on post-changeover and spanning windows **by design**
— those are the values being corrected (a full hour of 15s logging read
0.6667 h under the old fixed 360 divisor). Windows wholly inside one era
must stay byte-identical; the one intended exception is `countRMM1`,
whose single-era audit block changes from the nested `eras[]` wrapper to
the flat `{cadenceS, capS, tolerance}` every other plant uses.

The offline unit test (`node test/fillgaps-unit.js`, also `npm test`) needs
no network or database.
