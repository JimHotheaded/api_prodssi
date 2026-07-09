---
type: handoff
status: ready
created: 2026-07-07
tags:
  - scada
  - data-quality
  - kepware
---

# Fill-gap concept — bounded, bracket-checked hold-last-value

**Context for whoever picks this up:** the plant's Kepware OPC server periodically restarts/reconnects. While it's down, nothing gets logged to the SQL historian, leaving scattered 10–30s gaps in an otherwise-10s-cadence tag history (confirmed on Ball Mill 2, 2026-07-06: 961 of 8,640 expected daily samples missing). This showed up as a misleading "downtime" gap in a daily production report before we traced it to logging drops, not real machine stoppage. Full investigation trail (including a still-open side-question about a separate `ProductionPlan.HoursTotal` field that turned out to be unrelated) is in `wiki/topics/production-plan-hours-scan-artifact.md` in this vault — read that if you need the full evidence chain. This file only carries the reusable fix concept + code.

## The idea

A historian gap can mean one of two very different things:
1. **A logging blip** (Kepware reconnect) — the tag's real value almost certainly didn't change, it just didn't get written for a few ticks. Safe to bridge.
2. **A real state change** (the machine actually stopped, or the value genuinely moved) that happens to coincide with a gap. Not safe to bridge — silently assuming continuity here hides the exact event you'd want to see.

Plain last-observation-carried-forward (LOCF) can't tell these apart. This fix adds two cheap guards:

- **Cap** — only bridge gaps shorter than a ceiling (e.g. 90s). A Kepware blip is short; a multi-minute gap might be a real event, so it's left alone rather than guessed.
- **Bracket check** — only bridge if the reading immediately before and immediately after the gap agree (within a relative tolerance, e.g. 20%). If they disagree, something genuinely changed during the gap — don't paper over it.

Anything that fails either check is reported separately (as a "flagged gap") instead of being silently filled, so nothing gets hidden — the caller always knows what was assumed vs. measured.

## Reference implementation — JavaScript

