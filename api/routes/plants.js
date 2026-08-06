const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { findMax, findMin, calculateAverage, returnTagName, countValues, calSum, calCap, countValuesHour, countValuesHourFine, isHolidayUTC, applyFillGaps, fillGapsForCount, holidays } = require('../../utils');
const {dbConfig_PROD} = require('../../config');

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

  // realReadings exposed regardless of doFill so callers (e.g. RMM1's
  // era-split merge) can tell whether this era/window had any raw rows at
  // all — needed to skip an era's contribution entirely, matching the old
  // JS loop's "if (seg.rows.length === 0) continue".
  return { tagName, count, hour, distHour, distHourFine, fillGapsMeta, realReadings };
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
    // this listing pay 15 network round-trips back to back.
    const [tagBM2_con, tagBM2, tagCT6_con, tagCT6_heater, tagCT7_con, tagCT7_heater,
           tagCSH, tagFeedRaw, tagHYD, tagRMM1, tagRMM2, tagWL, tagRRM, tagLC_CSH,
           tagHour_OFIL] = await Promise.all([
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
    ]);

    res.json([
      {"message":["//how to use// {host}:3334/plants/{plant}/all,{tag_id}/{time_before}/{time_after}/avg",
                        "example : http://172.30.1.112:3334/plants/BM2/1/2024-07-01%2000:00:00.000/2024-07-31%2000:00:00.000/avg",
                        "example : http://172.30.1.112:3334/plants/countRMM2?tagIndex=5&tbf=2024-08-01%2000:00:00.000&taf=2024-08-02%2000:00:00.000&threshold=1"]},
      {"function_list":["/{plant}   ==get all tagIndex",
                        "/{plant}/{tag_id}    ==get lastest tagIndex data",
                        "/{plant}/all   ==query top 1000 in database",
                        "/{plant}/{tag_id}/{time_before}/{time_after}/avg   ==average data",
                        "/{plant}/{tag_id}/{time_before}/{time_after}?fillGaps=true&cadence=10&cap=90&tolerance=0.2   ==optionally bridge short Kepware logging gaps (hold-last-value, only when gap<=cap seconds AND bracketing values agree within tolerance); unfillable gaps reported in flaggedGaps, synthetic rows marked Filled:true; WL and Hour_OFIL ignore this param (event data / cumulative counters must not be synthesized)",
                        "/count{plant}?tagIndex={tag_no.}&tbf={time}&taf={time}&threshold={..}    ==count choosen tagdata between choosen time frame and filter with larger selected threshold; optional &pointsPerHour= overrides the samples-per-hour used for run-hour math (default 360 = 10s cadence; Hour_OFIL logs 60s => 60; RMM1 logs 15s since 2026-07-09 09:18 and countRMM1 handles the changeover automatically — no parameters needed for old, new, or spanning windows; passing &pointsPerHour= or &cadence= forces single-era math); gap fill is ON BY DEFAULT: short Kepware logging blips are bridged before counting so run-hours are not undercounted (response includes a fillGaps audit block; tune with &cadence=&cap=&tolerance=); pass &fillGaps=false for the legacy raw count identical to production :3334; countWL/countHour_OFIL/countLC_CSH never fill (event data / cumulative counter / on-change logging). WARNING: LC_CSH logs on-change (no fixed cadence) — sample-count run-hours are not meaningful for it regardless of parameters"]},
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
      {"RRM":"RingRollerMill","tags":tagRRM.recordset},
      {"LC_CSH":"Loadcell Crushing","tags":tagLC_CSH.recordset},
      {"Hour_OFIL":"Hour OFIL","tags":tagHour_OFIL.recordset}
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
      res.json(applyFillGaps(result.recordset, req.query));
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
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production).
    const { data, meta: fillGapsMeta } = fillGapsForCount(result.recordset, req.query);
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
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_BallMill_Log].[dbo].[FloatBallMill]',
      tagTable: '[REPL_BallMill_Log].[dbo].[TagBallMill]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
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
      res.json(applyFillGaps(result.recordset, req.query));
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
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production).
    const { data, meta: fillGapsMeta } = fillGapsForCount(result.recordset, req.query);
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
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour,distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]',
      tagTable: '[REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
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
      res.json(applyFillGaps(result.recordset, req.query));
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
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production).
    const { data, meta: fillGapsMeta } = fillGapsForCount(result.recordset, req.query);
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
    res.json({tagIndex: tagIndex, tagName: tagName,date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]',
      tagTable: '[REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
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
    res.json(result.recordset);
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
    res.json(result.recordset);
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
    res.json(result.recordset);
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
      res.json(applyFillGaps(result.recordset, req.query));
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

router.get('/countRRM', async (req, res) => {
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
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_RingRollerMill].[dbo].[FloatTable]',
      tagTable: '[REPL_RingRollerMill].[dbo].[TagTable]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_Crushing_Log].[dbo].[FloatValue]',
      tagTable: '[REPL_Crushing_Log].[dbo].[TagName]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
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
      res.json(applyFillGaps(result.recordset, req.query));
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
    // Gap fill is on by default: short Kepware logging blips are bridged before
    // counting so run-hours aren't undercounted. ?fillGaps=false returns the
    // legacy raw count (meta null, output identical to production).
    const { data, meta: fillGapsMeta } = fillGapsForCount(result.recordset, req.query);
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
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_Hydraulic_Log].[dbo].[FloatHydraulic]',
      tagTable: '[REPL_Hydraulic_Log].[dbo].[TagHydraulic]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
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
      // RMM1 logs at 15s since 2026-07-09 ~09:18; opt-in ?fillGaps=true
      // defaults to cadence 15 here (&cadence= still wins).
      res.json(applyFillGaps(result.recordset, { cadence: '15', ...req.query }));
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

// RMM1's Kepware log interval changed 10s -> 15s at this instant (plant time,
// wire format = the fake-Z Bangkok-local convention; measured from the
// historian: timestamp of the last 10s-cadence row). countRMM1 splits the
// window here and computes each era with its own cadence, so callers need no
// parameters for old, new, or spanning windows. If Kepware is rolled back to
// 10s, remove the second era (or add a third with its own boundary).
const RMM1_CADENCE_CHANGE = '2026-07-09T09:18:12.000Z';
const RMM1_ERAS = [
  { label: { until: RMM1_CADENCE_CHANGE }, pointsPerHour: 360, cadence: '10' },
  { label: { from: RMM1_CADENCE_CHANGE },  pointsPerHour: 240, cadence: '15' },
];

// Plant-local naive-datetime string, same "YYYY-MM-DD HH:mm:ss.SSS" format as
// tbf/taf: RMM1_CADENCE_CHANGE's UTC fields already hold the plant wall-clock
// value (same "fake Z" convention as everywhere else in this file).
function formatPlantLocal(d) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

router.get('/countRMM1', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  if (threshold === undefined || threshold === '' || Number.isNaN(thresholdValue)) {
    return res.status(400).json({error: "threshold query parameter is required and must be a number, e.g. &threshold=1"});
  }
  // Explicit &pointsPerHour= or &cadence= forces single-era math over the
  // whole window (the pre-era-split workaround keeps working); otherwise the
  // route era-splits at RMM1_CADENCE_CHANGE automatically.
  const forced = Number(req.query.pointsPerHour) > 0 || req.query.cadence !== undefined;
  try {
    // Merges one or two era results (SQL-side, via runCountQuerySql) into the
    // same shape the old JS era-loop produced, including RMM1's distinctive
    // fillGaps.fillGapsOptions.eras[] wrapper (unlike every other plant's flat
    // fillGapsOptions — this route always used that shape, forced or not).
    async function runEra(eraTbf, eraTaf, pointsPerHour, query, label) {
      const r = await runCountQuerySql(pool, {
        floatTable: '[REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]',
        tagTable: '[REPL_RaymondMill_Log].[dbo].[TagRayMondMill]',
        tagIndex, tbf: eraTbf, taf: eraTaf, threshold: thresholdValue, pointsPerHour, query,
      });
      return { ...r, pointsPerHour, label };
    }

    let eraResults;
    if (forced) {
      const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 240;
      // Same default as the original: forced-pointsPerHour-only still needs a
      // cadence, and the original fell back to the post-change era's (15s).
      const query = { ...req.query, cadence: req.query.cadence !== undefined ? req.query.cadence : '15' };
      eraResults = [await runEra(tbf, taf, pointsPerHour, query, null)];
    } else {
      const changeDate = new Date(RMM1_CADENCE_CHANGE);
      // Legacy SQL DATETIME columns round to ~3.33ms increments (.000/.003/.007),
      // so a +1ms nudge silently rounds back down to the exact boundary instant
      // (verified: CAST('...12.001' AS DATETIME) -> '...12.000') and era1's
      // clamped range would then include the boundary row a second time,
      // double-counting it. +10ms is safely clear of that rounding and still
      // utterly negligible next to the ~10-15s cadence, so no real row can
      // land in the gap between the two eras.
      const changePlus1 = new Date(changeDate.getTime() + 10);
      const changeStr = formatPlantLocal(changeDate);
      const changePlus1Str = formatPlantLocal(changePlus1);
      const toDate = s => new Date(s.replace(' ', 'T'));
      // Clamp each era's range to the requested window; a range where
      // clampedTbf > clampedTaf naturally yields zero rows (same as the old
      // "if (seg.rows.length === 0) continue" skip, just via an empty BETWEEN).
      const era0Taf = toDate(taf) <= changeDate ? taf : changeStr;
      const era1Tbf = toDate(tbf) >= changePlus1 ? tbf : changePlus1Str;
      eraResults = await Promise.all([
        runEra(tbf, era0Taf, 360, { ...req.query, cadence: '10' }, { until: RMM1_CADENCE_CHANGE }),
        runEra(era1Tbf, taf, 240, { ...req.query, cadence: '15' }, { from: RMM1_CADENCE_CHANGE }),
      ]);
    }

    let count = 0, hour = 0, distHour = null, distHourFine = null, fillGapsMeta = null, tagName = null;
    for (const seg of eraResults) {
      if (seg.tagName !== null) tagName = seg.tagName;
      count += seg.count;
      hour += seg.hour;
      // Accumulation is safe unconditionally (an empty era's numbers are
      // already all-zero), but the fillGaps.eras[] entry is only added for
      // eras that actually had raw rows — matching the old JS loop's
      // "if (seg.rows.length === 0) continue" (an era with zero rows never
      // appeared in the eras list, and if ALL eras were empty, fillGapsMeta
      // stayed null / the fillGaps key was omitted entirely).
      if (!distHour) distHour = { ...seg.distHour };
      else for (const k of Object.keys(seg.distHour)) distHour[k] += seg.distHour[k];
      if (!distHourFine) distHourFine = { ...seg.distHourFine };
      else for (const k of Object.keys(seg.distHourFine)) distHourFine[k] += seg.distHourFine[k];
      if (seg.realReadings > 0 && seg.fillGapsMeta) {
        if (!fillGapsMeta) fillGapsMeta = {
          fillGapsOptions: { eras: [], capS: seg.fillGapsMeta.fillGapsOptions.capS, tolerance: seg.fillGapsMeta.fillGapsOptions.tolerance },
          realReadings: 0, filledReadings: 0, flaggedGaps: [],
        };
        fillGapsMeta.fillGapsOptions.eras.push({ ...(seg.label || {}), cadenceS: seg.fillGapsMeta.fillGapsOptions.cadenceS, pointsPerHour: seg.pointsPerHour });
        fillGapsMeta.realReadings += seg.fillGapsMeta.realReadings;
        fillGapsMeta.filledReadings += seg.fillGapsMeta.filledReadings;
        fillGapsMeta.flaggedGaps = fillGapsMeta.flaggedGaps.concat(seg.fillGapsMeta.flaggedGaps);
      }
    }
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour, distHourFine: distHourFine, ...(fillGapsMeta ? { fillGaps: fillGapsMeta } : {})});
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
      res.json(applyFillGaps(result.recordset, req.query));
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
  // Samples per hour at this tag's logging cadence; default 360 (10s cadence).
  // Slower tags need an override, e.g. &pointsPerHour=60 for Hour_OFIL (60s cadence).
  // Not meaningful for on-change loggers with no fixed cadence (LC_CSH).
  const pointsPerHour = Number(req.query.pointsPerHour) > 0 ? Number(req.query.pointsPerHour) : 360;
  try {
    // SQL-side pipeline (gap-fill + counting + TOU-bucketing) — see
    // runCountQuerySql for why this replaced the old fetch-all-rows-into-JS
    // approach (CPU-bound single-thread contention under concurrent load).
    const r = await runCountQuerySql(pool, {
      floatTable: '[REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]',
      tagTable: '[REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]',
      tagIndex, tbf, taf, threshold: thresholdValue, pointsPerHour, query: req.query,
    });
    res.json({tagIndex: tagIndex, tagName: r.tagName, date_before:tbf, date_after:taf, count: r.count, hour: r.hour, distHour: r.distHour, distHourFine: r.distHourFine, ...(r.fillGapsMeta ? { fillGaps: r.fillGapsMeta } : {})});
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