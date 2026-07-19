// Unit tests for the alarm module's FILETIME tick helpers. Offline — requires
// only api/alarms/ticks.js (no mssql, no pool construction).
const { toFileTicks, ticksRange, hoursAgo, MAX_TICKS } = require('../api/alarms/ticks');

let failed = 0;
function check(name, cond) {
  if (!cond) { failed++; console.log(`FAIL  ${name}`); }
  else console.log(`ok    ${name}`);
}

// Known FILETIME anchors
check('FILETIME epoch (1601-01-01) -> 0',
  toFileTicks(new Date('1601-01-01T00:00:00.000Z')) === '0');
check('Unix epoch (1970-01-01) -> 116444736000000000 (well-known constant)',
  toFileTicks(new Date(0)) === '116444736000000000');
// Cross-checked against a live row 2026-07-19: TicksTimeStamp 134289270970208139
// with EventTimeStamp 2026-07-19T09:31:37.020Z (delta 8139 ticks = sub-ms part)
check('live-row anchor: 2026-07-19T09:31:37.020Z -> 134289270970200000',
  toFileTicks(new Date('2026-07-19T09:31:37.020Z')) === '134289270970200000');

// Precision: values are far beyond Number.MAX_SAFE_INTEGER — 1 ms must move
// the result by exactly 10000 ticks (floating-point math would drift here)
const a = BigInt(toFileTicks(new Date('2026-07-19T09:31:37.020Z')));
const b = BigInt(toFileTicks(new Date('2026-07-19T09:31:37.021Z')));
check('1 ms step = exactly 10000 ticks (BigInt precision)', b - a === 10000n);

// ticksRange sentinels and bounds
check('range: both null -> 0..MAX sentinels', (() => {
  const r = ticksRange(null, null);
  return r.fromTicks === '0' && r.toTicks === MAX_TICKS;
})());
check('range: from only -> exact lower, MAX upper', (() => {
  const r = ticksRange(new Date(0), null);
  return r.fromTicks === '116444736000000000' && r.toTicks === MAX_TICKS;
})());
// Upper bound must include the whole millisecond of `to` (EventTimeStamp is
// TicksTimeStamp truncated to ms, so a row stamped exactly `to` can carry up
// to 9999 extra ticks)
check('range: to gets +9999 ticks for ms truncation', (() => {
  const r = ticksRange(null, new Date(0));
  return r.toTicks === '116444736000009999';
})());

// hoursAgo sanity (loose window to survive slow CI)
const h = hoursAgo(1).getTime();
check('hoursAgo(1) is ~1h before now', Math.abs(Date.now() - 3600000 - h) < 5000);

console.log(failed === 0 ? '\nAll alarm-ticks checks passed' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
