# Handoff: Node-RED Alarm Table with Filter Dropdowns

Handoff document for Claude working in the Node-RED environment. Goal: build a
**dashboard table showing alarm events from the Alarm_Event REST API, with
select-option filters** (plant/group, condition, time range, view mode).

The API side is done, deployed, and verified — you only build the Node-RED
consumer. Full API manual: `api/alarms/README.md` in the API repo; the
essentials are inlined below so this document is self-sufficient.

---

## 1. Environment

| Item | Value |
|---|---|
| API base URL | `http://172.30.1.112:3334/api/alm` (same host as Node-RED, plain HTTP, no auth) |
| API status | Live in production. **Read-only** — it cannot write to anything, so a bad query can't break the plant |
| Data | FactoryTalk Alarms & Events historian, ~800k events, growing ~10–15k/day |
| Dashboard | Check which dashboard package the existing flows use (`node-red-dashboard` 1.x `ui_table`/`ui_dropdown`, or `@flowfuse/node-red-dashboard` 2.x `ui-table`/`ui-dropdown`) and match it — do not introduce a second dashboard framework |
| Existing flows | This Node-RED already polls `http://172.30.1.112:3334/plants/...` — follow the same http-request-node conventions used there |

## 2. CRITICAL: timestamp semantics

Every timestamp the API returns looks like ISO-UTC (`"2026-07-10T15:50:31.329Z"`)
but **is actually plant wall-clock time (ICT, UTC+7) with a fake `Z` suffix** —
the deliberate wire convention of this whole API.

- To display: take the string, strip `T` and everything from the `.` or `Z`:
  `ts.replace('T', ' ').substring(0, 19)` → `2026-07-10 15:50:31`. Done.
- **Never** run it through timezone conversion (`new Date(ts).toLocaleString()`
  on a Bangkok-timezone server would double-shift it +7 h). If you must use a
  `Date` object (e.g. for sorting), read only its **UTC** fields.
- Times you *send* in `from=`/`to=` are also plant wall-clock (see §4).

## 3. Endpoints to use

### 3.1 `GET /recent` — the main table data (view mode "Events")

Query params (all optional, all combinable unless noted):

| Param | Default | Range | Meaning |
|---|---|---|---|
| `limit` | 50 | 1–5000 | Max rows |
| `hours` | (none = no time filter) | 1–720 | Relative look-back window |
| `from` / `to` | (none) | | Absolute window, plant local time `YYYY-MM-DD HH:mm:ss` (seconds optional, `T` or encoded space). Either alone is open-ended. **400 if combined with `hours`** |
| `excludeFaults` | `true` | | `false` includes `Alarm fault%` noise rows |
| `condition` | (none) | | Exact ConditionName: `TRIP`, `EVENT`, `HI`, `LO` |
| `group` | (none) | | Exact GroupPath value from `/groups` (URL-encode it!) |
| `source` | (none) | | Exact SourceName (drill-down) |

Response (`rows` newest-first):

```json
{ "count": 2, "rows": [ {
    "EventTimeStamp": "2026-07-10T15:50:31.329Z",
    "SourceName": "Sub_Tank_Ball_2_Low_Level",
    "ConditionName": "TRIP",
    "SubConditionName": "TRIP",
    "Severity": 900,
    "Priority": 4,
    "Message": "Sub Tank Ball 2 Low Level",
    "InputValue": 0,
    "LimitValue": 0,
    "Active": true,
    "Acked": false } ] }
```

### 3.2 `GET /active` — view mode "Active alarms"

Alarms **standing right now** (latest event per source+condition has
`Active=1`). Params: `condition`, `group` (as above), `acked`
(`false` = unacknowledged only, omit = both), `hours` (look-back for finding
the latest event, default 168). Rows have the same fields as `/recent` **plus
`GroupPath`**, ordered worst-severity first. Faults always excluded.

### 3.3 `GET /groups` — populates the plant/group dropdown

```json
{ "count": 24, "rows": [ { "GroupPath": "Ball Mill.Alarm_BallMill",
    "event_count": 22630, "last_event": "2026-07-10T15:32:13.094Z" } ] }
```

`GroupPath` format is `<plant area>.<Alarm_|Event_ group>` — each plant
usually has one `Alarm_` and one `Event_` entry, which are **separate filter
values** (exact match; there is no "whole plant" wildcard).

### 3.4 `GET /dbhealth` — optional status indicator

