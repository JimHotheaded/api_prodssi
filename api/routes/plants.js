const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { findMax, findMin, calculateAverage, returnTagName, countValues, calSum, calCap, countValuesHour, countValuesHourFine, isHolidayUTC, applyFillGaps, fillGapsForCount, holidays } = require('../../utils');
const {dbConfig_PROD} = require('../../config');
// Friendly tag names + engineering-unit scaling on the way out (RRM only today).
const { displayName, divisorFor, scaleValue, presentRows, presentTagList, presentWindow } = require('../tagDisplay');

const pool = new sql.ConnectionPool(dbConfig_PROD);
const poolConnect = pool.connect();

// Comma-joined for the SQL-side count{plant} routes' STRING_SPLIT holiday lookup
// (same list utils.js's isHoliday/isHolidayUTC already use for the JS-side routes).
const HOLIDAYS_CSV = holidays.join(',');

// SQL-side replacement for the fetch-all-rows-into-JS pipeline
// (fillGapsForCount + countValues + countValuesHour + countValuesHourFine).
// Gap-fill (bounded, bracket-checked hold-last-value — see
// 2026-07-07-fillgap-kepware-gaps.md) and TOU/holiday bucketing both run in
// SQL via a temp table + window functions, instead of Node fetching every row
// and reducing in JS. This is what lets N concurrent machine requests actually
// run in parallel (SQL Server can use multiple cores; Node's JS thread can't).
//
// Boundary inclusivity in the CASE expressions deliberately mirrors utils.js's
// bucketOf functions exactly (A: 9<=h<=22, C/holiday_day: 6<=h<=18) — verified
// byte-identical against the JS routes via differential testing before this
// was wired into any live route.
//
// opts: { floatTable, tagTable, tagIndex, tbf, taf, threshold, pointsPerHour,
//         query (req.query, for cadence/cap/tolerance/fillGaps overrides) }
async function runCountQuerySql(pool, opts) {
  const { floatTable, tagTable, tagIndex, tbf, taf, threshold, pointsPerHour, query } = opts;

  const num = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
  const cadence = num(query.cadence, 10);
  const capS = num(query.cap, 90);
  const tolerance = Number(query.tolerance) >= 0 ? Number(query.tolerance) : 0.2;
  const fillFlag = query.fillGaps !== undefined ? query.fillGaps : query.fillGap;
  const doFill = String(fillFlag) === 'false' ? 0 : 1;

  const tagQ = await pool.request()
    .input('tagIndex', tagIndex)
    .query(`SELECT TagName FROM ${tagTable} WHERE TagIndex = @tagIndex`);
  const tagExists = tagQ.recordset.length > 0 ? 1 : 0;

  const batch = `
SELECT DateAndTime, Val, CAST(0 AS BIT) AS Filled,
       LAG(DateAndTime) OVER (ORDER BY DateAndTime) AS prevTime,
       LAG(Val)         OVER (ORDER BY DateAndTime) AS prevVal
INTO #ordered
FROM ${floatTable}
WHERE DateAndTime BETWEEN @tbf AND @taf
  AND TagIndex = @tagIndex
  AND Status <> 'E'
  AND @tagExists = 1;

;WITH gaps AS (
  SELECT prevTime, prevVal, DateAndTime AS curTime, Val AS curVal,
         DATEDIFF(MILLISECOND, prevTime, DateAndTime) AS gapMs
  FROM #ordered
  WHERE Filled = 0 AND prevTime IS NOT NULL
    AND DATEDIFF(MILLISECOND, prevTime, DateAndTime) > @cadence * 1500
    AND @doFill = 1
),
bridgeable AS (
  SELECT * FROM gaps
  WHERE gapMs <= @capS * 1000
    AND ABS(prevVal - curVal) <= @tolerance * (SELECT MAX(v) FROM (VALUES (ABS(prevVal)),(ABS(curVal)),(0.000001)) AS x(v))
),
tally(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM tally WHERE n < 200
),
synthetic AS (
  SELECT DATEADD(MILLISECOND, CAST(t.n * @cadence * 1000 AS INT), g.prevTime) AS DateAndTime, g.prevVal AS Val
  FROM bridgeable g JOIN tally t ON t.n * @cadence * 1000 < g.gapMs
)
INSERT INTO #ordered (DateAndTime, Val, Filled, prevTime, prevVal)
SELECT DateAndTime, Val, 1, NULL, NULL FROM synthetic
OPTION (MAXRECURSION 200);

;WITH gaps AS (
  SELECT prevTime, prevVal, DateAndTime AS curTime, Val AS curVal,
         DATEDIFF(MILLISECOND, prevTime, DateAndTime) AS gapMs
  FROM #ordered
  WHERE Filled = 0 AND prevTime IS NOT NULL
    AND DATEDIFF(MILLISECOND, prevTime, DateAndTime) > @cadence * 1500
    AND @doFill = 1
)
SELECT prevTime AS [from], curTime AS [to], gapMs / 1000.0 AS gap_s,
  CASE WHEN gapMs > @capS * 1000 THEN 'exceeds cap' ELSE 'value mismatch across gap' END AS reason
FROM gaps
WHERE NOT (gapMs <= @capS * 1000 AND ABS(prevVal - curVal) <= @tolerance * (SELECT MAX(v) FROM (VALUES (ABS(prevVal)),(ABS(curVal)),(0.000001)) AS x(v)))
ORDER BY prevTime;

SELECT
  COUNT(*) AS totalReadings,
  ISNULL(SUM(CASE WHEN Filled = 1 THEN 1 ELSE 0 END), 0) AS filledReadings
FROM #ordered;

-- Materialize the holiday list once into an indexed temp table instead of
-- checking membership via STRING_SPLIT inline per row: profiling showed the
-- inline form re-evaluates the split/scan per row per referencing SUM (8x),
-- turning a 400K-row aggregate into ~4s instead of ~0.3s.
SELECT CONVERT(date, value) AS d INTO #holidaySet FROM STRING_SPLIT(@holidays, ',');
CREATE UNIQUE CLUSTERED INDEX IX_holidaySet ON #holidaySet(d);

SELECT
  ISNULL(COUNT(*), 0) AS cnt,
  ISNULL(SUM(CASE WHEN isHol = 1 AND hourDec >= 6  AND hourDec <= 18 THEN 1 ELSE 0 END), 0) AS holiday_day,
  ISNULL(SUM(CASE WHEN isHol = 1 AND NOT (hourDec >= 6 AND hourDec <= 18) THEN 1 ELSE 0 END), 0) AS holiday_night,
  ISNULL(SUM(CASE WHEN isHol = 0 AND hourDec < 6 THEN 1 ELSE 0 END), 0) AS offpeak_ns1,
  ISNULL(SUM(CASE WHEN isHol = 0 AND hourDec >= 6  AND hourDec < 9  THEN 1 ELSE 0 END), 0) AS offpeak_solar,
  ISNULL(SUM(CASE WHEN isHol = 0 AND hourDec >= 9  AND hourDec < 18 THEN 1 ELSE 0 END), 0) AS onpeak_solar,
  ISNULL(SUM(CASE WHEN isHol = 0 AND hourDec >= 18 AND hourDec <= 22 THEN 1 ELSE 0 END), 0) AS onpeak_ns,
  ISNULL(SUM(CASE WHEN isHol = 0 AND hourDec > 22 THEN 1 ELSE 0 END), 0) AS offpeak_ns2
FROM (
  SELECT o.*,
    CASE WHEN ((DATEDIFF(DAY, '19000107', o.DateAndTime)) % 7) IN (0, 6) OR h.d IS NOT NULL THEN 1 ELSE 0 END AS isHol,
    DATEPART(HOUR, o.DateAndTime) + DATEPART(MINUTE, o.DateAndTime) / 60.0 + DATEPART(SECOND, o.DateAndTime) / 3600.0 AS hourDec
  FROM #ordered o
  LEFT JOIN #holidaySet h ON h.d = CONVERT(date, o.DateAndTime)
  WHERE o.Val > @threshold
) c;

DROP TABLE #ordered;
DROP TABLE #holidaySet;
`;

  // Explicit sql.Float typing on the numeric params: mssql's automatic type
  // inference picks sql.Int for whole-number JS Numbers, and @capS/@cadence
  // get multiplied by 1000 in the query — an oversized ?cap= override (seen
  // during differential testing) then overflows SQL's int range mid-query.
  const result = await pool.request()
    .input('tbf', tbf)
    .input('taf', taf)
    .input('tagIndex', tagIndex)
    .input('tagExists', tagExists)
    .input('threshold', sql.Float, threshold)
    .input('cadence', sql.Float, cadence)
    .input('capS', sql.Float, capS)
    .input('tolerance', sql.Float, tolerance)
    .input('doFill', doFill)
    .input('holidays', HOLIDAYS_CSV)
    .query(batch);

  const [flaggedRows, countsRows, aggRows] = result.recordsets;
  const totalReadings = countsRows[0].totalReadings;
  const filledReadings = countsRows[0].filledReadings;
  const realReadings = totalReadings - filledReadings;
  const agg = aggRows[0];

  const tagName = realReadings === 0 ? null : tagQ.recordset[0].TagName;
  const count = agg.cnt;
  const hour = count / pointsPerHour;
  const distHour = {
    A: (agg.onpeak_solar + agg.onpeak_ns) / pointsPerHour,
    B: (agg.offpeak_ns1 + agg.offpeak_solar + agg.offpeak_ns2) / pointsPerHour,
    C: agg.holiday_day / pointsPerHour,
    D: agg.holiday_night / pointsPerHour,
    total: count / pointsPerHour,
  };
  const distHourFine = {
    offpeak_ns1: agg.offpeak_ns1 / pointsPerHour,
    offpeak_solar: agg.offpeak_solar / pointsPerHour,
    onpeak_solar: agg.onpeak_solar / pointsPerHour,
    onpeak_ns: agg.onpeak_ns / pointsPerHour,
    offpeak_ns2: agg.offpeak_ns2 / pointsPerHour,
    holiday_day: agg.holiday_day / pointsPerHour,
    holiday_night: agg.holiday_night / pointsPerHour,
    total: count / pointsPerHour,
  };
  const fillGapsMeta = doFill === 1 ? {
    fillGapsOptions: { cadenceS: cadence, capS, tolerance },
    realReadings,
    filledReadings,
    flaggedGaps: flaggedRows.map(r => ({
      from: r.from, to: r.to, gap_s: r.gap_s, reason: r.reason,
    })),
  } : null;

  // realReadings exposed regardless of doFill so the era-split merge can tell
  // whether this era had any raw rows at all — an era with none contributes
  // nothing and gets no entry in the fillGaps audit block.
  return { tagName, count, hour, distHour, distHourFine, fillGapsMeta, realReadings };
}

