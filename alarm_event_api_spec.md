# Add `Alarm_Event` Database to Production API (Port 3334)

Handoff document for Claude Code. Goal: add read-only REST endpoints for the
FactoryTalk Alarms & Events historian (`Alarm_Event`) to the existing Node.js
production API on **port 3334**, following the established `plants.js` patterns.

---

## 0. Hard Constraints

1. **STRICTLY READ-ONLY.** `SELECT` queries only. No endpoint may `INSERT`,
   `UPDATE`, `DELETE`, or DDL against `Alarm_Event`.
2. **Parameterized queries only** (`request.input(...)`) — never string-concatenate
   user input into SQL.
3. Follow the existing codebase conventions: named `ConnectionPool` per database
   (mssql package), not the global `sql.connect()` singleton.
4. Route prefix: **`/api/alm/`** (avoids conflicts with existing `/api/` Graph
   Builder and `/api/rpt/` Daily Report routes).
5. All endpoints return JSON. Errors return `{ "error": "<message>" }` with
   appropriate HTTP status (400 bad params, 500 server error).

## 1. Database Connection

| Item | Value |
|---|---|
| API host (this service) | `172.30.1.112:3334` |
| SQL Server (remote) | `172.30.1.225` |
| Database | `Alarm_Event` |
| Table | `dbo.AllEvent` (single data table; no foreign keys) |
| Edition | SQL Server **Express** (10 GB per-DB limit — relevant to `/dbhealth`) |
| Auth | Same credential style as existing pools; **prefer a login with only `db_datareader` on `Alarm_Event`** |

### Pool config (follow existing `plants.js` named-pool pattern)

```javascript
// pools/alarmEventPool.js
const sql = require('mssql');

const alarmEventConfig = {
  server: '172.30.1.225',
  database: 'Alarm_Event',
  user: process.env.ALARM_DB_USER,       // read-only login preferred
  password: process.env.ALARM_DB_PASS,
  options: {
    encrypt: false,               // match existing internal-network settings
    trustServerCertificate: true,
    requestTimeout: 30000
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

const alarmPool = new sql.ConnectionPool(alarmEventConfig);
const alarmPoolConnect = alarmPool.connect();

alarmPool.on('error', err => console.error('[Alarm_Event pool]', err));

module.exports = { alarmPool, alarmPoolConnect };
```

Every route awaits `alarmPoolConnect` before using the pool (same pattern used
after the singleton→named-pool migration).

## 2. Table Schema Reference — `dbo.AllEvent`

Columns the API uses (verified 2026-07-09):

| Column | Type | Use |
|---|---|---|
| `EventTimeStamp` | datetime2 | Time filter/sort column for everything |
| `SourceName` | nvarchar | Alarm tag/source |
| `SourcePath` | nvarchar | Full source path |
| `ConditionName` | nvarchar | HIHI / HI / LO / etc. |
| `SubConditionName` | nvarchar | |
| `Severity` | int | Higher = worse |
| `Priority` | int | |
| `Message` | nvarchar | Quality-fault noise starts with `Alarm fault` |
| `Active` | bit | |
| `Acked` | bit | |
| `InputValue` | float | Process value at event |
| `LimitValue` | float | Alarm limit at event |
| `EventID` | uniqueidentifier | Row identity |

**Filtering convention:**
- Exclude noise: `(Message NOT LIKE 'Alarm fault%' OR Message IS NULL)`
- Faults only: `Message LIKE 'Alarm fault%'`

## 3. Endpoints

### 3.1 `GET /api/alm/recent`

Latest alarm events.

| Query param | Type | Default | Limits |
|---|---|---|---|
| `limit` | int | 50 | 1–500 |
| `excludeFaults` | bool | `true` | |
| `source` | string | (none) | optional exact SourceName filter |

