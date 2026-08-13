/*
 * Live test for the OFIL plant (REPL_OFIL_LOG), added 2026-08-13.
 *
 * OFIL is the second plant served through the display layer (api/tagDisplay.js):
 * the tag table holds raw Logix paths ("::[PLC_Ofil]OFIL_SILO4:I.OutputFreq")
 * and the drives log OutputFreq in hundredths of a Hz, so every route renames
 * the tag and divides Val by 100. It is also the first machine to enter
 * CADENCE_ERAS with a single boundary-less era: it only started logging on
 * 2026-08-11, after the plant-wide 10s -> 15s switch, so it has never run at
 * anything but 15s. Without that entry it would fall back to the 360/10s
 * default and report two thirds of its real run-hours.
 *
 * Unlike most scripts in this folder this one needs NO candidate server and no
 * production API: it starts the app in-process on an ephemeral port and checks
 * the routes against the historian directly. It does need the plant network.
 *
 *   node test/live/test-ofil.js
 *
 * The windows below are fixed historical ones and stay valid as long as the
 * historian retains 2026-08-12.
 */
const app = require('../../app');
const sql = require('mssql');
const { dbConfig_PROD } = require('../../config');

// A fully-logged quiet hour (240 samples at 15s), verified when this was
// written. Logging began 2026-08-11 14:33:52, so nothing earlier is valid.
const HOUR = ['2026-08-12 02:00:00.000', '2026-08-12 03:00:00.000'];
// Before the database existed: every route must degrade like any other plant.
const EMPTY = ['2026-08-01 00:00:00.000', '2026-08-01 01:00:00.000'];