/* ------------------------- Kepware log-interval eras -------------------------

Run-hours are sample counts divided by samples-per-hour, so a machine whose
logging interval changes needs a different divisor either side of the change —
and the historian keeps both cadences forever, so no single divisor is ever
right for a window that spans one. Each count{plant} route therefore splits its
window at the boundaries below and computes each era with its own cadence,
which is why callers need no query parameters for old, new, or spanning windows.

A boundary is the timestamp of the **last row logged at the old cadence**: era
n ends at (and includes) it, era n+1 starts just after. Values were measured
from the historian and verified per machine — every tag inside a database flips
at the same instant, with the same signature each time (steady old cadence, a
short Kepware reconnect burst of a few seconds, then steady new cadence).

To record a future interval change: append an era here (close the previous one
with the same timestamp) and change nothing else. Never delete or edit a past
era — history logged at 10s stays 10s forever, and dropping an era silently
corrupts every historical query. Machines absent from this table have no cadence
history to split: Hour_OFIL logs at 60s (callers pass &pointsPerHour=60), LC_CSH
logs on change with no fixed cadence, and WL is event data.

A machine that has only ever logged at one interval still belongs here, as a
single boundary-less era — the fallback for an absent machine is 10s/360, which
would report two thirds of the real run-hours for anything logging at 15s, and
one sixth of them for anything logging at 60s.

The 2026-08-06 entries are the plant-wide 10s -> 15s change; RMM1 changed
earlier, on 2026-07-09, when it was switched over on its own as a test.
Timestamps use the same plant-local "fake Z" wire convention as the rest of
this file (see the timestamp note in CLAUDE.md).                             */

const CADENCE_ERAS = (() => {
  const CHANGE_2026_08_06 = {
    BM2_con:    '2026-08-06T11:27:15.000Z',
    BM2:        '2026-08-06T11:27:25.000Z',
    CT6_con:    '2026-08-06T11:28:05.000Z',
    CT6_heater: '2026-08-06T11:29:24.000Z',
    CT7_con:    '2026-08-06T11:30:05.000Z',
    CT7_heater: '2026-08-06T11:30:16.000Z',
    CSH:        '2026-08-06T11:30:24.000Z',
    FeedRaw:    '2026-08-06T11:30:36.000Z',
    HYD:        '2026-08-06T11:30:56.000Z',
    RMM2:       '2026-08-06T11:31:17.000Z',
    RRM:        '2026-08-06T11:31:28.000Z',
    // RMM1 is not here: it moved to 15s a month earlier, below.
  };
  const tenToFifteen = at => [
    { until: at, pointsPerHour: 360, cadence: '10' },
    { from:  at, pointsPerHour: 240, cadence: '15' },
  ];
  const table = { RMM1: tenToFifteen('2026-07-09T09:18:12.000Z') };
  for (const [plant, at] of Object.entries(CHANGE_2026_08_06)) table[plant] = tenToFifteen(at);
  // OFIL_LOG only started logging on 2026-08-11, after the plant-wide switch,
  // so it has never run at anything but 15s: one era, no boundary. Listing it
  // is still required — an absent machine falls back to 10s/360.
  table.OFIL = [{ pointsPerHour: 240, cadence: '15' }];
  // Silo_LOG started logging 2026-08-14, at 60s from the first row — measured
  // over every interval in the table, not one sample. Same reasoning as OFIL:
  // one era, no boundary, but listing it is what keeps countSilo off the
  // 360/10s fallback (which would report a sixth of the real run-hours).
  table.Silo = [{ pointsPerHour: 60, cadence: '60' }];
  return table;
})();