```sql
SELECT TOP (@limit)
    EventTimeStamp, SourceName, ConditionName, SubConditionName,
    Severity, Priority, Message, InputValue, LimitValue, Active, Acked
FROM dbo.AllEvent
WHERE (@excludeFaults = 0 OR Message NOT LIKE 'Alarm fault%' OR Message IS NULL)
  AND (@source IS NULL OR SourceName = @source)
ORDER BY EventTimeStamp DESC;
```

Response:
```json
{
  "count": 50,
  "rows": [
    {
      "EventTimeStamp": "2026-07-10T08:15:22.123Z",
      "SourceName": "RRM_Motor_Temp",
      "ConditionName": "HIHI",
      "Severity": 750,
      "Message": "Motor temperature high high",
      "InputValue": 92.4,
      "LimitValue": 90.0,
      "Active": true,
      "Acked": false
    }
  ]
}
```

### 3.2 `GET /api/alm/daily`

Events per day, split real vs quality-fault (for the trend chart).

| Query param | Type | Default | Limits |
|---|---|---|---|
| `days` | int | 14 | 1–90 |

```sql
SELECT
    CAST(EventTimeStamp AS date) AS event_date,
    SUM(CASE WHEN Message LIKE 'Alarm fault%' THEN 0 ELSE 1 END) AS real_events,
    SUM(CASE WHEN Message LIKE 'Alarm fault%' THEN 1 ELSE 0 END) AS fault_events,
    COUNT(*) AS total_events
FROM dbo.AllEvent
WHERE EventTimeStamp >= DATEADD(DAY, -@days, CAST(GETDATE() AS date))
GROUP BY CAST(EventTimeStamp AS date)
ORDER BY event_date;
```

### 3.3 `GET /api/alm/noisy`

Top chattering sources.

| Query param | Type | Default | Limits |
|---|---|---|---|
| `hours` | int | 24 | 1–720 |
| `top` | int | 10 | 1–50 |

```sql
SELECT TOP (@top)
    SourceName, ConditionName,
    COUNT(*) AS event_count,
    MIN(EventTimeStamp) AS first_event,
    MAX(EventTimeStamp) AS last_event
FROM dbo.AllEvent
WHERE EventTimeStamp >= DATEADD(HOUR, -@hours, GETDATE())
GROUP BY SourceName, ConditionName
ORDER BY event_count DESC;
```

### 3.4 `GET /api/alm/dbhealth`

Data-file usage vs the 10 GB Express limit + logging heartbeat.

```sql
SELECT
    CAST(SUM(size) * 8.0 / 1024 AS decimal(18,2))                          AS file_size_mb,
    CAST(SUM(FILEPROPERTY(name,'SpaceUsed')) * 8.0 / 1024 AS decimal(18,2)) AS used_mb,
    CAST(10240 - SUM(FILEPROPERTY(name,'SpaceUsed')) * 8.0 / 1024
         AS decimal(18,2))                                                  AS headroom_mb
FROM sys.database_files
WHERE type_desc = 'ROWS';
```

```sql
SELECT
    MAX(EventTimeStamp) AS newest_event,
    DATEDIFF(MINUTE, MAX(EventTimeStamp), GETDATE()) AS minutes_since_last,
    COUNT(*) AS total_rows
FROM dbo.AllEvent;
```

Combine both into one response:
```json
{
  "file_size_mb": 11984.0,
  "used_mb": 3036.5,
  "headroom_mb": 7203.5,
  "limit_mb": 10240,
  "pct_used": 29.7,
  "newest_event": "2026-07-10T08:15:22.123Z",
  "minutes_since_last": 3,
  "total_rows": 152340,
  "logging_ok": true          // minutes_since_last < 120
}
```

### 3.5 `GET /api/alm/faults`

Quality-fault analysis (correlates with KEPServerEX crash-restarts).

| Query param | Type | Default | Limits |
|---|---|---|---|
| `hours` | int | 24 | 1–720 |
| `top` | int | 20 | 1–50 |

