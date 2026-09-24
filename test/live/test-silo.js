/*
 * Live test for the Silo plant (REPL_Silo_LOG), added 2026-08-14.
 *
 * Silo collects silo levels and weights from several PLCs across the plant
 * (Coating7, Coating1, RaymondMill2, PLC_Ofil) at a 60s cadence. Two things
 * make it worth its own script:
 *
 *   1. It is the first machine in CADENCE_ERAS at 60s. Without that entry it
 *      would fall back to the 360/10s default and countSilo would report a
 *      SIXTH of the real run-hours — the check below pins a fully-logged hour
 *      to 1.0 h and to count/60.
 *   2. It is the third plant in api/tagDisplay.js, and the first RENAME-ONLY
 *      one: every divisor is 1 because the values are already real floats in
 *      engineering units. The rename is not cosmetic — the raw historian names
 *      misidentify the silo ("RaymondMill\Weight_Silo3" is silo 41,
 *      "Coating7_Con\Net_Weight" is silo 1, TONSILOCSH[0..3] are silos 1..4).
 *      The checks below pin both halves: the friendly name reaches the wire,
 *      and the value is byte-identical to what the historian holds.
 *
 * Like test-ofil.js this needs NO candidate server and no production API: it
 * starts the app in-process on an ephemeral port and checks the routes against
 * the historian directly. It does need the plant network.
 *
 *   node test/live/test-silo.js
 *
 * The windows below are fixed historical ones and stay valid as long as the
 * historian retains 2026-08-14.
 */
const app = require('../../app');
const sql = require('mssql');
const { dbConfig_PROD } = require('../../config');

// A fully-logged hour: exactly 60 samples per tag at :31 past each minute, no
// gap over 90s, verified when this was written. Logging began 2026-08-14
// 15:54:31, so nothing earlier than 16:00 is a complete hour.
const HOUR = ['2026-08-14 16:00:00.000', '2026-08-14 17:00:00.000'];
// Before the database existed: every route must degrade like any other plant.
const EMPTY = ['2026-08-01 00:00:00.000', '2026-08-01 01:00:00.000'];

const TAG_COUNT = 31;
// The full display map, as supplied by the plant 2026-08-14. Spelled out rather
// than imported from api/tagDisplay.js so a typo there fails this test instead
// of agreeing with itself.
const NAMES = {
  0: 'SILO31_LEVEL',    1: 'SILO31_WEIGHT',
  2: 'SILO32_LEVEL',    3: 'SILO32_WEIGHT',
  4: 'SILO33_LEVEL',    5: 'SILO33_WEIGHT',
  6: 'SILO34_LEVEL',    7: 'SILO34_WEIGHT',
  8: 'SILO35_LEVEL',    9: 'SILO35_WEIGHT',
  10: 'SILO36_LEVEL',   11: 'SILO36_WEIGHT',
  12: 'CAP_SILO3_1_min',
  13: 'SILO9_WEIGHT',   14: 'SILO10_WEIGHT',
  15: 'SILO9_LEVEL',    16: 'SILO10_LEVEL',
  17: 'SILO0CSH_WEIGHT',
  18: 'SILO1CSH_WEIGHT', 19: 'SILO2CSH_WEIGHT',
  20: 'SILO3CSH_WEIGHT', 21: 'SILO4CSH_WEIGHT',
  22: 'SILO43_WEIGHT',  23: 'SILO44_WEIGHT',
  24: 'SILO1_WEIGHT',   25: 'SILO3_WEIGHT',
  26: 'SILO41_WEIGHT',  27: 'SILO42_WEIGHT',
  // Level-only tags added off the SILO1_2 PLC 2026-08-31.
  28: 'SILO21_LEVEL',   29: 'SILO22_LEVEL',
  30: 'SILO23_LEVEL',
};
// One per source PLC — the five raw names most likely to leak through if the
// display layer is skipped on some route.
const SPOT = [0, 12, 18, 26, 28];
// Fragments of the raw historian names. None may appear anywhere on the wire.
// 'SILO1_2\' and '_Level' are the tag 28-30 giveaways; the renamed form spells
// LEVEL in caps, so the mixed-case fragment cannot match it by accident.
const RAW_FRAGMENTS = ['Coating7_Con', 'SiemensOPC', 'PLC_Ofil', 'RaymondMill\\', 'Net_Weight', 'LOADCELL',
                       'SILO1_2\\', '_Level'];
