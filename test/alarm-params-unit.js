// Unit tests for the alarm module's param validators. Offline — requires only
// api/alarms/params.js (no mssql, no pool construction).
const { intParam, boolParam, dateParam, conditionPattern } = require('../api/alarms/params');

let failed = 0;
function check(name, cond) {
  if (!cond) { failed++; console.log(`FAIL  ${name}`); }
  else console.log(`ok    ${name}`);
}

// intParam: defaults
check('missing -> default', intParam(undefined, 'limit', 50, 1, 5000).value === 50);
check('empty -> default', intParam('', 'limit', 50, 1, 5000).value === 50);
check('missing -> null default (optional param)', intParam(undefined, 'hours', null, 1, 720).value === null);

// intParam: valid values and boundaries
check('valid value', intParam('42', 'limit', 50, 1, 5000).value === 42);
check('min boundary accepted', intParam('1', 'limit', 50, 1, 5000).value === 1);
check('max boundary accepted', intParam('5000', 'limit', 50, 1, 5000).value === 5000);

// intParam: out of range -> error (never clamp)
check('below min -> error', intParam('0', 'limit', 50, 1, 5000).error === 'limit must be 1-5000');
check('above max -> error', intParam('5001', 'limit', 50, 1, 5000).error === 'limit must be 1-5000');
check('9999 -> error (spec smoke test)', intParam('9999', 'limit', 50, 1, 5000).error === 'limit must be 1-5000');
check('-1 days -> error (spec smoke test)', intParam('-1', 'days', 14, 1, 90).error === 'days must be 1-90');
check('91 days -> error', intParam('91', 'days', 14, 1, 90).error === 'days must be 1-90');

// intParam: non-integer -> error
check('non-numeric -> error', intParam('abc', 'limit', 50, 1, 5000).error === 'limit must be an integer');
check('float -> error', intParam('1.5', 'limit', 50, 1, 5000).error === 'limit must be an integer');
check('trailing junk -> error', intParam('10x', 'limit', 50, 1, 5000).error === 'limit must be an integer');
check('negative integer parses (then range check)', intParam('-5', 'hours', 24, 1, 720).error === 'hours must be 1-720');
check('array input -> error', intParam(['1', '2'], 'limit', 50, 1, 5000).error === 'limit must be an integer');

// boolParam
check('bool missing -> default true', boolParam(undefined, 'excludeFaults', true).value === true);
check('bool empty -> default', boolParam('', 'excludeFaults', true).value === true);
check("'false' -> false", boolParam('false', 'excludeFaults', true).value === false);
check("'0' -> false", boolParam('0', 'excludeFaults', true).value === false);
check("'FALSE' -> false (case-insensitive)", boolParam('FALSE', 'excludeFaults', true).value === false);
check("'true' -> true", boolParam('true', 'excludeFaults', false).value === true);
check("'1' -> true", boolParam('1', 'excludeFaults', false).value === true);
check("'yes' -> error", boolParam('yes', 'excludeFaults', true).error === 'excludeFaults must be true or false');
check('bool array input -> error', boolParam(['true'], 'excludeFaults', true).error === 'excludeFaults must be true or false');
check('bool missing -> null default (optional tri-state)', boolParam(undefined, 'acked', null).value === null);

// dateParam (plant local -> UTC instant)
check('date missing -> null', dateParam(undefined, 'from', 7).value === null);
check('date empty -> null', dateParam('', 'from', 7).value === null);
check('plant 08:00 -> 01:00 UTC', dateParam('2026-07-10 08:00:00', 'from', 7).value.toISOString() === '2026-07-10T01:00:00.000Z');
check('T separator accepted', dateParam('2026-07-10T08:00:00', 'from', 7).value.toISOString() === '2026-07-10T01:00:00.000Z');
check('seconds optional', dateParam('2026-07-10 08:00', 'from', 7).value.toISOString() === '2026-07-10T01:00:00.000Z');
check('millis accepted', dateParam('2026-07-10 08:00:00.500', 'from', 7).value.toISOString() === '2026-07-10T01:00:00.500Z');
check('midnight crosses date line', dateParam('2026-07-10 00:30:00', 'from', 7).value.toISOString() === '2026-07-09T17:30:00.000Z');
check('garbage -> error', dateParam('yesterday', 'from', 7).error !== undefined);
check('bad month -> error', dateParam('2026-13-01 00:00:00', 'from', 7).error !== undefined);
check('Feb 30 -> error', dateParam('2026-02-30 00:00:00', 'from', 7).error !== undefined);
check('bad hour -> error', dateParam('2026-07-10 24:00:00', 'from', 7).error !== undefined);
check('date-only -> error (time required)', dateParam('2026-07-10', 'from', 7).error !== undefined);
check('array -> error', dateParam(['2026-07-10 08:00:00'], 'from', 7).error !== undefined);

// conditionPattern (family LIKE pattern: TRIP -> matches TRIP_L, not TRIPLE)
check("TRIP -> 'TRIP[_]%'", conditionPattern('TRIP') === 'TRIP[_]%');
check("TRIP_L escapes its own underscore -> 'TRIP[_]L[_]%'",
  conditionPattern('TRIP_L') === 'TRIP[_]L[_]%');
check("'%' is bracket-escaped, not a wildcard", conditionPattern('%') === '[%][_]%');
check("'[' is bracket-escaped", conditionPattern('A[B') === 'A[[]B[_]%');

console.log(failed === 0 ? '\nAll alarm-param checks passed' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
