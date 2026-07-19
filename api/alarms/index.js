// Alarm-event module — read-only endpoints over [Alarm_Event].[dbo].[AllEvent]
// (FactoryTalk Alarms & Events historian). Mounted at /api/alm by app.js.
//
// STRICTLY READ-ONLY: SELECT queries only, all parameterized via mssql
// tagged-template literals.
//
// Timezone: unlike the REPL_* historian DBs (naive local time), FactoryTalk
// stores EventTimeStamp in TRUE UTC (verified 2026-07-10: MAX(EventTimeStamp)
// tracks GETUTCDATE() within seconds). Two consequences, baked into every
// query below:
//   1. Time-window filters compare against GETUTCDATE(), never GETDATE().
//   2. Returned timestamps are shifted +7h (DATEADD(HOUR, 7, ...)) so the wire
//      format matches the rest of this API: plant wall-clock time (ICT, no
//      DST) with a fake Z suffix. Do not "fix" either direction.
const PLANT_TZ_OFFSET_HOURS = 7;
const express = require('express');
const router = express.Router();
const { intParam, boolParam, dateParam } = require('./params');
const { alarmRoute } = require('./pool');
// Performance: every time filter below seeks the clustered TicksTimeStamp
// index instead of comparing EventTimeStamp (unindexed -> full table scan that
// slows down as the table grows). See ticks.js for the proof of equivalence.
const { toFileTicks, ticksRange, hoursAgo } = require('./ticks');

const bad = (res, error) => res.status(400).json({ error });

// Self-documenting usage listing (static — works even while the DB is down).
router.get('/', (req, res) => {
  res.json([
    { message: ['FactoryTalk Alarms & Events historian (Alarm_Event.dbo.AllEvent) — read-only',
                'example : http://172.30.1.112:3334/api/alm/recent?limit=10',
                'example : http://172.30.1.112:3334/api/alm/source/RRM_Motor_Temp?limit=20&hours=168'] },
    { function_list: [
      '/recent?limit=50&excludeFaults=true&source=&condition=&group=&hours=&from=&to=   ==latest events, newest first (limit 1-5000; excludeFaults drops "Alarm fault%" noise; optional exact SourceName filter; optional exact ConditionName filter e.g. condition=TRIP; optional exact GroupPath filter, values from /groups; time window: hours 1-720 OR absolute from/to in plant local time e.g. from=2026-07-10%2008:00:00&to=2026-07-10%2012:00:00)',
      '/active?condition=&group=&acked=&hours=168   ==alarms standing RIGHT NOW (latest event per source+condition has Active=1) e.g. /active?condition=TRIP; acked=false shows only unacknowledged; hours bounds the look-back (1-720)',
      '/groups?hours=   ==list every plant/area (distinct GroupPath) with event counts; pass one of these values as the group= filter on /recent and /noisy',
      '/daily?days=14   ==events per day split real vs quality-fault (days 1-90)',
      '/noisy?hours=24&top=10&group=   ==top chattering sources by event count (hours 1-720, top 1-50; optional exact GroupPath filter)',
      '/faults?hours=24&top=20   ==quality-fault ("quality is bad") counts per source (hours 1-720, top 1-50)',
      '/source/{sourceName}?limit=100&hours=168&condition=&from=&to=   ==event history for one source (limit 1-5000; hours 1-720 OR absolute from/to in plant local time; optional exact ConditionName filter)',
      '/dbhealth   ==data-file usage vs the 10GB SQL Express limit + logging heartbeat',
    ] },
  ]);
});

// Resolve the optional time window shared by /recent and /source: either a
// relative ?hours= look-back or an absolute ?from=/?to= range (plant local
// time, converted to UTC by dateParam). Returns {fromUtc, toUtc} (either may
// be null = unbounded) or {error}.
function timeWindow(query, hoursDefault) {
  const hours = intParam(query.hours, 'hours', null, 1, 720);
  if (hours.error) return { error: hours.error };
  const from = dateParam(query.from, 'from', PLANT_TZ_OFFSET_HOURS);
  if (from.error) return { error: from.error };
  const to = dateParam(query.to, 'to', PLANT_TZ_OFFSET_HOURS);
  if (to.error) return { error: to.error };
  if ((from.value || to.value) && hours.value !== null) {
    return { error: 'use either hours or from/to, not both' };
  }
  if (from.value && to.value && from.value > to.value) {
    return { error: 'from must not be after to' };
  }
  if (from.value || to.value) return { fromUtc: from.value, toUtc: to.value };
  const h = hours.value !== null ? hours.value : hoursDefault;
  return { fromUtc: h === null ? null : new Date(Date.now() - h * 3600000), toUtc: null };
}

