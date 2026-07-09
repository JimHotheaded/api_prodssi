// Unit tests for fillGaps/applyFillGaps — the 4 self-test cases from
// 2026-07-07-fillgap-kepware-gaps.md plus wrapper-behavior checks.
const { fillGaps, applyFillGaps } = require('../utils');

let failed = 0;
function check(name, cond) {
  if (!cond) { failed++; console.log(`FAIL  ${name}`); }
  else console.log(`ok    ${name}`);
}

const t = (offsetS) => new Date(Date.parse("2026-01-01T00:00:00Z") + offsetS * 1000).toISOString();

// Doc case 1: clean cadence — nothing filled, nothing flagged
const r1 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(10), Val: 100 }]);
check('case1 clean cadence', r1.readings.length === 2 && r1.flaggedGaps.length === 0);

// Doc case 2: bridgeable 20s gap — one synthetic row, Filled:true
const r2 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(20), Val: 100 }]);
check('case2 bridgeable gap', r2.readings.length === 3 && r2.readings[1].Filled === true && r2.flaggedGaps.length === 0);

// Doc case 3: 200s gap exceeds 90s cap — flagged, not filled
const r3 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(200), Val: 100 }]);
check('case3 over cap', r3.readings.length === 2 && r3.flaggedGaps.length === 1 && r3.flaggedGaps[0].reason === "exceeds cap");

// Doc case 4: bracket mismatch (100 -> 0) — flagged, not filled
const r4 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(20), Val: 0 }]);
check('case4 value mismatch', r4.readings.length === 2 && r4.flaggedGaps.length === 1 && r4.flaggedGaps[0].reason === "value mismatch across gap");

// Synthetic rows inherit tag fields
const r5 = fillGaps([{ DateAndTime: t(0), Val: 5, TagIndex: 3, TagName: 'X' }, { DateAndTime: t(30), Val: 5, TagIndex: 3, TagName: 'X' }]);
check('synthetic rows keep TagIndex/TagName', r5.readings.length === 4 && r5.readings[1].TagIndex === 3 && r5.readings[1].TagName === 'X' && r5.readings[2].Filled === true);

// Works with Date objects (mssql returns Dates, not strings)
const r6 = fillGaps([{ DateAndTime: new Date(Date.parse(t(0))), Val: 7 }, { DateAndTime: new Date(Date.parse(t(20))), Val: 7 }]);
check('accepts Date objects', r6.readings.length === 3 && r6.readings[1].Filled === true);

// DESC input (like the SQL routes produce) gets sorted chronologically
const r7 = fillGaps([{ DateAndTime: t(20), Val: 1 }, { DateAndTime: t(0), Val: 1 }]);
check('DESC input sorted + filled', r7.readings.length === 3 && new Date(r7.readings[0].DateAndTime) < new Date(r7.readings[2].DateAndTime));

// Custom cadence: 60s data with cadence=60 sees no gap
const r8 = fillGaps([{ DateAndTime: t(0), Val: 9 }, { DateAndTime: t(60), Val: 9 }], { cadenceS: 60 });
check('cadence=60 no false gaps', r8.readings.length === 2 && r8.flaggedGaps.length === 0);

// applyFillGaps: passthrough without the param (must be the SAME array back)
const raw = [{ DateAndTime: t(0), Val: 1 }, { DateAndTime: t(20), Val: 1 }];
check('wrapper passthrough (no param)', applyFillGaps(raw, {}) === raw);
check('wrapper passthrough (fillGaps=false)', applyFillGaps(raw, { fillGaps: 'false' }) === raw);

// applyFillGaps: active shape
const w = applyFillGaps(raw, { fillGaps: 'true' });
check('wrapper active shape', w.totalReadings === 3 && w.filledReadings === 1 && Array.isArray(w.flaggedGaps) && w.fillGapsOptions.capS === 90);

// applyFillGaps: param overrides (cap=15 makes the 20s gap unfillable)
const w2 = applyFillGaps(raw, { fillGaps: 'true', cap: '15' });
check('wrapper cap override flags gap', w2.filledReadings === 0 && w2.flaggedGaps.length === 1);

// applyFillGaps: garbage params fall back to defaults
const w3 = applyFillGaps(raw, { fillGaps: 'true', cadence: 'abc', cap: '-5', tolerance: 'x' });
check('garbage params -> defaults', w3.fillGapsOptions.cadenceS === 10 && w3.fillGapsOptions.capS === 90 && w3.fillGapsOptions.tolerance === 0.2);

// tolerance=0 is respected (not replaced by default)
const w4 = applyFillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(20), Val: 100.0001 }], { fillGaps: 'true', tolerance: '0' });
check('tolerance=0 honored', w4.fillGapsOptions.tolerance === 0 && w4.flaggedGaps.length === 1);

console.log(failed === 0 ? '\nALL UNIT TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