// Plant-local naive-datetime string, same "YYYY-MM-DD HH:mm:ss.SSS" format as
// tbf/taf: an era boundary's UTC fields already hold the plant wall-clock value
// (same "fake Z" convention as everywhere else in this file).
function formatPlantLocal(d) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

// Parse either wire form onto the same scale. tbf/taf arrive as naive plant
// wall-clock ("2026-08-06 12:00:00.000"), era boundaries as the same wall-clock
// with the file-wide fake Z ("2026-08-06T11:27:25.000Z"). Both are read as UTC
// so their epoch values are directly comparable, and so they compare the same
// way against row timestamps — which the driver also parses as UTC. Parsing the
// naive form without the Z would make it server-local instead, putting the two
// sides hours apart and silently assigning rows to the wrong era.
const toPlantDate = s => {
  const t = String(s).replace(' ', 'T');
  return new Date(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + 'Z');
};

// The eras overlapping [tbf, taf], each clamped to the window, in chronological
// order. Non-overlapping eras are dropped, so a window inside a single era
// costs exactly one query and returns exactly today's single-era response.
function erasFor(plant, tbf, taf, query = {}) {
  const eras = CADENCE_ERAS[plant] || [];
  const newest = eras[eras.length - 1];
  const from = toPlantDate(tbf), to = toPlantDate(taf);

  // Explicit &pointsPerHour= or &cadence= forces single-era math over the whole
  // window (the pre-era-split workaround callers were told to use keeps
  // working). Unparseable dates fall through here too, so SQL still raises the
  // same error it always did instead of this helper masking it.
  const forced = Number(query.pointsPerHour) > 0 || query.cadence !== undefined;
  if (forced || !eras.length || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return [{
      tbf, taf,
      startMs: from.getTime(), endMs: to.getTime(),
      pointsPerHour: Number(query.pointsPerHour) > 0 ? Number(query.pointsPerHour)
                   : (newest ? newest.pointsPerHour : 360),
      cadence: query.cadence !== undefined ? query.cadence
             : (newest ? newest.cadence : '10'),
      label: null,
    }];
  }

  const out = [];
  for (const era of eras) {
    // Legacy SQL DATETIME columns round to ~3.33ms increments (.000/.003/.007),
    // so nudging an era's start by +1ms silently rounds back down onto the
    // boundary instant and would count the boundary row in both eras. +10ms is
    // clear of that rounding and still negligible against a 10-15s cadence, so
    // no real row can fall into the gap between two eras.
    const lo = era.from ? new Date(toPlantDate(era.from).getTime() + 10) : from;
    const hi = era.until ? toPlantDate(era.until) : to;
    const startMs = Math.max(from.getTime(), lo.getTime());
    const endMs = Math.min(to.getTime(), hi.getTime());
    if (startMs > endMs) continue;
    out.push({
      tbf: startMs === from.getTime() ? tbf : formatPlantLocal(new Date(startMs)),
      taf: endMs === to.getTime() ? taf : formatPlantLocal(new Date(endMs)),
      startMs, endMs,
      pointsPerHour: era.pointsPerHour,
      cadence: era.cadence,
      label: era.from ? { from: era.from } : { until: era.until },
    });
  }
  return out;
}

// Default cadence for a window route's opt-in gap fill: the cadence in force at
// the end of the requested window, so historical windows keep filling at the
// rate their rows were actually logged at and current ones follow the change.
// A window straddling a boundary gets the newer of the two — unlike the count
// routes there is no split to make here, since a window route's raw rows are
// cadence-independent and only the synthetic fill rows are affected.
// Explicit &cadence= always wins (it is spread over this default by callers).
function defaultCadenceFor(plant, taf) {
  const eras = CADENCE_ERAS[plant] || [];
  if (!eras.length) return '10';
  const t = toPlantDate(taf).getTime();
  let cadence = eras[0].cadence;
  for (const era of eras) {
    if (era.from && t > toPlantDate(era.from).getTime()) cadence = era.cadence;
  }
  return cadence;
}

// Combine one era result per era into a single response body. Counts and hours
// add up directly (each era already divided by its own pointsPerHour), and the
// TOU buckets add bucket-by-bucket — tariff classification is calendar-based,
// so a bucket means the same thing in every era.
function mergeEras(results) {
  let count = 0, hour = 0, distHour = null, distHourFine = null, tagName = null;
  for (const r of results) {
    if (tagName === null) tagName = r.tagName;
    count += r.count;
    hour += r.hour;
    if (!distHour) distHour = { ...r.distHour };
    else for (const k of Object.keys(r.distHour)) distHour[k] += r.distHour[k];
    if (!distHourFine) distHourFine = { ...r.distHourFine };
    else for (const k of Object.keys(r.distHourFine)) distHourFine[k] += r.distHourFine[k];
  }

  // Audit block: keep the flat single-cadence shape whenever the window sits
  // inside one era (every historical and every future query), and only describe
  // the split when the window actually crosses a boundary. Eras with no raw
  // rows are left out entirely rather than reported as an empty cadence.
  const withMeta = results.filter(r => r.realReadings > 0 && r.fillGapsMeta);
  let fillGapsMeta = null;
  if (withMeta.length === 0) {
    // Nothing logged anywhere in the window (empty range or unknown tag): still
    // report the block a single-era run would have, describing the cadence that
    // would have applied, rather than dropping the key entirely.
    const any = results.find(r => r.fillGapsMeta);
    fillGapsMeta = any ? any.fillGapsMeta : null;
  } else if (withMeta.length === 1) {
    fillGapsMeta = withMeta[0].fillGapsMeta;
  } else {
    const first = withMeta[0].fillGapsMeta.fillGapsOptions;
    fillGapsMeta = {
      fillGapsOptions: {
        eras: withMeta.map(r => ({
          ...(r.label || {}),
          cadenceS: r.fillGapsMeta.fillGapsOptions.cadenceS,
          pointsPerHour: r.pointsPerHour,
        })),
        capS: first.capS,
        tolerance: first.tolerance,
      },
      realReadings: withMeta.reduce((s, r) => s + r.fillGapsMeta.realReadings, 0),
      filledReadings: withMeta.reduce((s, r) => s + r.fillGapsMeta.filledReadings, 0),
      flaggedGaps: withMeta.flatMap(r => r.fillGapsMeta.flaggedGaps),
    };
  }
  return { tagName, count, hour, distHour, distHourFine, fillGapsMeta };
}

