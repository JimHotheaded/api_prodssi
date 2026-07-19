// FILETIME tick helpers for seeking the clustered index of dbo.AllEvent.
//
// dbo.AllEvent has NO index on EventTimeStamp — filtering on it alone scans the
// whole table (measured 2026-07-19 at 3.3M rows: 1.3-2.2 s warm, growing
// linearly with table size). The only time-ordered index is the CLUSTERED one
// on TicksTimeStamp (AE_TICKSTIMESTAMP_IDX); a seek on it is 4-5 ms flat.
//
// TicksTimeStamp is the event's true-UTC time as a Windows FILETIME: 100 ns
// ticks since 1601-01-01 UTC. EventTimeStamp is the SAME instant truncated to
// milliseconds (verified 2026-07-19: TicksTimeStamp - ticks(EventTimeStamp) is
// always in [0, 9999] across oldest and newest rows). For millisecond-aligned
// bounds (all JS Dates are) the translation is therefore EXACT, not approximate:
//   EventTimeStamp >= from  <=>  TicksTimeStamp >= toFileTicks(from)
//   EventTimeStamp <= to    <=>  TicksTimeStamp <= toFileTicks(to) + 9999
//
// Tick values exceed Number.MAX_SAFE_INTEGER (~9e15 vs ~1.3e17), so the math is
// BigInt and the value crosses into SQL as a *string* parameter — SQL Server
// implicitly converts the parameter to bigint (bigint outranks nvarchar), the
// column side stays untouched, and the index seek is preserved (verified).
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n; // 1601-01-01 -> 1970-01-01
const MAX_TICKS = '3155378975999999999'; // 9999-12-31 — "no upper bound" sentinel

function toFileTicks(date) {
  return ((BigInt(date.getTime()) + FILETIME_EPOCH_OFFSET_MS) * 10000n).toString();
}

// Optional [fromUtc, toUtc] window (JS Dates or null) -> always-present ticks
// range using 0 / MAX_TICKS sentinels. The sentinels matter: a plain
// `TicksTimeStamp >= @a AND TicksTimeStamp <= @b` predicate seeks, whereas an
// `(@a IS NULL OR ...)` guard forces the optimizer back to a full scan.
function ticksRange(fromUtc, toUtc) {
  return {
    fromTicks: fromUtc ? toFileTicks(fromUtc) : '0',
    toTicks: toUtc ? (BigInt(toFileTicks(toUtc)) + 9999n).toString() : MAX_TICKS,
  };
}

// Relative look-back computed on the API host's clock (same convention as
// timeWindow in index.js; API-vs-SQL clock skew of a few seconds is acceptable
// for hour-granular windows).
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600000);
}

module.exports = { toFileTicks, ticksRange, hoursAgo, MAX_TICKS };