// 3.1 Latest alarm events. Time window: optional ?hours= look-back OR absolute
// ?from=/?to= range (omit all = no time filter, pure newest-first).
router.get('/recent', alarmRoute(async (req, res, pool) => {
  const limit = intParam(req.query.limit, 'limit', 50, 1, 5000);
  if (limit.error) return bad(res, limit.error);
  const win = timeWindow(req.query, null);
  if (win.error) return bad(res, win.error);
  const excl = boolParam(req.query.excludeFaults, 'excludeFaults', true);
  if (excl.error) return bad(res, excl.error);
  let source = null;
  if (req.query.source !== undefined && req.query.source !== '') {
    if (typeof req.query.source !== 'string') return bad(res, 'source must be a string');
    source = req.query.source;
  }
  let condition = null;
  if (req.query.condition !== undefined && req.query.condition !== '') {
    if (typeof req.query.condition !== 'string') return bad(res, 'condition must be a string');
    condition = req.query.condition;
  }
  // group = exact GroupPath value as returned by /groups,
  // e.g. group=Ball Mill.Alarm_BallMill
  let group = null;
  if (req.query.group !== undefined && req.query.group !== '') {
    if (typeof req.query.group !== 'string') return bad(res, 'group must be a string');
    group = req.query.group;
  }
  // Time window as a ticks range (sentinel-bounded, see ticks.js) so the query
  // seeks the clustered index and TOP stops early — instead of scanning +
  // sorting the whole table on unindexed EventTimeStamp. ORDER BY
  // TicksTimeStamp DESC is the same newest-first order (EventTimeStamp is
  // TicksTimeStamp truncated to ms; only sub-millisecond ties can reorder).
  const { fromTicks, toTicks } = ticksRange(win.fromUtc, win.toUtc);
  const result = await pool.request().query`
    SELECT TOP (${limit.value})
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, EventTimeStamp) AS EventTimeStamp,
        SourceName, ConditionName, SubConditionName,
        Severity, Priority, Message, InputValue, LimitValue, Active, Acked
    FROM dbo.AllEvent
    WHERE (${excl.value} = 0 OR Message NOT LIKE 'Alarm fault%' OR Message IS NULL)
      AND (${source} IS NULL OR SourceName = ${source})
      AND (${condition} IS NULL OR ConditionName = ${condition})
      AND (${group} IS NULL OR GroupPath = ${group})
      AND TicksTimeStamp >= ${fromTicks}
      AND TicksTimeStamp <= ${toTicks}
    ORDER BY TicksTimeStamp DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.1b Currently-active alarms. AllEvent is an event LOG (each row is a
// snapshot), so "active now" = the LATEST event per (SourceName,ConditionName)
// has Active=1. ROW_NUMBER picks that latest event inside a bounded look-back
// window (?hours=, default 168) — an alarm standing longer than the window
// would be missed, so raise hours (max 720) if the plant leaves alarms up for
// weeks. Optional ?condition= (e.g. TRIP), ?group=, ?acked= (false = only
// unacknowledged) narrow the result.
router.get('/active', alarmRoute(async (req, res, pool) => {
  const hours = intParam(req.query.hours, 'hours', 168, 1, 720);
  if (hours.error) return bad(res, hours.error);
  const acked = boolParam(req.query.acked, 'acked', null);
  if (acked.error) return bad(res, acked.error);
  let condition = null;
  if (req.query.condition !== undefined && req.query.condition !== '') {
    if (typeof req.query.condition !== 'string') return bad(res, 'condition must be a string');
    condition = req.query.condition;
  }
  let group = null;
  if (req.query.group !== undefined && req.query.group !== '') {
    if (typeof req.query.group !== 'string') return bad(res, 'group must be a string');
    group = req.query.group;
  }
  const result = await pool.request().query`
    SELECT EventTimeStamp, SourceName, ConditionName, SubConditionName,
           Severity, Priority, Message, InputValue, LimitValue, Active, Acked, GroupPath
    FROM (
        SELECT DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, EventTimeStamp) AS EventTimeStamp,
               SourceName, ConditionName, SubConditionName,
               Severity, Priority, Message, InputValue, LimitValue, Active, Acked, GroupPath,
               ROW_NUMBER() OVER (PARTITION BY SourceName, ConditionName
                                  ORDER BY TicksTimeStamp DESC) AS rn
        FROM dbo.AllEvent
        WHERE (Message NOT LIKE 'Alarm fault%' OR Message IS NULL)
          AND (${condition} IS NULL OR ConditionName = ${condition})
          AND (${group} IS NULL OR GroupPath = ${group})
          AND TicksTimeStamp >= ${toFileTicks(hoursAgo(hours.value))}
    ) latest
    WHERE rn = 1 AND Active = 1
      AND (${acked.value} IS NULL OR Acked = ${acked.value})
    ORDER BY Severity DESC, EventTimeStamp DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.2 Events per day, real vs quality-fault (trend chart)
router.get('/daily', alarmRoute(async (req, res, pool) => {
  const days = intParam(req.query.days, 'days', 14, 1, 90);
  if (days.error) return bad(res, days.error);
  // Buckets are plant-local calendar days: shift UTC +7h before CAST(...AS date).
  // The shift is computed once in a derived table and grouped by its alias —
  // repeating the DATEADD in SELECT and GROUP BY fails (error 8120) because
  // each ${...} interpolation becomes a distinct SQL parameter, making the two
  // expressions look different to SQL Server. The window bound (plant-local
  // midnight N days ago, expressed back in UTC) is computed in JS and applied
  // as a ticks seek on the clustered index.
  const plantNow = new Date(Date.now() + PLANT_TZ_OFFSET_HOURS * 3600000);
  const windowStartUtc = new Date(Date.UTC(
    plantNow.getUTCFullYear(), plantNow.getUTCMonth(), plantNow.getUTCDate() - days.value,
  ) - PLANT_TZ_OFFSET_HOURS * 3600000);
  const result = await pool.request().query`
    SELECT
        event_date,
        SUM(CASE WHEN Message LIKE 'Alarm fault%' THEN 0 ELSE 1 END) AS real_events,
        SUM(CASE WHEN Message LIKE 'Alarm fault%' THEN 1 ELSE 0 END) AS fault_events,
        COUNT(*) AS total_events
    FROM (
        SELECT CAST(DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, EventTimeStamp) AS date) AS event_date,
               Message
        FROM dbo.AllEvent
        WHERE TicksTimeStamp >= ${toFileTicks(windowStartUtc)}
    ) shifted
    GROUP BY event_date
    ORDER BY event_date`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.3 Top chattering sources. Optional ?group= restricts to one plant/area
// (exact GroupPath value, same semantics as /recent).
router.get('/noisy', alarmRoute(async (req, res, pool) => {
  const hours = intParam(req.query.hours, 'hours', 24, 1, 720);
  if (hours.error) return bad(res, hours.error);
  const top = intParam(req.query.top, 'top', 10, 1, 50);
  if (top.error) return bad(res, top.error);
  let group = null;
  if (req.query.group !== undefined && req.query.group !== '') {
    if (typeof req.query.group !== 'string') return bad(res, 'group must be a string');
    group = req.query.group;
  }
  const result = await pool.request().query`
    SELECT TOP (${top.value})
        SourceName, ConditionName,
        COUNT(*) AS event_count,
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MIN(EventTimeStamp)) AS first_event,
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MAX(EventTimeStamp)) AS last_event
    FROM dbo.AllEvent
    WHERE TicksTimeStamp >= ${toFileTicks(hoursAgo(hours.value))}
      AND (${group} IS NULL OR GroupPath = ${group})
    GROUP BY SourceName, ConditionName
    ORDER BY event_count DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.3b Plant/area listing: every distinct GroupPath with event counts.
// GroupPath format is "<plant area>.<Alarm_|Event_ group>", e.g.
// "Ball Mill.Alarm_BallMill" — the prefix before the dot is the plant.
// Optional ?hours= restricts the counts to a window (default: all time).
router.get('/groups', alarmRoute(async (req, res, pool) => {
  const hours = intParam(req.query.hours, 'hours', null, 1, 720);
  if (hours.error) return bad(res, hours.error);
  const result = hours.value === null
    ? await pool.request().query`
        SELECT GroupPath,
               COUNT(*) AS event_count,
               DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MAX(EventTimeStamp)) AS last_event
        FROM dbo.AllEvent
        GROUP BY GroupPath
        ORDER BY event_count DESC`
    : await pool.request().query`
        SELECT GroupPath,
               COUNT(*) AS event_count,
               DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MAX(EventTimeStamp)) AS last_event
        FROM dbo.AllEvent
        WHERE TicksTimeStamp >= ${toFileTicks(hoursAgo(hours.value))}
        GROUP BY GroupPath
        ORDER BY event_count DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.4 Data-file usage vs the 10GB SQL Express limit + logging heartbeat
router.get('/dbhealth', alarmRoute(async (req, res, pool) => {
  const files = await pool.request().query`
    SELECT
        CAST(SUM(size) * 8.0 / 1024 AS decimal(18,2))                           AS file_size_mb,
        CAST(SUM(FILEPROPERTY(name,'SpaceUsed')) * 8.0 / 1024 AS decimal(18,2)) AS used_mb,
        CAST(10240 - SUM(FILEPROPERTY(name,'SpaceUsed')) * 8.0 / 1024
             AS decimal(18,2))                                                  AS headroom_mb
    FROM sys.database_files
    WHERE type_desc = 'ROWS'`;
  // Heartbeat via TOP 1 on the clustered TicksTimeStamp index (instant) —
  // MAX(EventTimeStamp) would scan the whole table. total_rows comes from the
  // catalog (sys.partitions.rows is nominally approximate but exact enough for
  // monitoring; CAST to int keeps the JSON a number — safe, the 10GB cap bounds
  // the table far below int range).
  const heartbeat = await pool.request().query`
    SELECT
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, n.newest) AS newest_event,
        DATEDIFF(MINUTE, n.newest, GETUTCDATE()) AS minutes_since_last,
        (SELECT CAST(SUM(p.rows) AS int) FROM sys.partitions p
         WHERE p.object_id = OBJECT_ID('dbo.AllEvent') AND p.index_id IN (0, 1)) AS total_rows
    FROM (SELECT (SELECT TOP (1) EventTimeStamp FROM dbo.AllEvent
                  ORDER BY TicksTimeStamp DESC) AS newest) n`;
  const f = files.recordset[0];
  const h = heartbeat.recordset[0];
  res.json({
    file_size_mb: f.file_size_mb,
    used_mb: f.used_mb,
    headroom_mb: f.headroom_mb,
    limit_mb: 10240,
    pct_used: f.used_mb == null ? null : Math.round(f.used_mb / 10240 * 1000) / 10,
    newest_event: h.newest_event,
    minutes_since_last: h.minutes_since_last,
    total_rows: h.total_rows,
    logging_ok: h.minutes_since_last != null && h.minutes_since_last < 120,
  });
}));

// 3.5 Quality-fault analysis (correlates with KEPServerEX crash-restarts)
router.get('/faults', alarmRoute(async (req, res, pool) => {
  const hours = intParam(req.query.hours, 'hours', 24, 1, 720);
  if (hours.error) return bad(res, hours.error);
  const top = intParam(req.query.top, 'top', 20, 1, 50);
  if (top.error) return bad(res, top.error);
  const result = await pool.request().query`
    SELECT TOP (${top.value})
        SourceName,
        COUNT(*) AS fault_count,
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MIN(EventTimeStamp)) AS first_fault,
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, MAX(EventTimeStamp)) AS last_fault
    FROM dbo.AllEvent
    WHERE Message LIKE '%quality is bad%'
      AND TicksTimeStamp >= ${toFileTicks(hoursAgo(hours.value))}
    GROUP BY SourceName
    ORDER BY fault_count DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

// 3.6 Event history for one source (drill-down from /noisy)
router.get('/source/:sourceName', alarmRoute(async (req, res, pool) => {
  const sourceName = req.params.sourceName;
  if (typeof sourceName !== 'string' || sourceName.length < 1 || sourceName.length > 255) {
    return bad(res, 'sourceName must be 1-255 characters');
  }
  const limit = intParam(req.query.limit, 'limit', 100, 1, 5000);
  if (limit.error) return bad(res, limit.error);
  const win = timeWindow(req.query, 168); // default look-back 168h unless from/to given
  if (win.error) return bad(res, win.error);
  let condition = null;
  if (req.query.condition !== undefined && req.query.condition !== '') {
    if (typeof req.query.condition !== 'string') return bad(res, 'condition must be a string');
    condition = req.query.condition;
  }
  // The SourceName seek uses AE_SOURCENAME_IDX; its rows carry the clustered
  // key, so the ticks bounds narrow that seek and ORDER BY TicksTimeStamp
  // avoids a sort (same newest-first order, see /recent).
  const { fromTicks, toTicks } = ticksRange(win.fromUtc, win.toUtc);
  const result = await pool.request().query`
    SELECT TOP (${limit.value})
        DATEADD(HOUR, ${PLANT_TZ_OFFSET_HOURS}, EventTimeStamp) AS EventTimeStamp,
        ConditionName, SubConditionName, Severity,
        Message, InputValue, LimitValue, Active, Acked
    FROM dbo.AllEvent
    WHERE SourceName = ${sourceName}
      AND (${condition} IS NULL OR ConditionName = ${condition})
      AND TicksTimeStamp >= ${fromTicks}
      AND TicksTimeStamp <= ${toTicks}
    ORDER BY TicksTimeStamp DESC`;
  res.json({ count: result.recordset.length, rows: result.recordset });
}));

module.exports = router;
