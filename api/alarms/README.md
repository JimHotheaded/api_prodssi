# Alarm-Event API Manual (`/api/alm`)

Read-only REST endpoints over the FactoryTalk Alarms & Events historian
(`[Alarm_Event].[dbo].[AllEvent]` on SQL Server `192.168.100.100`, SQL Express).
Serves Node-RED dashboards and other plant consumers.

Base URL (production): `http://172.30.1.112:3334/api/alm`

---

## Common behavior (applies to every endpoint)

**Read-only.** All queries are parameterized `SELECT`s. Nothing here can write
to the database.

**Timestamps.** Unlike the `REPL_*` historian databases, FactoryTalk stores
`EventTimeStamp` in **true UTC** (verified 2026-07-10). The API compensates:
time-window filters (`hours=`, `days=`) run against UTC internally, and all
returned timestamps are shifted **+7 h to plant wall-clock time (ICT)** before
serialization. So the wire format matches every other endpoint on this API:
an ISO string with a fake `Z` suffix, e.g. `"2026-07-10T15:35:16.335Z"` —
**read it as plant local time, not UTC**. `/daily` buckets are plant-local
calendar days. Do not convert.

**Errors.** Always JSON:

| Status | Body | When |
|---|---|---|
| 400 | `{"error": "limit must be 1-5000"}` (message names the bad param) | Bad query/path parameter |
| 500 | `{"error": "Server error"}` | Query failed (details in server log) |
| 503 | `{"error": "Alarm_Event database unavailable"}` | Alarm_Event DB unreachable; retries automatically on each request, recovers without a restart. `/plants` is unaffected. |

**Parameter rules.** Omitted or empty parameter → its default. Present but
non-integer, or outside the allowed range → **400** (values are never silently
clamped). Booleans accept `true`/`false`/`1`/`0` (case-insensitive).

**Event-row fields** (returned by `/recent`, `/active`, and `/source/...`):

| Field | Type | Meaning |
|---|---|---|
| `EventTimeStamp` | string | When the event occurred (plant local time, see above) |
| `SourceName` | string | Alarm tag/source, e.g. `RRM_Motor_Temp` |
| `ConditionName` | string | Alarm condition. Values in this plant's data: `EVENT`, `TRIP`, `HI`, `LO` (plus one historical `TRIP_L`) |
| `SubConditionName` | string | Sub-condition of the alarm state |
| `Severity` | int | FactoryTalk severity, higher = worse (e.g. 900 = trip, 100 = info) |
| `Priority` | int | FactoryTalk priority class |
| `Message` | string | Alarm text. Quality-fault noise starts with `Alarm fault` |
| `InputValue` | float | Process value at the moment of the event |
| `LimitValue` | float\|null | Alarm limit that was crossed (null for info events) |
| `Active` | bool\|null | Alarm currently active at event time |
| `Acked` | bool\|null | Alarm acknowledged at event time |

---

## `GET /api/alm/`

Self-documenting usage listing (same spirit as `GET /plants/`). Static — works
even while the database is down. Returns an array with a `message` block
(examples) and a `function_list` block (one usage line per endpoint).

---

## `GET /api/alm/recent`

**Meaning:** the latest alarm events across the whole plant, newest first.
The default view for an "active alarms" style dashboard panel.

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `limit` | int | 50 | 1–5000 | Max rows returned |
| `hours` | int | (none) | 1–720 | Only events from the last *N* hours. Omitted = no time filter, pure newest-first |
| `from` / `to` | datetime | (none) | | Absolute window in **plant local time**, format `YYYY-MM-DD HH:mm:ss` (seconds/millis optional, `T` or `%20` as separator). Either bound may be given alone (open-ended). Inclusive. Cannot be combined with `hours` (400) |
| `excludeFaults` | bool | `true` | | Drop quality-fault noise (`Message LIKE 'Alarm fault%'`). Pass `false` to see everything |
| `source` | string | (none) | | Exact `SourceName` filter — only events from this one source |
| `condition` | string | (none) | | Exact `ConditionName` filter — e.g. `condition=TRIP` for trips only, `condition=EVENT` for events only (also `HI`, `LO`). One value per request; combines with all other params |
| `group` | string | (none) | | Plant/area filter: **exact** `GroupPath` value, e.g. `group=Ball Mill.Alarm_BallMill`. Pick a value from `/groups` |

**Example:** `GET /api/alm/recent?limit=3&source=CV_2_OPEN_CMN`