const TAGS = {
  0: 'SILO4_OutputFreq',
  1: 'Rotary_Screen2_OutputFreq',
  2: 'Rotary_Screen3_OutputFreq',
  3: 'Rotary_Screen4_OutputFreq',
  4: 'Rotary_Screen5_OutputFreq',
};
const DIVISOR = 100;
// Counts every logged sample regardless of drive state, so `hour` measures the
// divisor rather than how busy the screens happened to be.
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
  `${base}/plants/countOFIL?tagIndex=${tag}&tbf=${encodeURIComponent(tbf)}` +
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

  // 1. Tag list: the raw Logix paths must never reach the wire.
  console.log('--- tag list is renamed ---');
  const list = await get(`${BASE}/plants/OFIL`);
  ok('GET /plants/OFIL 200', list.status === 200, `got ${list.status}`);
  ok('OFIL lists 5 tags', Array.isArray(list.body) && list.body.length === 5,
     `got ${JSON.stringify(list.body).slice(0, 200)}`);
  ok('OFIL tag names are the friendly ones',
     Array.isArray(list.body) && list.body.every(t => t.TagName === TAGS[t.TagIndex]),
     JSON.stringify(list.body));
  ok('no raw PLC path leaks through',
     !list.text.includes('PLC_Ofil') && !list.text.includes('::'),
     list.text.slice(0, 200));

  // 2. Values are Hz, not the raw hundredths. Checked against the historian
  //    directly so this catches a wrong divisor, not just a self-consistent one.
  console.log('\n--- values are converted to Hz ---');
  const pool = await new sql.ConnectionPool(dbConfig_PROD).connect();
  for (const tag of Object.keys(TAGS)) {
    const raw = await pool.request().query`
  SELECT TOP (1) DateAndTime, Val FROM [REPL_OFIL_LOG].[dbo].[FloatTable]
WHERE TagIndex = ${tag} AND Status <> 'E' ORDER BY DateAndTime DESC`;
    const latest = await get(`${BASE}/plants/OFIL/${tag}`);
    const row = latest.body[0], dbRow = raw.recordset[0];
    ok(`OFIL/${tag} latest equals raw/${DIVISOR}`,
       row && dbRow && row.Val === dbRow.Val / DIVISOR && row.TagName === TAGS[tag],
       `api ${JSON.stringify(row)} db ${JSON.stringify(dbRow)}`);
    ok(`OFIL/${tag} latest is a plausible drive frequency`,
       row && row.Val >= 0 && row.Val <= 100, `got ${row && row.Val}`);
  }
  await pool.close();

  // 3. /all interleaves every tag, so each row has to be converted against its
  //    own TagIndex.
  console.log('\n--- /all converts per row ---');
  const all = await get(`${BASE}/plants/OFIL/all`);
  ok('GET /plants/OFIL/all 200', all.status === 200, `got ${all.status}`);
  ok('/all rows all renamed and Hz-scaled',
     Array.isArray(all.body) && all.body.length > 0 &&
     all.body.every(r => r.TagName === TAGS[r.TagIndex] && r.Val <= 100),
     JSON.stringify(all.body.slice(0, 2)));

  // 4. Window route + its opt-in fill. defaultCadenceFor must say 15, and the
  //    synthetic rows have to be scaled along with the real ones.
  console.log('\n--- window route ---');
  const rawWin = await get(`${BASE}/plants/OFIL/0/${win(HOUR)}`);
  ok('window returns a bare array without ?fillGaps',
     Array.isArray(rawWin.body) && rawWin.body.length >= 240,
     `got ${Array.isArray(rawWin.body) ? rawWin.body.length + ' rows' : rawWin.text.slice(0, 120)}`);
  ok('window rows are Hz-scaled and renamed',
     Array.isArray(rawWin.body) && rawWin.body.every(r => r.TagName === TAGS[0] && r.Val <= 100),
     JSON.stringify(rawWin.body[0]));
  const filled = await get(`${BASE}/plants/OFIL/0/${win(HOUR)}?fillGaps=true`);
  ok('window fill defaults to cadence 15',
     filled.body.fillGapsOptions && filled.body.fillGapsOptions.cadenceS === 15,
     JSON.stringify(filled.body.fillGapsOptions));
  ok('window fill audit is the flat single-era shape',
     filled.body.fillGapsOptions && filled.body.fillGapsOptions.eras === undefined,
     JSON.stringify(filled.body.fillGapsOptions));
  const forcedCadence = await get(`${BASE}/plants/OFIL/0/${win(HOUR)}?fillGaps=true&cadence=10`);
  ok('window explicit &cadence=10 still wins',
     forcedCadence.body.fillGapsOptions.cadenceS === 10,
     JSON.stringify(forcedCadence.body.fillGapsOptions));

  // 5. /avg — scaled, and null-guarded on an empty window like every other plant.
  console.log('\n--- /avg ---');
  const avg = await get(`${BASE}/plants/OFIL/0/${win(HOUR)}/avg`);
  ok('/avg renamed and Hz-scaled',
     avg.body.tagName === TAGS[0] && avg.body.max <= 100 && avg.body.min >= 0 &&
     avg.body.avg >= avg.body.min && avg.body.avg <= avg.body.max,
     JSON.stringify(avg.body));

  // 6. The reason OFIL is in CADENCE_ERAS: a full hour of 15s logging is 1.0 h.
  //    With the 360 fallback for an unlisted machine this reads 0.6667.
  console.log('\n--- 15s divisor (the CADENCE_ERAS entry) ---');
  const hour = await get(countUrl(BASE, 0, HOUR));
  ok('countOFIL full hour reads 1.0 h', near(hour.body.hour, 1.0),
     `got hour=${hour.body.hour} count=${hour.body.count}`);
  ok('countOFIL divides by 240, not 360',
     near(hour.body.hour, hour.body.count / 240, 1e-9),
     `count=${hour.body.count} hour=${hour.body.hour}`);
  ok('countOFIL audit reports cadence 15 in the flat shape',
     hour.body.fillGaps && hour.body.fillGaps.fillGapsOptions.cadenceS === 15 &&
     hour.body.fillGaps.fillGapsOptions.eras === undefined,
     JSON.stringify(hour.body.fillGaps && hour.body.fillGaps.fillGapsOptions));
  ok('countOFIL tariff buckets total the reported hour',
     near(hour.body.distHour.total, hour.body.hour, 1e-9) &&
     near(hour.body.distHourFine.total, hour.body.hour, 1e-9) &&
     near(hour.body.distHour.A + hour.body.distHour.B +
          hour.body.distHour.C + hour.body.distHour.D, hour.body.distHour.total, 1e-9),
     `${JSON.stringify(hour.body.distHour)} hour=${hour.body.hour}`);
  const raw = await get(countUrl(BASE, 0, HOUR, '&fillGaps=false'));
  ok('countOFIL &fillGaps=false keeps the 240 divisor and drops the audit',
     near(raw.body.hour, raw.body.count / 240, 1e-9) && raw.body.fillGaps === undefined,
     `count=${raw.body.count} hour=${raw.body.hour}`);
  const forced = await get(countUrl(BASE, 0, HOUR, '&pointsPerHour=360'));
  ok('countOFIL &pointsPerHour=360 still forces the old divisor',
     near(forced.body.hour, forced.body.count / 360, 1e-9),
     `count=${forced.body.count} hour=${forced.body.hour}`);

  // 7. &threshold= is in Hz, scaled back up to the stored hundredths. Tag 0's
  //    quiet hour sits at 0 Hz, so a 1 Hz threshold must count nothing while a
  //    negative one counts everything — the raw-units bug would count every
  //    sample either way (raw 0 > -99999, and any real value > 1).
  console.log('\n--- &threshold= is in Hz ---');
  const hz = await get(`${BASE}/plants/countOFIL?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}` +
    `&taf=${encodeURIComponent(HOUR[1])}&threshold=1`);
  const anyRunning = await get(`${BASE}/plants/countOFIL?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}` +
    `&taf=${encodeURIComponent(HOUR[1])}&threshold=0.01`);
  ok('countOFIL threshold in Hz counts a subset of all samples',
     hz.body.count <= hour.body.count && hz.body.count === anyRunning.body.count,
     `>1Hz ${hz.body.count}, >0.01Hz ${anyRunning.body.count}, all ${hour.body.count}`);
  ok('countOFIL tagName is the friendly one', hz.body.tagName === TAGS[0],
     JSON.stringify(hz.body.tagName));
  // Decisive: no drive runs above 100 Hz, so a 100 Hz threshold must count
  // nothing. If the threshold were compared in raw units it would mean 1.00 Hz
  // and count most of a running hour.
  const above100 = await get(`${BASE}/plants/countOFIL?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}` +
    `&taf=${encodeURIComponent(HOUR[1])}&threshold=100`);
  ok('countOFIL &threshold=100 (Hz) counts nothing', above100.body.count === 0,
     `got count=${above100.body.count}`);

  // 8. Edge cases must behave exactly like every other plant.
  console.log('\n--- edge cases ---');
  const noThreshold = await get(`${BASE}/plants/countOFIL?tagIndex=0&tbf=${encodeURIComponent(HOUR[0])}&taf=${encodeURIComponent(HOUR[1])}`);
  ok('countOFIL without &threshold= is 400',
     noThreshold.status === 400 && noThreshold.body.error,
     `${noThreshold.status} ${noThreshold.text.slice(0, 120)}`);
  const unknownWin = await get(`${BASE}/plants/OFIL/99/${win(HOUR)}`);
  ok('unknown tagIndex window returns []',
     Array.isArray(unknownWin.body) && unknownWin.body.length === 0, unknownWin.text.slice(0, 120));
  const unknownAvg = await get(`${BASE}/plants/OFIL/99/${win(HOUR)}/avg`);
  ok('unknown tagIndex /avg returns nulls',
     unknownAvg.body.tagName === null && unknownAvg.body.max === null &&
     unknownAvg.body.min === null && unknownAvg.body.avg === null, unknownAvg.text.slice(0, 160));
  const emptyAvg = await get(`${BASE}/plants/OFIL/0/${win(EMPTY)}/avg`);
  ok('window predating the database returns nulls from /avg',
     emptyAvg.body.tagName === null && emptyAvg.body.avg === null, emptyAvg.text.slice(0, 160));
  const emptyCount = await get(countUrl(BASE, 0, EMPTY));
  ok('window predating the database counts 0',
     emptyCount.body.count === 0 && emptyCount.body.hour === 0 && emptyCount.body.tagName === null,
     emptyCount.text.slice(0, 160));

  // 9. The root listing has to advertise the plant, renamed like the tag route.
  console.log('\n--- root listing ---');
  const root = await get(`${BASE}/plants/`);
  const entry = Array.isArray(root.body) && root.body.find(e => 'OFIL' in e);
  ok('root listing includes OFIL', Boolean(entry), root.text.slice(0, 200));
  ok('root listing tags are renamed',
     entry && Array.isArray(entry.tags) && entry.tags.length === 5 &&
     entry.tags.every(t => t.TagName === TAGS[t.TagIndex]),
     JSON.stringify(entry && entry.tags));
  ok('root listing still includes the unrelated Hour_OFIL',
     Array.isArray(root.body) && root.body.some(e => 'Hour_OFIL' in e), '');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