Already shipped in `outputs/mcp-api-prodssi/server.js` in this vault (wired into an MCP tool's `get_readings` as an opt-in `fillGaps:true` param). Self-contained function, no dependencies:

```js
// Bounded + bracket-checked hold-last-value gap fill.
// Only bridges a gap when BOTH:
//   1. it's short (<= capS) — a real, prolonged event isn't a logging blip, and
//   2. the readings bracketing the gap agree within `tolerance` (relative) — a real
//      state change (e.g. the machine actually stopped) shouldn't be papered over.
// Gaps failing either check are left alone and reported in `flaggedGaps` instead of guessed.
function fillGaps(rows, { cadenceS = 10, capS = 90, tolerance = 0.2 } = {}) {
  const sorted = [...rows].sort((a, b) => new Date(a.DateAndTime) - new Date(b.DateAndTime));
  const filled = [];
  const flaggedGaps = [];
  const cadenceMs = cadenceS * 1000;
  const capMs = capS * 1000;

  const valuesAgree = (a, b) => {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-6);
    return Math.abs(a - b) / scale <= tolerance;
  };

  for (let i = 0; i < sorted.length; i++) {
    filled.push(sorted[i]);
    if (i === sorted.length - 1) break;

    const a = sorted[i], b = sorted[i + 1];
    const dt = new Date(b.DateAndTime) - new Date(a.DateAndTime);
    if (dt <= cadenceMs * 1.5) continue; // normal cadence, nothing to fill

    if (dt <= capMs && valuesAgree(a.Val, b.Val)) {
      for (let t = new Date(a.DateAndTime).getTime() + cadenceMs; t < new Date(b.DateAndTime).getTime(); t += cadenceMs) {
        filled.push({ ...a, DateAndTime: new Date(t).toISOString(), Filled: true });
      }
    } else {
      flaggedGaps.push({
        from: a.DateAndTime,
        to: b.DateAndTime,
        gap_s: dt / 1000,
        reason: dt > capMs ? "exceeds cap" : "value mismatch across gap",
      });
    }
  }
  return { readings: filled, flaggedGaps };
}
```

Self-test (4 cases: clean cadence, bridgeable gap, over-cap gap, bracket-mismatch gap):

```js
function _selftest() {
  const t = (offsetS) => new Date(Date.parse("2026-01-01T00:00:00Z") + offsetS * 1000).toISOString();

  const r1 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(10), Val: 100 }]);
  console.assert(r1.readings.length === 2 && r1.flaggedGaps.length === 0, "case1 failed");

  const r2 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(20), Val: 100 }]);
  console.assert(r2.readings.length === 3 && r2.readings[1].Filled === true && r2.flaggedGaps.length === 0, "case2 failed");

  const r3 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(200), Val: 100 }]);
  console.assert(r3.readings.length === 2 && r3.flaggedGaps.length === 1 && r3.flaggedGaps[0].reason === "exceeds cap", "case3 failed");

  const r4 = fillGaps([{ DateAndTime: t(0), Val: 100 }, { DateAndTime: t(20), Val: 0 }]);
  console.assert(r4.readings.length === 2 && r4.flaggedGaps.length === 1 && r4.flaggedGaps[0].reason === "value mismatch across gap", "case4 failed");

  console.log("fillGaps self-test: all cases passed");
}
```

## Reference implementation — Python

Already shipped in `outputs/bm2_uptime_locf.py` in this vault. Same algorithm, plus a `compute_uptime()` variant that classifies each reading as running/stopped via a threshold (useful when the goal is a single uptime % rather than a filled series):

```python
from datetime import datetime

def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

def is_running(val, threshold):
    return val >= threshold

def compute_uptime(readings, threshold=10.0, cadence_s=10.0, cap_s=90.0):
    """Returns dict: span_s, running_s, stopped_s, filled_s, unmeasured_s,
    uptime_pct (running / measured, i.e. span minus unmeasured), flagged_gaps."""
    rows = sorted(readings, key=lambda r: r["DateAndTime"])
    if len(rows) < 2:
        raise ValueError("need at least 2 readings")

    running_s = stopped_s = filled_s = unmeasured_s = 0.0
    flagged = []

    for a, b in zip(rows, rows[1:]):
        t1, t2 = parse_time(a["DateAndTime"]), parse_time(b["DateAndTime"])
        dt = (t2 - t1).total_seconds()
        state_a = is_running(a["Val"], threshold)
        state_b = is_running(b["Val"], threshold)

        if dt <= cadence_s * 1.5:
            running_s += dt if state_a else 0
            stopped_s += dt if not state_a else 0
            continue

        if dt <= cap_s and state_a == state_b:
            filled_s += dt
            running_s += dt if state_a else 0
            stopped_s += dt if not state_a else 0
        else:
            unmeasured_s += dt
            flagged.append({
                "from": a["DateAndTime"], "to": b["DateAndTime"], "gap_s": dt,
                "state_before": state_a, "state_after": state_b,
                "reason": "exceeds cap" if dt > cap_s else "state mismatch across gap",
            })

    span_s = running_s + stopped_s + unmeasured_s
    measured_s = running_s + stopped_s
    uptime_pct = (running_s / measured_s * 100) if measured_s else 0.0

    return {
        "span_s": span_s, "running_s": running_s, "stopped_s": stopped_s,
        "filled_s": filled_s, "unmeasured_s": unmeasured_s,
        "uptime_pct": uptime_pct, "flagged_gaps": flagged,
    }
```

CLI usage: `python3 bm2_uptime_locf.py readings.json --threshold N --cadence 10 --cap 90` (readings.json = array of `{"DateAndTime": ISO8601, "Val": number}`).

## Where this has been applied so far

- `outputs/bm2_uptime_locf.py` — standalone script, run against saved raw-reading JSON dumps.
- `outputs/mcp-api-prodssi/server.js` — wired into the `get_readings` MCP tool as opt-in `fillGaps:true` (+`cadenceS`/`capS`/`tolerance` params). **This only affects what's returned through this MCP wrapper** — it's a client-side wrapper around the real plant API (`172.30.1.112:3334`), not the production `api-prodssi` Express server itself. Node-RED dashboards and anything else hitting `:3334` directly still see raw, gappy data.

## Where it could go next (not yet done)

If the real production API (`JimHotheaded/api_prodssi`, not present in this vault — only doc clippings) should serve gap-filled data to everyone (Node-RED dashboards, other integrations), the natural integration point is a post-processing step in whatever route handler builds the readings array from the SQL query result (likely `api/routes/plants.js`, per this vault's notes on that repo's structure) — applied as an **opt-in query parameter** (e.g. `?fillGaps=true&cap=90&tolerance=0.2`), not a default-on change, so existing consumers that want raw ground truth aren't silently altered.

## Open questions / caveats for whoever implements this

- **Tune `capS` and `tolerance` per deployment.** The values here (90s cap, 20% relative tolerance) were picked from one day's worth of BM2 data where all observed Kepware-blip gaps were ≤30s. If your typical Kepware reconnect takes longer, raise the cap accordingly — don't just copy these numbers blindly.
- **Not every tag is meaningfully "held constant."** This makes sense for slow-moving process values (pressures, RPM, feed rates). It does *not* make sense for cumulative counters (e.g. running kWh totals) — holding those flat during a gap would understate consumption; a counter needs a different gap strategy (e.g. flag-only, no fill).
- **This doesn't explain why Kepware restarts** — that's a separate, still-open investigation (see the wiki topic for 5 concrete diagnostic steps, all needing live access to the Kepware/SCADA host).
- **Kepware/FactoryTalk may already support store-and-forward/local buffering** on reconnect — if that's available and licensed, it's strictly better than any downstream fill logic, since it recovers the real values instead of estimating them. Worth checking before investing further in this approach at the source-API level.