// SQL-pipeline count route: one runCountQuerySql per era, in parallel, merged.
async function runCountEras(pool, opts) {
  const { plant, floatTable, tagTable, tagIndex, tbf, taf, threshold, query } = opts;
  const eras = erasFor(plant, tbf, taf, query);
  const results = await Promise.all(eras.map(async era => {
    const r = await runCountQuerySql(pool, {
      floatTable, tagTable, tagIndex,
      tbf: era.tbf, taf: era.taf,
      threshold, pointsPerHour: era.pointsPerHour,
      query: { ...query, cadence: era.cadence },
    });
    return { ...r, pointsPerHour: era.pointsPerHour, label: era.label };
  }));
  return mergeEras(results);
}

// JS-pipeline count route: same era split over an already-fetched row array,
// for the routes still using the fetch-rows-into-JS path.
function countErasJs(rows, opts) {
  const { plant, tagName, tbf, taf, threshold, query } = opts;
  const hourOpts = {
    timeField: 'DateAndTime',
    // DB stores naive Bangkok-local timestamps; the driver parses them as UTC,
    // so clock:'utc' reads plant-local time regardless of the server's OS timezone.
    clock: 'utc',
    isHoliday: isHolidayUTC,
    returnHours: true,
  };
  const results = erasFor(plant, tbf, taf, query).map(era => {
    const slice = rows.filter(row => {
      const t = new Date(row.DateAndTime).getTime();
      return t >= era.startMs && t <= era.endMs;
    });
    const { data, meta } = fillGapsForCount(slice, { cadence: era.cadence, ...query });
    const count = countValues(data, 'Val', '>', threshold);
    const o = { ...hourOpts, pointsPerHour: era.pointsPerHour };
    return {
      tagName,
      count,
      hour: count / era.pointsPerHour,
      distHour: countValuesHour(data, 'Val', '>', threshold, o),
      distHourFine: countValuesHourFine(data, 'Val', '>', threshold, o),
      fillGapsMeta: meta,
      realReadings: slice.length,
      pointsPerHour: era.pointsPerHour,
      label: era.label,
    };
  });
  return mergeEras(results);
}

pool.on('error', err => {
    console.error('SQL Pool Error:', err);
});

poolConnect
    .then(() => console.log('Connected to Database SSI-PC (pool ready)'))
    .catch(err => console.error('Failed to connect to Database SSI-PC:', err));