**Only TRIPs in the last 24 h:** `GET /api/alm/recent?hours=24&condition=TRIP&limit=5000`

**One plant/area only:** `GET /api/alm/recent?hours=24&group=Ball%20Mill.Alarm_BallMill&limit=5000`
(URL-encode spaces as `%20`; the value must match a `GroupPath` from `/groups` exactly)

**Specific datetime range** (plant local time, `%20` = the space between date and time):
`GET /api/alm/recent?from=2026-07-10%2008:00:00&to=2026-07-10%2012:00:00&limit=5000`
— everything between 08:00 and 12:00 plant time on Jul 10. `from=` alone means
"from then until now"; `to=` alone means "everything up to then".

**All alarms within the last hour:** `GET /api/alm/recent?hours=1&limit=5000`
(`count < 5000` means you got the complete hour; `count = 5000` means the hour
was busier than the cap and the oldest events of the hour were cut off).

**Returns** `{count, rows}` — `count` is the number of rows actually returned
(may be less than `limit`), `rows` is an array of event rows (fields above):

```json
{
  "count": 3,
  "rows": [
    {
      "EventTimeStamp": "2026-07-10T08:08:35.443Z",
      "SourceName": "SUB_TANNK_ITEM1_HI_LEVEL",
      "ConditionName": "TRIP",
      "SubConditionName": "TRIP",
      "Severity": 900,
      "Priority": 4,
      "Message": "SUB TANNK ITEM1 HI LEVEL",
      "InputValue": 1,
      "LimitValue": 0,
      "Active": false,
      "Acked": true
    }
  ]
}
```

---

## `GET /api/alm/active`

**Meaning:** alarms standing **right now**. `AllEvent` is an event log, so
this takes the *latest* event of each alarm (per `SourceName` +
`ConditionName`) inside the look-back window and returns it only if that
latest event has `Active = true`. The go-to endpoint for an "active alarm
summary" panel — e.g. all TRIPs currently in effect.

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `condition` | string | (none) | | Exact `ConditionName`, e.g. `condition=TRIP` |
| `group` | string | (none) | | Exact `GroupPath` value (see `/groups`) |
| `acked` | bool | (none) | | `false` = only unacknowledged standing alarms; `true` = only acknowledged; omitted = both |
| `hours` | int | 168 | 1–720 | Look-back window used to find each alarm's latest event. An alarm standing longer than the window is missed — raise this if alarms stay up for weeks |

Quality-fault noise (`Alarm fault%`) is always excluded.

**Example:** `GET /api/alm/active?condition=TRIP`

**Returns** `{count, rows}` ordered by `Severity` (worst first), then newest.
Rows are event rows plus `GroupPath`, and every row has `Active: true`:

```json
{
  "count": 4,
  "rows": [
    {
      "EventTimeStamp": "2026-07-10T15:50:31.329Z",
      "SourceName": "Sub_Tank_Ball_2_Low_Level",
      "ConditionName": "TRIP",
      "SubConditionName": "TRIP",
      "Severity": 900,
      "Message": "Sub Tank Ball 2 Low Level",
      "InputValue": 0,
      "LimitValue": 0,
      "Active": true,
      "Acked": false,
      "GroupPath": "Ball Mill.Alarm_BallMill"
    }
  ]
}
```

---

## `GET /api/alm/daily`

**Meaning:** events per calendar day for the last *N* days, split into real
alarms vs quality-fault noise. Feeds the alarm-trend chart; a day where
`fault_events` dwarfs `real_events` usually marks a KEPServerEX crash/restart.

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `days` | int | 14 | 1–90 | How many days back from today (inclusive) |

**Example:** `GET /api/alm/daily?days=7`

**Returns** `{count, rows}`; one row per day **that had at least one event**
(quiet days are absent, not zero-filled), ascending by date:

