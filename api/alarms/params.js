// Pure query-param validators for the alarm module — no mssql import, so the
// offline unit test (test/alarm-params-unit.js) can require this file without
// constructing a ConnectionPool.
//
// Rule (matches the spec's smoke tests: limit=9999 -> 400, days=-1 -> 400):
// missing/empty -> default; present but non-integer -> error; out of range ->
// error. Never clamp.

// intParam('42','limit',50,1,500) -> {value:42} | {error:'limit must be 1-500'}
function intParam(raw, name, def, min, max) {
  if (raw === undefined || raw === '') return { value: def };
  // Non-string means Express parsed a repeated/bracketed param into an array/object
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return { error: `${name} must be an integer` };
  const n = parseInt(raw, 10);
  if (n < min || n > max) return { error: `${name} must be ${min}-${max}` };
  return { value: n };
}

// boolParam(raw,'excludeFaults',true): missing -> default; 'false'/'0' -> false;
// 'true'/'1' -> true (case-insensitive); anything else -> {error}
function boolParam(raw, name, def) {
  if (raw === undefined || raw === '') return { value: def };
  if (typeof raw !== 'string') return { error: `${name} must be true or false` };
  const s = raw.toLowerCase();
  if (s === 'false' || s === '0') return { value: false };
  if (s === 'true' || s === '1') return { value: true };
  return { error: `${name} must be true or false` };
}

// dateParam('2026-07-10 08:00:00', 'from', 7) -> {value: Date} | {error}
// Accepts plant wall-clock time 'YYYY-MM-DD HH:mm' with optional ':ss' and
// '.fff' (space or T separator). Returns the corresponding UTC instant as a
// JS Date (input minus tzOffsetHours), ready to compare against the UTC
// EventTimeStamp column. Missing/empty -> {value: null}.
function dateParam(raw, name, tzOffsetHours) {
  if (raw === undefined || raw === '') return { value: null };
  const fmt = `${name} must be plant local time 'YYYY-MM-DD HH:mm:ss' (seconds/millis optional, URL-encode the space as %20)`;
  if (typeof raw !== 'string') return { error: fmt };
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!m) return { error: fmt };
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  const s = m[6] === undefined ? 0 : +m[6];
  const ms = m[7] === undefined ? 0 : +m[7].padEnd(3, '0');
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return { error: fmt };
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return { error: `${name} is not a valid calendar date` };
  }
  return { value: new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - tzOffsetHours * 3600000) };
}

module.exports = { intParam, boolParam, dateParam };