// Counts every logged sample regardless of silo state, so `hour` measures the
// divisor rather than how full the silo happened to be.
const ALL = -99999;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
const near = (a, b, eps = 0.02) => typeof a === 'number' && Math.abs(a - b) <= eps;

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

const win = ([tbf, taf]) => `${encodeURIComponent(tbf)}/${encodeURIComponent(taf)}`;
const countUrl = (base, tag, [tbf, taf], extra = '') =>
  `${base}/plants/countSilo?tagIndex=${tag}&tbf=${encodeURIComponent(tbf)}` +
  `&taf=${encodeURIComponent(taf)}&threshold=${ALL}${extra}`;

// The mssql pool connects lazily after listen(); firing requests before it is
// ready just returns ECONNCLOSED.
async function warmup(base) {
  for (let i = 0; i < 60; i++) {
    try { if ((await get(`${base}/plants/BM2`)).status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server never became ready');
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const BASE = `http://localhost:${server.address().port}`;
  await warmup(BASE);
  console.log(`in-process ${BASE}\n`);

  // 1. Tag list: all 28 renamed, and no raw historian name left anywhere.
  console.log('--- tag list is renamed ---');
  const list = await get(`${BASE}/plants/Silo`);
  ok('GET /plants/Silo 200', list.status === 200, `got ${list.status}`);
  ok(`Silo lists ${TAG_COUNT} tags`,
     Array.isArray(list.body) && list.body.length === TAG_COUNT,
     `got ${Array.isArray(list.body) ? list.body.length : list.text.slice(0, 200)}`);
  ok('every Silo tag carries its plant name',
     Array.isArray(list.body) && list.body.every(t => t.TagName === NAMES[t.TagIndex]),
     JSON.stringify(list.body));
  ok('no raw historian name leaks through',
     RAW_FRAGMENTS.every(f => !list.text.includes(f)),
     list.text.slice(0, 200));

  // 2. Values pass through unscaled — this is the rename-only half. Checked
  //    against the historian directly, so a stray divisor fails here rather
  //    than looking self-consistent.
  console.log('\n--- names are rewritten, values are NOT ---');
  const pool = await new sql.ConnectionPool(dbConfig_PROD).connect();
  for (const tag of SPOT) {
    const raw = await pool.request().query`
  SELECT TOP (1) DateAndTime, Val FROM [REPL_Silo_LOG].[dbo].[FloatTable]
WHERE TagIndex = ${tag} AND Status <> 'E' ORDER BY DateAndTime DESC`;
    const latest = await get(`${BASE}/plants/Silo/${tag}`);
    const row = latest.body[0], dbRow = raw.recordset[0];
    ok(`Silo/${tag} renamed to ${NAMES[tag]} with the stored value untouched`,
       row && dbRow && row.Val === dbRow.Val && row.TagName === NAMES[tag],
       `api ${JSON.stringify(row)} db ${JSON.stringify(dbRow)}`);
  }

  // 3. /avg is computed in SQL; cross-check it against the same aggregate read
  //    directly, which also proves the Status <> 'E' filter matches.
  console.log('\n--- /avg matches a direct aggregate ---');
  const dbAgg = await pool.request().query`
  SELECT MIN(Val) AS minVal, MAX(Val) AS maxVal, AVG(Val) AS avgVal
FROM [REPL_Silo_LOG].[dbo].[FloatTable]
WHERE DateAndTime between ${HOUR[0]} and ${HOUR[1]}
and TagIndex = 0 and Status <> 'E'`;
  const avg = await get(`${BASE}/plants/Silo/0/${win(HOUR)}/avg`);
  const d = dbAgg.recordset[0];
  ok('/avg max/min/avg match the historian',
     avg.body.max === d.maxVal && avg.body.min === d.minVal && near(avg.body.avg, d.avgVal, 1e-9),
     `api ${JSON.stringify(avg.body)} db ${JSON.stringify(d)}`);
  ok('/avg tagName is renamed', avg.body.tagName === NAMES[0],
     JSON.stringify(avg.body.tagName));
  await pool.close();

  // 4. /all interleaves every tag, so each row is renamed against its OWN
  //    TagIndex — a single-tag lookup would pass while this fails.
  console.log('\n--- /all renames per row ---');
  const all = await get(`${BASE}/plants/Silo/all`);
  ok('GET /plants/Silo/all 200', all.status === 200, `got ${all.status}`);
  ok('/all rows are each renamed against their own TagIndex',
     Array.isArray(all.body) && all.body.length > 0 &&
     all.body.every(r => r.TagName === NAMES[r.TagIndex] && 'Val' in r),
     JSON.stringify(all.body.slice(0, 2)));
  ok('/all leaks no raw historian name',
     RAW_FRAGMENTS.every(f => !all.text.includes(f)), all.text.slice(0, 200));

  // 5. Window route + its opt-in fill: defaultCadenceFor must say 60.
  console.log('\n--- window route ---');
  const rawWin = await get(`${BASE}/plants/Silo/0/${win(HOUR)}`);
  ok('window returns a bare array of 60 rows without ?fillGaps',
     Array.isArray(rawWin.body) && rawWin.body.length === 60,
     `got ${Array.isArray(rawWin.body) ? rawWin.body.length + ' rows' : rawWin.text.slice(0, 120)}`);
  ok('window rows are renamed',
     Array.isArray(rawWin.body) && rawWin.body.every(r => r.TagName === NAMES[0]),
     JSON.stringify(rawWin.body[0]));
  const filled = await get(`${BASE}/plants/Silo/0/${win(HOUR)}?fillGaps=true`);
  ok('gap-filled window rows are renamed too',
     Array.isArray(filled.body.readings) &&
     filled.body.readings.every(r => r.TagName === NAMES[0]),
     JSON.stringify(filled.body.readings && filled.body.readings[0]));
  ok('window fill defaults to cadence 60',
     filled.body.fillGapsOptions && filled.body.fillGapsOptions.cadenceS === 60,
     JSON.stringify(filled.body.fillGapsOptions));
  ok('window fill audit is the flat single-era shape',
     filled.body.fillGapsOptions && filled.body.fillGapsOptions.eras === undefined,
     JSON.stringify(filled.body.fillGapsOptions));
  ok('a gapless hour adds no synthetic rows',
     filled.body.filledReadings === 0 && filled.body.totalReadings === 60,
     JSON.stringify({ total: filled.body.totalReadings, filled: filled.body.filledReadings }));
  const forcedCadence = await get(`${BASE}/plants/Silo/0/${win(HOUR)}?fillGaps=true&cadence=10`);
  ok('window explicit &cadence=10 still wins',
     forcedCadence.body.fillGapsOptions.cadenceS === 10,
     JSON.stringify(forcedCadence.body.fillGapsOptions));

  // 6. The reason Silo is in CADENCE_ERAS: a full hour of 60s logging is 1.0 h.
  //    With the 360 fallback for an unlisted machine this reads 0.1667.
  console.log('\n--- 60s divisor (the CADENCE_ERAS entry) ---');
  const hour = await get(countUrl(BASE, 0, HOUR));
  ok('countSilo full hour reads 1.0 h', near(hour.body.hour, 1.0),
     `got hour=${hour.body.hour} count=${hour.body.count}`);
  ok('countSilo divides by 60, not 360',
     hour.body.count === 60 && near(hour.body.hour, hour.body.count / 60, 1e-9),
     `count=${hour.body.count} hour=${hour.body.hour}`);
  ok('countSilo audit reports cadence 60 in the flat shape',
     hour.body.fillGaps && hour.body.fillGaps.fillGapsOptions.cadenceS === 60 &&
     hour.body.fillGaps.fillGapsOptions.eras === undefined,
     JSON.stringify(hour.body.fillGaps && hour.body.fillGaps.fillGapsOptions));
  ok('countSilo tariff buckets total the reported hour',
     near(hour.body.distHour.total, hour.body.hour, 1e-9) &&
     near(hour.body.distHourFine.total, hour.body.hour, 1e-9) &&
     near(hour.body.distHour.A + hour.body.distHour.B +
          hour.body.distHour.C + hour.body.distHour.D, hour.body.distHour.total, 1e-9),
     `${JSON.stringify(hour.body.distHour)} hour=${hour.body.hour}`);
  ok('countSilo tagName is renamed', hour.body.tagName === NAMES[0],
     JSON.stringify(hour.body.tagName));
  const rawCount = await get(countUrl(BASE, 0, HOUR, '&fillGaps=false'));
  ok('countSilo &fillGaps=false keeps the 60 divisor and drops the audit',
     near(rawCount.body.hour, rawCount.body.count / 60, 1e-9) && rawCount.body.fillGaps === undefined,
     `count=${rawCount.body.count} hour=${rawCount.body.hour}`);
  const forced = await get(countUrl(BASE, 0, HOUR, '&pointsPerHour=360'));
  ok('countSilo &pointsPerHour=360 still forces that divisor',
     near(forced.body.hour, forced.body.count / 360, 1e-9),
     `count=${forced.body.count} hour=${forced.body.hour}`);

  // 7. &threshold= is in the tag's own units — no conversion anywhere.
  console.log('\n--- &threshold= is in the tag\'s own units ---');
  const above20 = await get(`${BASE}/plants/countSilo?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}` +
    `&taf=${encodeURIComponent(HOUR[1])}&threshold=20`);
  ok('SILO31_Level > 20% counts the whole hour (min was 20.66)',
     above20.body.count === 60, `got count=${above20.body.count}`);
  const above1e6 = await get(`${BASE}/plants/countSilo?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}` +
    `&taf=${encodeURIComponent(HOUR[1])}&threshold=1000000`);
  ok('an unreachable threshold counts nothing', above1e6.body.count === 0,
     `got count=${above1e6.body.count}`);

  // 8. Edge cases must behave exactly like every other plant.
  console.log('\n--- edge cases ---');
  const noThreshold = await get(`${BASE}/plants/countSilo?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}&taf=${encodeURIComponent(HOUR[1])}`);
  ok('countSilo without &threshold= is 400',
     noThreshold.status === 400 && noThreshold.body.error,
     `${noThreshold.status} ${noThreshold.text.slice(0, 120)}`);
  const badThreshold = await get(`${BASE}/plants/countSilo?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}&taf=${encodeURIComponent(HOUR[1])}&threshold=abc`);
  ok('countSilo with a non-numeric &threshold= is 400',
     badThreshold.status === 400 && badThreshold.body.error,
     `${badThreshold.status} ${badThreshold.text.slice(0, 120)}`);
  const unknownWin = await get(`${BASE}/plants/Silo/99/${win(HOUR)}`);
  ok('unknown tagIndex window returns []',
     Array.isArray(unknownWin.body) && unknownWin.body.length === 0, unknownWin.text.slice(0, 120));
  const unknownAvg = await get(`${BASE}/plants/Silo/99/${win(HOUR)}/avg`);
  ok('unknown tagIndex /avg returns nulls',
     unknownAvg.body.tagName === null && unknownAvg.body.max === null &&
     unknownAvg.body.min === null && unknownAvg.body.avg === null, unknownAvg.text.slice(0, 160));
  const emptyAvg = await get(`${BASE}/plants/Silo/0/${win(EMPTY)}/avg`);
  ok('window predating the database returns nulls from /avg',
     emptyAvg.body.tagName === null && emptyAvg.body.avg === null, emptyAvg.text.slice(0, 160));
  const emptyCount = await get(countUrl(BASE, 0, EMPTY));
  ok('window predating the database counts 0',
     emptyCount.body.count === 0 && emptyCount.body.hour === 0 && emptyCount.body.tagName === null,
     emptyCount.text.slice(0, 160));

  // 9. The root listing has to advertise the plant, and must not have lost one.
  console.log('\n--- root listing ---');
  const root = await get(`${BASE}/plants/`);
  const entry = Array.isArray(root.body) && root.body.find(e => 'Silo' in e);
  ok('root listing includes Silo', Boolean(entry), root.text.slice(0, 200));
  ok('root listing carries all Silo tags, renamed',
     entry && Array.isArray(entry.tags) && entry.tags.length === TAG_COUNT &&
     entry.tags.every(t => t.TagName === NAMES[t.TagIndex]),
     JSON.stringify(entry && entry.tags && entry.tags.slice(0, 3)));
  for (const plant of ['BM2', 'RRM', 'OFIL', 'Hour_OFIL', 'LC_CSH']) {
    ok(`root listing still includes ${plant}`,
       Array.isArray(root.body) && root.body.some(e => plant in e), '');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