```json
{
  "count": 3,
  "rows": [
    {
      "event_date": "2026-07-08T00:00:00.000Z",
      "real_events": 69512,
      "fault_events": 712586,
      "total_events": 782098
    },
    {
      "event_date": "2026-07-09T00:00:00.000Z",
      "real_events": 14151,
      "fault_events": 399,
      "total_events": 14550
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `event_date` | The day (midnight plant time, fake-Z format) |
| `real_events` | Events whose `Message` does **not** start with `Alarm fault` |
| `fault_events` | Quality-fault noise events (`Alarm fault%`) |
| `total_events` | `real_events + fault_events` |

---

## `GET /api/alm/noisy`

**Meaning:** the top "chattering" alarm sources — which source+condition pairs
fired most often in the last *N* hours. Use it to find nuisance alarms worth
deadbanding or fixing.

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `hours` | int | 24 | 1–720 | Look-back window from now |
| `top` | int | 10 | 1–50 | How many sources to return |
| `group` | string | (none) | | Plant/area filter (exact `GroupPath` value, same as `/recent`) |

**Example:** `GET /api/alm/noisy?hours=24&top=5`

**Returns** `{count, rows}`, ordered by `event_count` descending:

```json
{
  "count": 5,
  "rows": [
    {
      "SourceName": "CV_2_OPEN_CMN",
      "ConditionName": "EVENT",
      "event_count": 1812,
      "first_event": "2026-07-09T15:35:54.622Z",
      "last_event": "2026-07-10T08:04:20.866Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `event_count` | Times this source+condition fired inside the window |
| `first_event` / `last_event` | First and most recent occurrence inside the window |

---

## `GET /api/alm/groups`

**Meaning:** every plant/area in the historian — the distinct `GroupPath`
values with their event counts. The `group=` filter on `/recent` and `/noisy`
takes one of these values **exactly as returned here** (URL-encoded).
`GroupPath` has the form `<plant area>.<Alarm_|Event_ group>`, e.g.
`Ball Mill.Alarm_BallMill`, `Raymond_Mill.Event_RaymondMill` (a plant usually
has one `Alarm_` and one `Event_` group — filter each separately).

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `hours` | int | (none) | 1–720 | Restrict counts to the last *N* hours. Omitted = all time |

**Example:** `GET /api/alm/groups?hours=24`

**Returns** `{count, rows}`, ordered by `event_count` descending:

```json
{
  "count": 24,
  "rows": [
    {
      "GroupPath": "Ball Mill.Alarm_BallMill",
      "event_count": 22630,
      "last_event": "2026-07-10T15:32:13.094Z"
    }
  ]
}
```

---

## `GET /api/alm/dbhealth`

**Meaning:** health of the alarm historian itself — data-file usage against the
SQL Server **Express 10 GB per-database limit**, plus a logging heartbeat. Poll
this to catch "alarm logging silently died" and "database about to hit the
Express ceiling" before they bite.

No parameters.

**Example:** `GET /api/alm/dbhealth`

**Returns** a flat object:

```json
{
  "file_size_mb": 10184,
  "used_mb": 489.19,
  "headroom_mb": 9750.81,
  "limit_mb": 10240,
  "pct_used": 4.8,
  "newest_event": "2026-07-10T15:36:00.471Z",
  "minutes_since_last": 2,
  "total_rows": 803036,
  "logging_ok": true
}
```

| Field | Meaning |
|---|---|
| `file_size_mb` | Allocated size of the data file(s) on disk (MB). Can sit near the limit even when mostly empty — the file is pre-allocated |
| `used_mb` | Space actually used inside the file (MB) — **this** is what counts against the 10 GB Express limit |
| `headroom_mb` | `10240 − used_mb`: how much more data fits before Express refuses writes |
| `limit_mb` | Always `10240` (the Express ceiling, for reference) |
| `pct_used` | `used_mb / 10240` as a percentage, 1 decimal |
| `newest_event` | Timestamp of the most recent row in `AllEvent` (null if table empty) |
| `minutes_since_last` | Minutes since `newest_event` (null if table empty) |
| `total_rows` | Total rows in `AllEvent` |
| `logging_ok` | `true` when `minutes_since_last < 120`. `false` means no event logged for 2+ hours — either the plant is genuinely quiet or alarm logging is down; investigate |

---

## `GET /api/alm/faults`

**Meaning:** quality-fault analysis — which sources reported "quality is bad"
(tag comms lost) in the last *N* hours. Fault bursts across many sources at the
same instant correlate with KEPServerEX crash-restarts.

| Query param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `hours` | int | 24 | 1–720 | Look-back window from now |
| `top` | int | 20 | 1–50 | How many sources to return |

**Example:** `GET /api/alm/faults?hours=48`

**Returns** `{count, rows}`, ordered by `fault_count` descending:

```json
{
  "count": 20,
  "rows": [
    {
      "SourceName": "P2_Screw_Filter_Warning",
      "fault_count": 2,
      "first_fault": "2026-07-09T09:04:25.459Z",
      "last_fault": "2026-07-09T09:06:57.960Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `fault_count` | Number of quality-fault events for this source in the window |
| `first_fault` / `last_fault` | First and most recent fault in the window. Many sources sharing near-identical timestamps = one comms outage / KEPServerEX restart |

---

## `GET /api/alm/source/{sourceName}`

**Meaning:** full event history for **one** alarm source — the drill-down from
`/noisy` or `/recent`. `{sourceName}` is the exact `SourceName`, URL-encoded if
it contains special characters (1–255 characters).

| Param | Type | Default | Allowed | Meaning |
|---|---|---|---|---|
| `{sourceName}` | string (path) | required | 1–255 chars | Exact source to inspect |
| `limit` | int | 100 | 1–5000 | Max rows returned |
| `hours` | int | 168 (7 days) | 1–720 | Look-back window from now |
| `from` / `to` | datetime | (none) | | Absolute window in plant local time (same rules as `/recent`); overrides the 168 h default, cannot combine with `hours` |
| `condition` | string | (none) | | Exact `ConditionName` filter, e.g. `condition=TRIP` |

**Example:** `GET /api/alm/source/CV_2_OPEN_CMN?limit=2&hours=24`

**Returns** `{count, rows}` newest first — same event-row fields as `/recent`
minus `SourceName`/`Priority` (the source is the one you asked for):

```json
{
  "count": 2,
  "rows": [
    {
      "EventTimeStamp": "2026-07-10T08:04:20.866Z",
      "ConditionName": "EVENT",
      "SubConditionName": "EVENT",
      "Severity": 0,
      "Message": "CV_2_OPEN_CMN",
      "InputValue": 0,
      "LimitValue": 0,
      "Active": false,
      "Acked": false
    }
  ]
}
```

An unknown `sourceName` is not an error — it simply returns `{"count": 0, "rows": []}`.

---

## Quick reference

| Endpoint | Purpose | Key params (default) |
|---|---|---|
| `GET /api/alm/` | Usage listing (works offline) | — |
| `GET /api/alm/recent` | Latest events, newest first | `limit` (50), `hours` (none), `from`/`to`, `excludeFaults` (true), `source`, `condition`, `group` |
| `GET /api/alm/active` | Alarms standing right now (latest event Active=1) | `condition`, `group`, `acked`, `hours` (168) |
| `GET /api/alm/groups` | List plants/areas (GroupPath) + counts | `hours` (none = all time) |
| `GET /api/alm/daily` | Events/day, real vs fault | `days` (14) |
| `GET /api/alm/noisy` | Top chattering sources | `hours` (24), `top` (10), `group` |
| `GET /api/alm/dbhealth` | DB size vs 10 GB limit + heartbeat | — |
| `GET /api/alm/faults` | "Quality is bad" fault counts | `hours` (24), `top` (20) |
| `GET /api/alm/source/{name}` | One source's history | `limit` (100), `hours` (168), `from`/`to`, `condition` |

Curl smoke set:

```bash
curl "http://172.30.1.112:3334/api/alm/dbhealth"
curl "http://172.30.1.112:3334/api/alm/recent?limit=10"
curl "http://172.30.1.112:3334/api/alm/recent?limit=10&excludeFaults=false"
curl "http://172.30.1.112:3334/api/alm/recent?hours=24&condition=TRIP&limit=5000"
curl "http://172.30.1.112:3334/api/alm/recent?from=2026-07-10%2008:00:00&to=2026-07-10%2012:00:00&limit=5000"
curl "http://172.30.1.112:3334/api/alm/recent?hours=24&group=Feed%20Raw%20Material.Alarm_FeedRaw_Material"
curl "http://172.30.1.112:3334/api/alm/active?condition=TRIP"
curl "http://172.30.1.112:3334/api/alm/groups?hours=24"
curl "http://172.30.1.112:3334/api/alm/daily?days=7"
curl "http://172.30.1.112:3334/api/alm/noisy?hours=24&top=5"
curl "http://172.30.1.112:3334/api/alm/faults?hours=48"
curl "http://172.30.1.112:3334/api/alm/source/CV_2_OPEN_CMN?limit=20"
curl "http://172.30.1.112:3334/api/alm/recent?limit=9999"                        # -> 400
curl "http://172.30.1.112:3334/api/alm/daily?days=-1"                            # -> 400
curl "http://172.30.1.112:3334/api/alm/recent?hours=1&from=2026-07-10%2008:00:00" # -> 400 (hours vs from/to)
```