router.get('/', async (req, res) => {
  try {
    // One round-trip per plant, all in flight at once — sequential awaits made
    // this listing pay 17 network round-trips back to back.
    const [tagBM2_con, tagBM2, tagCT6_con, tagCT6_heater, tagCT7_con, tagCT7_heater,
           tagCSH, tagFeedRaw, tagHYD, tagRMM1, tagRMM2, tagWL, tagRRM, tagLC_CSH,
           tagHour_OFIL, tagOFIL, tagSilo] = await Promise.all([
      pool.request().query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [REPL_BallMill_Conveyor_LOG].[dbo].[TagBallMill_Conveyor]`,
      pool.request().query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [REPL_BallMill_Log].[dbo].[TagBallMill]`,
      pool.request().query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con]`,
      pool.request().query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`,
      pool.request().query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`,
      pool.request().query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]`,
      pool.request().query`SELECT TagName.TagName, TagName.TagIndex FROM [REPL_Crushing_Log].[dbo].[TagName]`,
      pool.request().query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw]`,
      pool.request().query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic]`,
      pool.request().query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill]`,
      pool.request().query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_WL_LOG].[dbo].[TagTable]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_RingRollerMill].[dbo].[TagTable]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_LC_CSH].[dbo].[TagTable]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_Hour_OFIL].[dbo].[TagTable]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_OFIL_LOG].[dbo].[TagTable]`,
      pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_Silo_LOG].[dbo].[TagTable]`,
    ]);

    res.json([
      {"message":["//how to use// {host}:3334/plants/{plant}/all,{tag_id}/{time_before}/{time_after}/avg",
                        "example : http://172.30.1.112:3334/plants/BM2/1/2024-07-01%2000:00:00.000/2024-07-31%2000:00:00.000/avg",
                        "example : http://172.30.1.112:3334/plants/countRMM2?tagIndex=5&tbf=2024-08-01%2000:00:00.000&taf=2024-08-02%2000:00:00.000&threshold=1"]},
      {"note_RRM":"RRM tags are returned with friendly names (M208_Feeder_Current, ...) and values converted to engineering units (raw historian integers /10, feeder current /100). countRRM's &threshold= is in those same converted units. The historian itself is unchanged."},
      {"note_OFIL":"OFIL tags are returned with friendly names (SILO4_OutputFreq, Rotary_Screen2_OutputFreq, ...) and values converted to Hz (the drives log OutputFreq in hundredths of a Hz, so raw /100: 2900 => 29). countOFIL's &threshold= is in Hz. The historian itself is unchanged. Not to be confused with Hour_OFIL, a separate database of cumulative hour counters."},
      {"note_Silo":"Silo tags are returned with the plant's own silo names (SILO31_LEVEL, SILO1CSH_WEIGHT, ...) instead of the raw historian names, which misidentify the silo (RaymondMill\\Weight_Silo3 is silo 41; Coating7_Con\\Net_Weight is silo 1; TONSILOCSH[0..3] are silos 1..4). Values are NOT converted — countSilo's &threshold= is in each tag's own units, and note those units are mixed: SILO1/3/43/44_WEIGHT are in the tens of thousands (kg) while the other *_WEIGHT tags read in tonnes. The historian itself is unchanged."},
      {"function_list":["/{plant}   ==get all tagIndex",
                        "/{plant}/{tag_id}    ==get lastest tagIndex data",
                        "/{plant}/all   ==query top 1000 in database",
                        "/{plant}/{tag_id}/{time_before}/{time_after}/avg   ==average data",
                        "/{plant}/{tag_id}/{time_before}/{time_after}?fillGaps=true&cadence=10&cap=90&tolerance=0.2   ==optionally bridge short Kepware logging gaps (hold-last-value, only when gap<=cap seconds AND bracketing values agree within tolerance); unfillable gaps reported in flaggedGaps, synthetic rows marked Filled:true; &cadence= defaults to the machine's logging cadence at the end of the requested window (10s before its changeover, 15s after); WL and Hour_OFIL ignore this param (event data / cumulative counters must not be synthesized)",
                        "/count{plant}?tagIndex={tag_no.}&tbf={time}&taf={time}&threshold={..}    ==count choosen tagdata between choosen time frame and filter with larger selected threshold; run-hour math follows each machine's logging cadence automatically, including machines whose Kepware log interval has changed (the whole plant moved 10s => 15s on 2026-08-06 ~11:30, RMM1 already on 2026-07-09 09:18) — no parameters are needed for windows before, after, or spanning a change, and a spanning window reports both cadences in its fillGaps audit block; optional &pointsPerHour= overrides the samples-per-hour used for run-hour math and forces that one value over the whole window (as does &cadence=), needed only for Hour_OFIL (60s cadence => &pointsPerHour=60; Silo also logs at 60s but is in the cadence table, so it needs no parameter); gap fill is ON BY DEFAULT: short Kepware logging blips are bridged before counting so run-hours are not undercounted (response includes a fillGaps audit block; tune with &cadence=&cap=&tolerance=); pass &fillGaps=false for the legacy raw count identical to production :3334; countWL/countHour_OFIL/countLC_CSH never fill (event data / cumulative counter / on-change logging). WARNING: LC_CSH logs on-change (no fixed cadence) — sample-count run-hours are not meaningful for it regardless of parameters"]},
      {"BM2_con":"BallMill2 Conveyor","tags":tagBM2_con.recordset},
      {"BM2":"BallMill2","tags":tagBM2.recordset},
      {"CT6_con":"Coating6 Conveyor","tags":tagCT6_con.recordset},
      {"CT6_heater":"Coating6 Heater","tags":tagCT6_heater.recordset},
      {"CT7_con":"Coating7 Conveyor","tags":tagCT7_con.recordset},
      {"CT7_heater":"Coating7 Heater","tags":tagCT7_heater.recordset},
      {"CSH":"Crushing","tags":tagCSH.recordset},
      {"FeedRaw":"FeedRaw Material VM/BM1/BM2","tags":tagFeedRaw.recordset},
      {"HYD":"Hydraulics Vertical Roller Mill","tags":tagHYD.recordset},
      {"RMM1":"Raymond Mill1","tags":tagRMM1.recordset},
      {"RMM2":"Raymond Mill2","tags":tagRMM2.recordset},
      {"WL_Weight":"Wheel Loader Weight","tags ([0]=id [1]=WL_no. [2]=Load [3]=Gross Weight)":tagWL.recordset},
      {"RRM":"RingRollerMill","tags":presentTagList('RRM', tagRRM.recordset)},
      {"LC_CSH":"Loadcell Crushing","tags":tagLC_CSH.recordset},
      {"Hour_OFIL":"Hour OFIL","tags":tagHour_OFIL.recordset},
      {"OFIL":"OFIL Silo/Rotary Screens (drive output frequency, Hz)","tags":presentTagList('OFIL', tagOFIL.recordset)},
      {"Silo":"Silo levels and weights, plant-wide (60s logging; values in the tag's own engineering units)","tags":presentTagList('Silo', tagSilo.recordset)}
    ]);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////

router.get('/BM2_con', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [REPL_BallMill_Conveyor_LOG].[dbo].[TagBallMill_Conveyor]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2_con/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
WHERE FloatBallMill_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
      SELECT TOP (1) FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
  FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  and FloatBallMill_Conveyor.Status <> 'E'
  ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/BM2_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_BallMill_Conveyor_Log].[dbo].[TagBallMill_Conveyor] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('BM2_con', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/BM2_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_BallMill_Conveyor_Log].[dbo].[TagBallMill_Conveyor] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countBM2_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_BallMill_Conveyor_Log].[dbo].[TagBallMill_Conveyor] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production). Counting
    // runs once per logging-cadence era (CADENCE_ERAS) so run-hours use the
    // cadence each row was actually logged at.
    const r = countErasJs(result.recordset, {
      plant: 'BM2_con', tagName, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex,tagName:r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

///////////////////////////////////////////

router.get('/BM2', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [REPL_BallMill_Log].[dbo].[TagBallMill]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
and FloatBallMill.TagIndex = ${tagIndex}
WHERE FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/BM2/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_BallMill_Log].[dbo].[TagBallMill] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('BM2', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/BM2/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_BallMill_Log].[dbo].[TagBallMill] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countBM2', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'BM2',
      floatTable: '[REPL_BallMill_Log].[dbo].[FloatBallMill]',
      tagTable: '[REPL_BallMill_Log].[dbo].[TagBallMill]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////

router.get('/CT6_con', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_con/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
and FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT6_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('CT6_con', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT6_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT6_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production). Counting
    // runs once per logging-cadence era (CADENCE_ERAS) so run-hours use the
    // cadence each row was actually logged at.
    const r = countErasJs(result.recordset, {
      plant: 'CT6_con', tagName, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex,tagName:r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour,distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////////

router.get('/CT6_heater', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_heater/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_heater/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
and FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT6_heater/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('CT6_heater', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT6_heater/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT6_heater', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'CT6_heater',
      floatTable: '[REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]',
      tagTable: '[REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////

router.get('/CT7_con', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE FloatCoating_MC7_Conveyor.Status <>'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT7_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <>'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('CT7_con', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT7_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/:tagIndex/:tbf/:taf/calCap', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row (same rework as /avg);
    // cap = SUM(Val)/6, and the sum can differ from the old JS total in the
    // last decimals (float summation order). max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, SUM(Val) AS sumVal, COUNT(*) AS n
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const capVal = ok ? a.sumVal / 6 : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, cap: capVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT7_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production). Counting
    // runs once per logging-cadence era (CADENCE_ERAS) so run-hours use the
    // cadence each row was actually logged at.
    const r = countErasJs(result.recordset, {
      plant: 'CT7_con', tagName, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName,date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

///////////////////////////////////////////////

router.get('/CT7_heater', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_heater/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_heater/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
and FloatCoating_MC7.TagIndex = ${tagIndex}
and FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT7_heater/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('CT7_heater', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT7_heater/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT7_heater', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'CT7_heater',
      floatTable: '[REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]',
      tagTable: '[REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RRM', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_RingRollerMill].[dbo].[TagTable]`;
    res.json(presentTagList('RRM', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RRM/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('RRM', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RRM/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('RRM', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RRM/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_RingRollerMill].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      // Rename/scale AFTER the fill so gap detection still sees raw values and
      // the synthetic rows it adds are converted along with the real ones.
      res.json(presentWindow('RRM',
        applyFillGaps(result.recordset, { cadence: defaultCadenceFor('RRM', taf), ...req.query })));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RRM/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_RingRollerMill].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? displayName('RRM', tagIndex, tag.recordset[0].TagName) : null;
  const maxVal = ok ? scaleValue('RRM', tagIndex, a.maxVal) : null;
  const minVal = ok ? scaleValue('RRM', tagIndex, a.minVal) : null;
  const avgVal = ok ? scaleValue('RRM', tagIndex, a.avgVal) : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRRM', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    // RRM values are reported in engineering units, so &threshold= is too:
    // scale it back up to the raw stored integer before comparing. count/hour
    // and the TOU buckets are sample counts, unaffected by the conversion.
    const r = await runCountEras(pool, {
      plant: 'RRM',
      floatTable: '[REPL_RingRollerMill].[dbo].[FloatTable]',
      tagTable: '[REPL_RingRollerMill].[dbo].[TagTable]',
      tagIndex, tbf, taf,
      threshold: thresholdValue * divisorFor('RRM', tagIndex),
      query: req.query,
    });
    // null tagName means "no rows in this window" and must stay null — don't
    // let the display map turn an empty window into a named one.
    const tagName = r.tagName === null ? null : displayName('RRM', tagIndex, r.tagName);
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

router.get('/LC_CSH', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_LC_CSH].[dbo].[TagTable]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/LC_CSH/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_LC_CSH].[dbo].[FloatTable]
INNER JOIN REPL_LC_CSH.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/LC_CSH/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_LC_CSH].[dbo].[FloatTable]
INNER JOIN REPL_LC_CSH.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/LC_CSH/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_LC_CSH].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_LC_CSH].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, req.query));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/LC_CSH/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_LC_CSH].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_LC_CSH].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countLC_CSH', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_LC_CSH].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_LC_CSH].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    // No gap fill here: LC_CSH logs on-change with no fixed cadence (measured
    // intervals 1-56s), so a cadence-based fill would fabricate rows and the
    // sample-count run-hours are not meaningful anyway. fillGaps param ignored.
    const data = result.recordset;
    const fillGapsMeta = null;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/pointsPerHour;
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime',
  // DB stores naive Bangkok-local timestamps; the driver parses them as UTC,
  // so clock:'utc' reads plant-local time regardless of the server's OS timezone.
  clock: 'utc',
  isHoliday: isHolidayUTC,
  pointsPerHour,
  returnHours: true,
});
    // Finer TOU split for the Energy Report dashboard's hours table (additive; distHour unchanged).
    const distHourFine = countValuesHourFine(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime',
  clock: 'utc',
  isHoliday: isHolidayUTC,
  pointsPerHour,
  returnHours: true,
});
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

