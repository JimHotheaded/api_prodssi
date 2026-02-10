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
  
  // const total = data.reduce((sum, item) => sum + item[field], 0);
  // return total;
  function calSumFilter(data, field, operator, value) {
    if (!data || data.length === 0) return null;
    
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

  function generateDateStringsForMonth(year, month, startTime1, endTime1, startTime2, endTime2) {
    const dates = [];
    const daysInMonth = new Date(year, month + 1, 0).getDate();
  
    for (let day = 1; day <= daysInMonth; day++) {
      const dayString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      dates.push({
        startDateTime1: `${dayString} ${startTime1}`,
        endDateTime1: `${dayString} ${endTime1}`,
        startDateTime2: `${dayString} ${startTime2}`,
        endDateTime2: `${dayString} ${endTime2}`,
      });
    }
  
    return dates;
  }
  
  function calculateCustomTimeFrame(data, field) {
    if (!data || data.length === 0) return 0;
    
  }
const holidays = [
  "2025-01-01", "2025-02-12", "2025-04-15", "2025-04-14",
  "2025-05-01", "2025-06-03", "2025-07-10", "2025-07-11",
  "2025-08-12", "2025-10-13", "2025-10-23", "2025-12-05",
  "2025-12-10", "2025-12-31",
  "2026-01-01", "2026-03-03", "2026-04-06", "2026-04-13",
  "2026-04-14", "2026-04-15", "2026-05-01", "2026-05-04",
  "2026-06-03", "2026-07-28", "2026-07-29", "2026-07-30",
  "2026-08-12", "2026-10-13", "2026-10-23",
  "2026-12-10", "2026-12-31"
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

  // hour as decimal, e.g. 21.5 for 21:30 (LOCAL HOURS)
  const hourOfDay = (d) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

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

  module.exports = {  findMax, 
                      findMin, 
                      calculateAverage, 
                      returnTagName, 
                      countValues, 
                      calculateCustomTimeFrame, 
                      generateDateStringsForMonth,
                      calSum,
                      calCap,
                      countValuesHour,
                      isHoliday,
                    };
                  