```sql
SELECT TOP (@top)
    SourceName,
    COUNT(*) AS fault_count,
    MIN(EventTimeStamp) AS first_fault,
    MAX(EventTimeStamp) AS last_fault
FROM dbo.AllEvent
WHERE Message LIKE '%quality is bad%'
  AND EventTimeStamp >= DATEADD(HOUR, -@hours, GETDATE())
GROUP BY SourceName
ORDER BY fault_count DESC;
```

### 3.6 `GET /api/alm/source/:sourceName`

Event history for one source (drill-down from the noisy list).

| Param | Type | Default | Limits |
|---|---|---|---|
| `:sourceName` | string (URL) | required | |
| `limit` | int | 100 | 1–500 |
| `hours` | int | 168 | 1–720 |

```sql
SELECT TOP (@limit)
    EventTimeStamp, ConditionName, SubConditionName, Severity,
    Message, InputValue, LimitValue, Active, Acked
FROM dbo.AllEvent
WHERE SourceName = @sourceName
  AND EventTimeStamp >= DATEADD(HOUR, -@hours, GETDATE())
ORDER BY EventTimeStamp DESC;
```

## 4. Implementation Notes

1. **Route file:** create `routes/alarms.js` (or match whatever naming the repo
   uses, e.g. alongside `plants.js`), mount with
   `app.use('/api/alm', require('./routes/alarms'))`.
2. **Param validation:** clamp all int params to the limits above; return 400
   with `{ "error": "limit must be 1-500" }` style messages on bad input.
   Use `sql.Int`, `sql.NVarChar`, `sql.Bit` types on every `request.input()`.
3. **`TOP (@limit)`** works with a parameter in SQL Server — no string building.
4. **Datetime handling:** `EventTimeStamp` is `datetime2` with no timezone info;
   server local time is ICT (UTC+7). Return ISO strings as mssql provides them
   and note this in the route file — don't apply timezone conversion in SQL.
5. **No caching required** for v1; poll intervals from Node-RED are 30–60 s and
   queries are cheap. If `/daily` gets slow later, cache 60 s in memory.
6. **Performance caveat:** check whether `dbo.AllEvent` has an index on
   `EventTimeStamp` (section 13 of `alarm_event_investigation.sql`). FTAE
   schemas often index `EventID` only. If time-range queries get slow as rows
   grow, flag it — **do NOT create the index from the API**; Jim will add it
   manually in SSMS if needed.
7. **Startup:** the API must start even if `Alarm_Event` is unreachable —
   catch pool connect errors, log them, and have routes return 503
   `{ "error": "Alarm_Event database unavailable" }` until it reconnects
   (same resilience expectation as the other pools).

## 5. Smoke Tests

```bash
curl "http://172.30.1.112:3334/api/alm/dbhealth"
curl "http://172.30.1.112:3334/api/alm/recent?limit=10"
curl "http://172.30.1.112:3334/api/alm/recent?limit=10&excludeFaults=false"
curl "http://172.30.1.112:3334/api/alm/daily?days=7"
curl "http://172.30.1.112:3334/api/alm/noisy?hours=24&top=5"
curl "http://172.30.1.112:3334/api/alm/faults?hours=48"
curl "http://172.30.1.112:3334/api/alm/source/RRM_Motor_Temp?limit=20"
# Validation checks — must return 400:
curl "http://172.30.1.112:3334/api/alm/recent?limit=9999"
curl "http://172.30.1.112:3334/api/alm/daily?days=-1"
```

## 6. Definition of Done

- [ ] `pools/alarmEventPool.js` created with named pool, env-var credentials.
- [ ] `routes/alarms.js` mounted at `/api/alm/` with all six endpoints.
- [ ] Every query parameterized; all int params clamped; 400s on bad input.
- [ ] `/dbhealth` returns `logging_ok` and `headroom_mb` correctly.
- [ ] API survives `Alarm_Event` being offline (503, auto-reconnect).
- [ ] All smoke tests pass.
- [ ] Zero write statements anywhere in the new code (grep for
      `DELETE|UPDATE|INSERT|ALTER|TRUNCATE|DROP` in the new files → no hits).