router.get('/Hour_OFIL', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_Hour_OFIL].[dbo].[TagTable]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/Hour_OFIL/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_Hour_OFIL].[dbo].[FloatTable]
INNER JOIN REPL_Hour_OFIL.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E' AND FloatTable.Status <> 'U' AND FloatTable.Status <> 'S'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/Hour_OFIL/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_Hour_OFIL].[dbo].[FloatTable]
INNER JOIN REPL_Hour_OFIL.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E' AND FloatTable.Status <> 'U' AND FloatTable.Status <> 'S'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/Hour_OFIL/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Hour_OFIL].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E' AND Status <> 'U' AND Status <> 'S'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Hour_OFIL].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      // No fillGaps here: Hour_OFIL tags are cumulative counters — holding a
      // counter flat across a gap understates it, so gaps must stay visible.
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/Hour_OFIL/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Hour_OFIL].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E' AND Status <> 'U' AND Status <> 'S'`,
      pool.request().query`SELECT TagName FROM [REPL_Hour_OFIL].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countHour_OFIL', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Hour_OFIL].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E' AND Status <> 'U' AND Status <> 'S'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_Hour_OFIL].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    // No gap fill: Hour_OFIL tags are cumulative counters — synthesizing
    // samples would fabricate counter progress. fillGaps param is ignored.
    const data = result.recordset;
    const fillGapsMeta = null;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/pointsPerHour;
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime',
  // DB stores naive Bangkok-local timestamps; the driver parses them as UTC,
  // so clock:'utc' reads plant-local time regardless of the server's OS timezone.
  clock: 'utc',
  isHoliday: isHolidayUTC,
  pointsPerHour,
  returnHours: true,
});
    // Finer TOU split for the Energy Report dashboard's hours table (additive; distHour unchanged).
    const distHourFine = countValuesHourFine(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime',
  clock: 'utc',
  isHoliday: isHolidayUTC,
  pointsPerHour,
  returnHours: true,
});
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

router.get('/CSH', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagName.TagName, TagName.TagIndex FROM [REPL_Crushing_Log].[dbo].[TagName]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CSH/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CSH/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
and FloatValue.TagIndex = ${tagIndex}
and FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CSH/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Crushing_Log].[dbo].[TagName] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('CSH', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CSH/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Crushing_Log].[dbo].[TagName] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCSH', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'CSH',
      floatTable: '[REPL_Crushing_Log].[dbo].[FloatValue]',
      tagTable: '[REPL_Crushing_Log].[dbo].[TagName]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});



router.get('/FeedRaw', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/FeedRaw/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/FeedRaw/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
and FloatFeedRaw.TagIndex = ${tagIndex}
and FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/FeedRaw/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('FeedRaw', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/FeedRaw/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countFeedRaw', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // Trimmed fetch: the counting pipeline only reads DateAndTime/Val, so
    // the per-row TagName join was pure transfer cost.
    const [result, tagQ] = await Promise.all([
      pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
      pool.request().query`SELECT TagName FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw] WHERE TagIndex = ${tagIndex}`,
    ]);
    // The old query INNER JOINed the tag table: unknown tag -> no rows
    // (count 0, tagName null), reproduced here.
    if (tagQ.recordset.length === 0) result.recordset = [];
    const tagName = (result.recordset.length === 0 ? null : tagQ.recordset[0].TagName);
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production). Counting
    // runs once per logging-cadence era (CADENCE_ERAS) so run-hours use the
    // cadence each row was actually logged at.
    const r = countErasJs(result.recordset, {
      plant: 'FeedRaw', tagName, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex,tagName:r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////

router.get('/HYD', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/HYD/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/HYD/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
and FloatHydraulic.TagIndex = ${tagIndex}
and FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/HYD/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('HYD', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/HYD/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countHYD', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'HYD',
      floatTable: '[REPL_Hydraulic_Log].[dbo].[FloatHydraulic]',
      tagTable: '[REPL_Hydraulic_Log].[dbo].[TagHydraulic]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RMM1', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM1/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM1/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
and FloatRayMondMill.TagIndex = ${tagIndex}
and FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RMM1/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('RMM1', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RMM1/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRMM1', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // RMM1 moved to 15s on 2026-07-09, a month before the rest of the plant;
    // both boundaries live in CADENCE_ERAS and this route is no different from
    // any other count route now.
    const r = await runCountEras(pool, {
      plant: 'RMM1',
      floatTable: '[REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]',
      tagTable: '[REPL_RaymondMill_Log].[dbo].[TagRayMondMill]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex,tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RMM2', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM2/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP(1000) FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM2/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
and FloatRaymondMill2.TagIndex = ${tagIndex}
and FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RMM2/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      res.json(applyFillGaps(result.recordset, { cadence: defaultCadenceFor('RMM2', taf), ...req.query }));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RMM2/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? tag.recordset[0].TagName : null;
  const maxVal = ok ? a.maxVal : null;
  const minVal = ok ? a.minVal : null;
  const avgVal = ok ? a.avgVal : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRMM2', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    const r = await runCountEras(pool, {
      plant: 'RMM2',
      floatTable: '[REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]',
      tagTable: '[REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]',
      tagIndex, tbf, taf, threshold: thresholdValue, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

// OFIL (REPL_OFIL_LOG): the silo feeder and rotary-screen drives. Served
// through the display layer like RRM — the tag table holds raw Logix paths and
// the drives log OutputFreq in hundredths of a Hz. Unrelated to Hour_OFIL,
// which is a separate database of cumulative hour counters.
router.get('/OFIL', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_OFIL_LOG].[dbo].[TagTable]`;
    res.json(presentTagList('OFIL', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/OFIL/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_OFIL_LOG].[dbo].[FloatTable]
INNER JOIN REPL_OFIL_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('OFIL', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/OFIL/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_OFIL_LOG].[dbo].[FloatTable]
INNER JOIN REPL_OFIL_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('OFIL', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/OFIL/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_OFIL_LOG].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_OFIL_LOG].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      // Rename/scale AFTER the fill so gap detection still sees raw values and
      // the synthetic rows it adds are converted along with the real ones.
      res.json(presentWindow('OFIL',
        applyFillGaps(result.recordset, { cadence: defaultCadenceFor('OFIL', taf), ...req.query })));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/OFIL/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_OFIL_LOG].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_OFIL_LOG].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? displayName('OFIL', tagIndex, tag.recordset[0].TagName) : null;
  const maxVal = ok ? scaleValue('OFIL', tagIndex, a.maxVal) : null;
  const minVal = ok ? scaleValue('OFIL', tagIndex, a.minVal) : null;
  const avgVal = ok ? scaleValue('OFIL', tagIndex, a.avgVal) : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countOFIL', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS); &pointsPerHour= / &cadence= still force
    // one cadence over the whole window.
    // OFIL values are reported in Hz, so &threshold= is too: scale it back up
    // to the raw stored hundredths before comparing. count/hour and the TOU
    // buckets are sample counts, unaffected by the conversion.
    const r = await runCountEras(pool, {
      plant: 'OFIL',
      floatTable: '[REPL_OFIL_LOG].[dbo].[FloatTable]',
      tagTable: '[REPL_OFIL_LOG].[dbo].[TagTable]',
      tagIndex, tbf, taf,
      threshold: thresholdValue * divisorFor('OFIL', tagIndex),
      query: req.query,
    });
    // null tagName means "no rows in this window" and must stay null — don't
    // let the display map turn an empty window into a named one.
    const tagName = r.tagName === null ? null : displayName('OFIL', tagIndex, r.tagName);
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

