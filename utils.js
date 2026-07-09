// Function to find the maximum value in a specific field of the JSON data
function findMax(data, field) {
    if (!data || data.length === 0) return null;
    return data.reduce((max, item) => (item[field] > max ? item[field] : max), data[0][field]);
  }
  
  // Function to find the minimum value in a specific field of the JSON data
  function findMin(data, field) {
    if (!data || data.length === 0) return null;
    return data.reduce((min, item) => (item[field] < min ? item[field] : min), data[0][field]);
  }
  
  // Function to calculate the average value in a specific field of the JSON data
  function calculateAverage(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total / data.length;
  }
  
  function calSum(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total;
  }

  function calCap(data, field) {
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, item) => sum + item[field], 0);
    return total/6;
  }

  function returnTagName(data) {
    if (!data || data.length === 0) return null;
    return data[0].TagName
  }

  function countValues(data, field, operator, value) {
    if (!data || data.length === 0) return 0;
  
    switch (operator) {
      case '>':
        return data.reduce((count, item) => (item[field] > value ? count + 1 : count), 0);
      case '<':
        return data.reduce((count, item) => (item[field] < value ? count + 1 : count), 0);
      case '>=':
        return data.reduce((count, item) => (item[field] >= value ? count + 1 : count), 0);
      case '<=':
        return data.reduce((count, item) => (item[field] <= value ? count + 1 : count), 0);
      case '==':
        return data.reduce((count, item) => (item[field] == value ? count + 1 : count), 0);
      case '===':
        return data.reduce((count, item) => (item[field] === value ? count + 1 : count), 0);
      case '!=':
        return data.reduce((count, item) => (item[field] != value ? count + 1 : count), 0);
      case '!==':
        return data.reduce((count, item) => (item[field] !== value ? count + 1 : count), 0);
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }
  

// Thai public holidays. Needs annual updating (add year N+1 before Jan 1).
// Weekend-falling dates are harmless no-ops (weekends already count as
// holiday-rate days); substitution/in-lieu weekdays are what matter here.
const holidays = [
  "2025-01-01", "2025-02-12", "2025-04-15", "2025-04-14",
  "2025-05-01", "2025-06-03", "2025-07-10", "2025-07-11",
  "2025-08-12", "2025-10-13", "2025-10-23", "2025-12-05",
  "2025-12-10", "2025-12-31",
  "2026-01-01", "2026-03-03", "2026-04-06", "2026-04-13",
  "2026-04-14", "2026-04-15", "2026-05-01", "2026-05-04",
  "2026-06-03", "2026-07-28", "2026-07-29", "2026-07-30",
  "2026-08-12", "2026-10-13", "2026-10-23",
  "2026-12-07", // substitution for Father's Day (Sat 2026-12-05)
  "2026-12-10", "2026-12-31",
  // 2027 — from published national-holiday calendars (officeholidays.com);
  // TODO 2026-12: verify against the Thai Cabinet announcement once issued
  // (watch for extra one-off bridge days like 2026-07-29/30 were).
  "2027-01-01", "2027-02-22", "2027-04-06", "2027-04-13",
  "2027-04-14", "2027-04-15", "2027-05-04", "2027-05-20",
  "2027-06-03", "2027-07-19", "2027-07-20", "2027-07-28",
  "2027-08-12", "2027-10-13", "2027-10-25",
  "2027-12-06", // substitution for Father's Day (Sun 2027-12-05)
  "2027-12-10", "2027-12-31"
];

/**
 * Count data points that match (item[field] operator value),
 * then split the result into hour-buckets (LOCAL TIME):
 *  - A: non-holiday, 09:00–22:00
 *  - B: non-holiday, 22:00–09:00
 *  - C: holiday,     06:00–18:00
 *  - D: holiday,     18:00–06:00
 *
 * Converts points -> hours by dividing by 360 (10s interval).
 */
function countValuesHour(data, field, operator, value, options = {}) {
  if (!data || data.length === 0) return { A: 0, B: 0, C: 0, D: 0, total: 0 };

  const {
    timeField = "timestamp", // item[timeField] should be Date | string | number(ms)
    // pass your own: (date: Date, item) => boolean
    isHoliday = () => false,
    pointsPerHour = 360,
    returnHours = true,

    // FIX: timezone handling
    // If your timestamps are UTC (e.g. "...Z" or epoch) but you want Asia/Bangkok time,
    // set tzOffsetMinutes = 420 (7*60). If your timestamps are already local, keep 0.
    tzOffsetMinutes = 0,

    // clock:'utc' reads getUTCHours()/getUTCDay() instead of the server-local
    // getters. Use when the Date's UTC fields already hold the wall-clock time
    // you care about (mssql parses the historian's naive local timestamps as
    // UTC) — makes bucketing independent of the server's OS timezone.
    clock = "local",
  } = options;

  const compare = (a, op, b) => {
    switch (op) {
      case ">": return a > b;
      case "<": return a < b;
      case ">=": return a >= b;
      case "<=": return a <= b;
      case "==": return a == b;
      case "===": return a === b;
      case "!=": return a != b;
      case "!==": return a !== b;
      default: throw new Error(`Unknown operator: ${op}`);
    }
  };

  // Parse time, then apply optional offset (minutes) to force desired local timezone.
  const toDate = (t) => {
    let d;

    if (t instanceof Date) {
      d = new Date(t.getTime());
    } else if (typeof t === "number") {
      d = new Date(t); // epoch ms
    } else if (typeof t === "string") {
      // If string has no timezone info, treat as LOCAL by converting " " to "T"
      // Examples: "2025-01-01 00:00:00" -> local time
      const hasTZ =
        /Z$/.test(t) || /[+-]\d{2}:\d{2}$/.test(t) || /[+-]\d{4}$/.test(t);
      d = hasTZ ? new Date(t) : new Date(t.replace(" ", "T"));
    } else {
      throw new Error(`Unsupported time value in "${timeField}": ${t}`);
    }

    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid date/time in field "${timeField}": ${t}`);
    }

    if (tzOffsetMinutes !== 0) {
      d = new Date(d.getTime() + tzOffsetMinutes * 60 * 1000);
    }

    return d;
  };

  // hour as decimal, e.g. 21.5 for 21:30
  const hourOfDay = clock === "utc"
    ? (d) => d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
    : (d) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

  const inRange = (h, start, end) => {
    if (start < end) return h >= start && h < end; // normal
    return h >= start || h < end; // wraps midnight
  };

  const bucketOf = (d, item) => {
    const h = hourOfDay(d);

    if (isHoliday(d, item)) {
      return (h >= 6 && h <= 18) ? "C" : "D";
    }
    return (h >= 9 && h <= 22) ? "A" : "B";
  };

  const counts = data.reduce(
    (acc, item) => {
      if (!compare(item[field], operator, value)) return acc;

      const d = toDate(item[timeField]);
      const bucket = bucketOf(d, item);

      acc[bucket] += 1;
      acc.total += 1;
      return acc;
    },
    { A: 0, B: 0, C: 0, D: 0, total: 0 }
  );

  if (!returnHours) return counts;

  return {
    A: counts.A / pointsPerHour,
    B: counts.B / pointsPerHour,
    C: counts.C / pointsPerHour,
    D: counts.D / pointsPerHour,
    total: counts.total / pointsPerHour,
  };
}

/* -------------------- Holiday helper (dates + weekends) -------------------- */
const holidaySet = new Set(holidays);

function isHoliday(date) {
  const yyyyMMdd = date.toLocaleDateString("en-CA"); // LOCAL YYYY-MM-DD
  const day = date.getDay(); // 0 Sun, 6 Sat
  return holidaySet.has(yyyyMMdd) || day === 0 || day === 6;
}

// Same holiday/weekend check but reading the UTC clock fields. Use with
// clock:'utc' in countValuesHour: the historian stores naive Bangkok-local
// timestamps that the mssql driver parses as UTC, so the Date's UTC fields
// hold plant-local time regardless of the server's OS timezone.
function isHolidayUTC(date) {
  const yyyyMMdd = date.toISOString().slice(0, 10);
  const day = date.getUTCDay(); // 0 Sun, 6 Sat
  return holidaySet.has(yyyyMMdd) || day === 0 || day === 6;
}

// Bounded + bracket-checked hold-last-value gap fill.
// (See 2026-07-07-fillgap-kepware-gaps.md — Kepware reconnects leave short
// logging gaps in the historian that look like downtime.)
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

// Variant for the count{plant} routes: returns { data, meta }. Gap filling is
// ON BY DEFAULT here (this test copy serves corrected run-hours): data includes
// the synthetic bridge rows so run-hour counting doesn't mistake short Kepware
// logging blips for machine downtime, and meta carries the audit trail (what
// was filled, what was flagged). Pass ?fillGaps=false (fillGap=false also
// accepted) to get the legacy raw recordset with meta null — byte-identical to
// production :3334. NOT wired to countWL (event data — synthetic weighing
// cycles would be fabricated events) or countHour_OFIL (cumulative counter —
// holding it flat understates it); those routes never call this.
function fillGapsForCount(recordset, query = {}) {
  const flag = query.fillGaps !== undefined ? query.fillGaps : query.fillGap;
  if (String(flag) === 'false') return { data: recordset, meta: null };
  const w = runFillGaps(recordset, query);
  return {
    data: w.readings,
    meta: {
      fillGapsOptions: w.fillGapsOptions,
      realReadings: w.totalReadings - w.filledReadings,
      filledReadings: w.filledReadings,
      flaggedGaps: w.flaggedGaps,
    },
  };
}

// Opt-in wrapper for the window routes: with ?fillGaps=true the response
// becomes { fillGapsOptions, totalReadings, filledReadings, flaggedGaps,
// readings } (chronological, synthetic rows marked Filled:true). Without the
// param the raw recordset passes through untouched, so existing consumers see
// no change.
function applyFillGaps(data, query = {}) {
  if (String(query.fillGaps) !== 'true') return data;
  return runFillGaps(data, query);
}

// Ungated core: parse options from the query string, fill, and shape the result.
function runFillGaps(data, query = {}) {
  const num = (v, dflt) => (Number(v) > 0 ? Number(v) : dflt);
  const options = {
    cadenceS: num(query.cadence, 10),
    capS: num(query.cap, 90),
    tolerance: Number(query.tolerance) >= 0 ? Number(query.tolerance) : 0.2,
  };
  const { readings, flaggedGaps } = fillGaps(data, options);
  return {
    fillGapsOptions: options,
    totalReadings: readings.length,
    filledReadings: readings.reduce((n, r) => (r.Filled ? n + 1 : n), 0),
    flaggedGaps,
    readings,
  };
}

module.exports = {  findMax,
                      findMin, 
                      calculateAverage, 
                      returnTagName, 
                      countValues,
                      calSum,
                      calCap,
                      countValuesHour,
                      isHoliday,
                      isHolidayUTC,
                      fillGaps,
                      applyFillGaps,
                      fillGapsForCount,
                };
                  
