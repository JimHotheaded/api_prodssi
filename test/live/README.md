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

Note: `test-prod-diff.js` and `test-24h-diff.js` predate the default flip, so
their default `/count*` comparisons now show expected diffs on gap-affected
machines; add `&fillGaps=false` legs when adapting them. The golden values in
`test-count-default-flip.js` use fixed July 2026 windows and stay valid as
long as the historian retains that data.

The offline unit test (`node test/fillgaps-unit.js`, also `npm test`) needs
no network or database.