// Silo (REPL_Silo_LOG): silo levels and weights collected from several PLCs
// across the plant (Coating7, Coating1, RaymondMill2, PLC_Ofil), logged at 60s.
// Served through the display layer like RRM and OFIL, but RENAME-ONLY: the
// values are already real floats in engineering units, so every divisor is 1
// and countSilo's &threshold= is in the tag's own units. The rename is not
// cosmetic — the raw historian names misidentify which silo they describe
// (see the Silo block in api/tagDisplay.js).
router.get('/Silo', async (req, res) => {
  try {
    const result = await pool.request().query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_Silo_LOG].[dbo].[TagTable]`;
    res.json(presentTagList('Silo', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/Silo/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_Silo_LOG].[dbo].[FloatTable]
INNER JOIN REPL_Silo_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('Silo', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/Silo/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_Silo_LOG].[dbo].[FloatTable]
INNER JOIN REPL_Silo_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(presentRows('Silo', result.recordset));
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/Silo/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      // Trimmed fetch: TagIndex/TagName are constant for the queried tag and
      // re-added in JS below — shipping them per row (nvarchar join per
      // row) dominated this route's latency.
      const [result, tagQ] = await Promise.all([
        pool.request().query`
  SELECT DateAndTime, Val
FROM [REPL_Silo_LOG].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'
ORDER BY DateAndTime DESC`,
        pool.request().query`SELECT TagIndex, TagName FROM [REPL_Silo_LOG].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
      ]);
      const tagRow = tagQ.recordset[0];
      // The old query INNER JOINed the tag table: unknown tag -> no rows.
      result.recordset = tagRow === undefined ? [] : result.recordset.map(r => ({
        DateAndTime: r.DateAndTime, Val: r.Val,
        TagIndex: tagRow.TagIndex, TagName: tagRow.TagName,
      }));
      // defaultCadenceFor('Silo', …) is 60, so opt-in ?fillGaps=true only
      // bridges a gap when the caller also raises &cap= above the default 90s
      // — one missed 60s sample is a 120s gap. Left at the shared default
      // deliberately: nothing here should invent silo readings by accident.
      // Rename AFTER the fill so the synthetic rows are renamed along with the
      // real ones (the same ordering RRM and OFIL use for their scaling).
      res.json(presentWindow('Silo',
        applyFillGaps(result.recordset, { cadence: defaultCadenceFor('Silo', taf), ...req.query })));
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/Silo/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    // Aggregate in SQL instead of fetching every row: the old query shipped
    // the whole window (with a per-row TagName join) to compute three
    // scalars in JS. avg can differ from the old JS sum in the last
    // decimals (float summation order); max/min are identical.
    const [agg, tag] = await Promise.all([
      pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal, COUNT(*) AS n
FROM [REPL_Silo_LOG].[dbo].[FloatTable]
WHERE DateAndTime between ${tbf} and ${taf}
and TagIndex = ${tagIndex}
and Status <> 'E'`,
      pool.request().query`SELECT TagName FROM [REPL_Silo_LOG].[dbo].[TagTable] WHERE TagIndex = ${tagIndex}`,
    ]);
  const a = agg.recordset[0];
  // Empty window or unknown tag (the old INNER JOIN -> no rows) returned
  // nulls from the JS helpers; reproduce that exactly.
  const ok = a.n > 0 && tag.recordset.length > 0;
  const tagName = ok ? displayName('Silo', tagIndex, tag.recordset[0].TagName) : null;
  // scaleValue is a no-op at divisor 1, but going through it keeps this route
  // correct if a divisor is ever added to the Silo block.
  const maxVal = ok ? scaleValue('Silo', tagIndex, a.maxVal) : null;
  const minVal = ok ? scaleValue('Silo', tagIndex, a.minVal) : null;
  const avgVal = ok ? scaleValue('Silo', tagIndex, a.avgVal) : null;
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countSilo', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    // Samples per hour comes from the tag's logging cadence at the time each
    // row was logged (CADENCE_ERAS: Silo is 60s => 60/hour); &pointsPerHour= /
    // &cadence= still force one cadence over the whole window.
    // divisorFor is 1 for every Silo tag, so &threshold= is in the tag's own
    // units — the multiply is kept so the route stays correct if that changes.
    const r = await runCountEras(pool, {
      plant: 'Silo',
      floatTable: '[REPL_Silo_LOG].[dbo].[FloatTable]',
      tagTable: '[REPL_Silo_LOG].[dbo].[TagTable]',
      tagIndex, tbf, taf,
      threshold: thresholdValue * divisorFor('Silo', tagIndex),
      query: req.query,
    });
    // null tagName means "no rows in this window" and must stay null — don't
    // let the display map turn an empty window into a named one.
    const tagName = r.tagName === null ? null : displayName('Silo', tagIndex, r.tagName);
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////////////////////

router.get('/WL/pivotData/:tbf/:taf', async (req, res) => {
   const {tbf,taf} = req.params;
try {
  const result = await pool.request().query`
  SELECT FloatTable.DateAndTime,TagTable.TagName,FloatTable.Val 
FROM [REPL_WL_LOG].[dbo].[FloatTable]
INNER JOIN REPL_WL_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime ASC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/WL/all', async (req, res) => {
  try {
    const result = await pool.request().query`
  SELECT TOP(1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/WL/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await pool.request().query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/WL/:tagIndex/:tbf/:taf/ins', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await pool.request().query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/WL/:tagIndex/:tbf/:taf/asc', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await pool.request().query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime ASC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/WL/:tagIndex/:tbf/:taf/datacal', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await pool.request().query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val')*2;
  const sumVal = calSum(data, 'Val');
  const count = countValues(data, 'Val', '!=', 0);
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, sum: sumVal, avg: avgVal, count: count});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countWL', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    const result = await pool.request().query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    // No gap fill: WL is event data — synthesizing rows would fabricate
    // weighing cycles. fillGaps param is ignored.
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/pointsPerHour;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

// router.get('/WL/:tagIndex/:tbf/:taf/sum', async (req, res) => {
//   const {tagIndex,tbf,taf} = req.params;
//   try {
//     const result = await pool.request().query`
//   SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
// FROM [REPL_WL_Log].[dbo].[FloatTable]
// INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
// WHERE DateAndTime between ${tbf} and ${taf}
// and FloatTable.TagIndex = ${tagIndex}
// ORDER BY DateAndTime ASC`;
//     const data = result.recordset;
//     const maxVal = findMax(data, 'Val');
//     const minVal = findMin(data, 'Val');
//     const sumVal = calSum(data, 'Val');
//     res.json({meter: tag, date_before:tbf, date_after:taf, max: maxVal, min: minVal, sum: sumVal});
//   } catch (err) {
//     console.error('Database query error:', err);
//     res.status(500).send('Server error');
//   }
// });

router.get('/WL/pivotDataFilter/:tbf/:taf', async (req, res) => {
  const { tbf, taf } = req.params;

  // all filters passed as query params, NOT as route params
  const {
    silo,
    material,
    wlno,
    id,
    minWeight,
    maxWeight,
    minId,
    maxId
  } = req.query;

  try {
    const result = await pool.request().query`
      SELECT FloatTable.DateAndTime, TagTable.TagName, FloatTable.Val 
      FROM [REPL_WL_LOG].[dbo].[FloatTable]
      INNER JOIN REPL_WL_LOG.dbo.TagTable 
      ON FloatTable.TagIndex = TagTable.TagIndex
      WHERE DateAndTime BETWEEN ${tbf} AND ${taf}
      and FloatTable.Status <> 'E'
      ORDER BY DateAndTime ASC
    `;

    const rows = result.recordset;

    // 1) Group + pivot
    const grouped = {};

    rows.forEach(row => {
      if (row.Val === 0) return;

      const dtKey = row.DateAndTime.toISOString();

      if (!grouped[dtKey]) {
        grouped[dtKey] = {
          DateAndTime: row.DateAndTime,
          id: null,       // BRS_INT[14]
          WL_No: null,    // BRS_INT[08]
          Weight: null,   // BRS_REAL[26]
          Silo: null,     // BRS_DINT[3]
          Material: null  // BRS_DINT[4]
        };
      }

      switch (row.TagName) {
        case "[PLC_Crushing]BRS_DINT[3]":
          grouped[dtKey].Silo = row.Val;
          break;
        case "[PLC_Crushing]BRS_REAL[26]":
          grouped[dtKey].Weight = row.Val;
          break;
        case "[PLC_Crushing]BRS_DINT[4]":
          grouped[dtKey].Material = row.Val;
          break;
        case "[PLC_Crushing]BRS_INT[08]":
          grouped[dtKey].WL_No = row.Val;
          break;
        case "[PLC_Crushing]BRS_INT[14]":
          grouped[dtKey].id = row.Val;
          break;
      }
    });

    let data = Object.values(grouped);

    // 2) Apply filters in JS (no type conversion problems in SQL)
    if (silo)      data = data.filter(r => r.Silo === parseInt(silo, 10));
    if (material)  data = data.filter(r => r.Material === parseInt(material, 10));
    if (wlno)      data = data.filter(r => r.WL_No === parseInt(wlno, 10));
    if (id)        data = data.filter(r => r.id === parseInt(id, 10));
    if (minWeight) data = data.filter(r => r.Weight >= parseFloat(minWeight));
    if (maxWeight) data = data.filter(r => r.Weight <= parseFloat(maxWeight));
    if (minId)     data = data.filter(r => r.id >= parseInt(minId, 10));
    if (maxId)     data = data.filter(r => r.id <= parseInt(maxId, 10));

    // 3) Sort by time
    data.sort((a, b) => a.DateAndTime - b.DateAndTime);

    // 4) Summary
    const cycles = data.length;
    const totalWeight = data.reduce((sum, r) => sum + (r.Weight || 0), 0);
    const avgWeight = cycles > 0 ? totalWeight / cycles : 0;

    // 5) Format output
    const formattedData = data.map(r => ({
      DateAndTime: r.DateAndTime.toISOString(),
      id: r.id,
      WL_No: r.WL_No,
      Weight: Number(r.Weight?.toFixed(2) || 0),
      Silo: r.Silo,
      Material: r.Material
    }));

    res.json({
      tbf,
      taf,
      filters: req.query,
      summary: {
        cycles,
        totalWeight: Number(totalWeight.toFixed(2)),
        avgWeight: Number(avgWeight.toFixed(2))
      },
      data: formattedData
    });

  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;