Flat object; the useful fields for the dashboard are `logging_ok` (bool;
false = no event for 2 h+) and `minutes_since_last`. Poll it once a minute at
most and show a small warning badge when `logging_ok` is false.

## 4. Building the query string (Function node rules)

1. Always `encodeURIComponent()` the `group`, `source`, `from`, `to` values —
   GroupPaths contain spaces.
2. `hours` and `from`/`to` are **mutually exclusive** — send one or the other,
   never both (the API answers 400, it never guesses).
3. `from`/`to` format: `YYYY-MM-DD HH:mm:ss` in **plant local time** — take
   the dashboard's date-picker value as-is if the browser is on plant time;
   do not convert to UTC yourself, the API does that internally.
4. Omit a parameter entirely to mean "no filter" (empty string also works).
5. Sensible `limit` for the table: 500–1000. The cap is 5000 (~1.5 MB JSON);
   don't poll `limit=5000` on a short interval.

## 5. Error contract

| Status | Body | Dashboard behavior |
|---|---|---|
| 200 | `{count, rows}` | Render. `count: 0` is a normal answer ("no events in that window"), not an error — show an empty table, not an error banner |
| 400 | `{"error":"limit must be 1-5000"}` etc. | A filter combination was invalid (usually hours+from/to). Show the message |
| 503 | `{"error":"Alarm_Event database unavailable"}` | DB is down; API recovers by itself. Show "historian offline" and keep polling — no flow restart needed |
| 500 | `{"error":"Server error"}` | Log it; transient unless persistent |

## 6. Required UI

A dashboard group/page with:

1. **Table** — suggested columns, in order:
   `Time` (formatted per §2) | `Source` | `Condition` | `Severity` | `Message` | `Value` (InputValue) | `Limit` (LimitValue) | `Active` | `Acked`.
   Color hint: Severity ≥ 900 red, ≥ 500 orange, else default; `Active:true` rows bold or tinted.
2. **View mode select** — `Recent events` (→ `/recent`) | `Active alarms` (→ `/active`). In Active mode the time-range control is hidden/ignored and an `Acked` select (All / Unacked only) appears.
3. **Plant/group select** — options fetched from `/groups` on flow start (inject-once) and refreshed hourly; first option `All plants` = omit `group`. Show `GroupPath` verbatim as the label (users know these names).
4. **Condition select** — static options: `All`, `TRIP`, `EVENT`, `HI`, `LO` (these are the only values in this plant's data; verified 2026-07-10).
5. **Time range select** (Recent mode) — presets mapping to `hours=`: `Last 1 h`, `8 h`, `24 h` (default), `3 d`=72, `7 d`=168. Optional: a `Custom…` choice revealing two datetime pickers that map to `from`/`to` (remember: plant local, and drop `hours` when used).
6. **Refresh** — auto-poll every 30–60 s plus refresh on any filter change. One in-flight request at a time (debounce filter changes ~300 ms).
7. Optional: row click → drill-down fetch of `/source/<SourceName>?hours=168` shown in a detail table or dialog.

Persist the selected filters in flow context so a browser refresh keeps them.

## 7. Verified example calls (all tested against live data 2026-07-10)

```
/recent?hours=24&limit=500                                    → plant-wide last 24 h
/recent?hours=24&condition=TRIP&limit=5000                    → 990 rows (all TRIP)
/recent?group=Feed%20Raw%20Material.Alarm_FeedRaw_Material&from=2026-07-09%2008:00:00&to=2026-07-09%2016:00:00&limit=5000
                                                              → 181 rows
/active?condition=TRIP                                        → 8 standing TRIPs
/active?condition=TRIP&acked=false                            → 0 (all acked)
/groups?hours=24                                              → 19 active groups
```

## 8. Gotchas learned the hard way (do not rediscover these)

- `count: 0` for a quiet machine/window is **correct data** (e.g. CoatingMC7
  heater only runs ~00:00–01:00, so 09:00–12:00 is genuinely empty).
- `group` is an **exact** match — a partial value like `Ball Mill` silently
  matches nothing. Always use values from `/groups` verbatim.
- The timestamps look like UTC but are plant local (§2). The API already did
  all timezone work; any further conversion in Node-RED is a bug.
- `/recent` rows don't include `GroupPath` (only `/active` rows do); if the
  table needs a plant column in Recent mode, display the selected filter value
  instead of a per-row field.
- Don't build an "Ack" button — this API is read-only by design; alarms are
  acknowledged in FactoryTalk, not here.
