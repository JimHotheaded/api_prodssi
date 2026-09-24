/*
 * Live test for the CSH display layer (api/tagDisplay.js), added 2026-09-01.
 *
 * CSH is the fourth plant in the display table and the first PARTIAL one: only
 * 3 of its 21 tags are mapped, and that is the property most likely to break
 * silently. Two distinct things are pinned here:
 *
 *   1. The mapped tags are converted. 8 (Grizzly_Hz) and 19 (Screen_Hz) are
 *      drive output frequencies logged in hundredths of a Hz, so they are
 *      renamed AND divided by 100; 20 (Hopper_level) is a loadcell real
 *      already in engineering units, so it is renamed and NOT divided.
 *      countCSH's &threshold= is therefore in Hz for 8 and 19 only.
 *   2. The 18 UNMAPPED tags are untouched — same raw historian name, same raw
 *      value, byte-identical to a direct SQL read. A regression that scaled
 *      the whole plant would still pass check 1 and fail here.
 *
 * Tag 8 was served raw from 2025-09-02 until 2026-09-01; scaling it was a
 * deliberate breaking change, so the /100 assertions below are load-bearing
 * rather than cosmetic.
 *
 * Like test-ofil.js and test-silo.js this needs NO candidate server and no
 * production API: it starts the app in-process on an ephemeral port and checks
 * the routes against the historian directly. It does need the plant network.
 *
 *   node test/live/test-csh-display.js
 *
 * The window below is a fixed historical one and stays valid as long as the
 * historian retains 2026-08-31.
 */
const app = require('../../app');
const sql = require('mssql');
const { dbConfig_PROD } = require('../../config');

const FLOAT = '[REPL_Crushing_Log].[dbo].[FloatValue]';

// A fully-logged hour with all three mapped tags running: exactly 240 samples
// each at 15s, no gap over 15s, verified when this was written. Tags 19/20
// only began logging 2026-08-31 15:32:13, so nothing earlier is a complete
// hour for them. Deliberately a RUNNING hour (tag 19 spans raw 2200..4000)
// rather than an idle one, so the Hz threshold check has something to bite on.
const HOUR = ['2026-08-31 17:00:00.000', '2026-08-31 18:00:00.000'];
// Before the plant logged anything at all.
const EMPTY = ['2020-01-01 00:00:00.000', '2020-01-01 01:00:00.000'];

const TAG_COUNT = 21;
// The mapped tags, spelled out rather than imported from api/tagDisplay.js so a
// typo there fails this test instead of agreeing with itself.
const MAPPED = {
  8:  { name: 'Grizzly_Hz',   divisor: 100 },
  19: { name: 'Screen_Hz',    divisor: 100 },
  20: { name: 'Hopper_level', divisor: 1 },
};
// A sample of tags that must NOT be touched, with their exact historian names.
// If someone maps the whole plant, these fail.
const UNMAPPED = {
  0: 'Crushing\\Input\\B7_1_Current',
  5: '[PLC_Crushing]B20_1_Current',
  9: 'SiemensOPC.RaymondMill2_Conveyor.WeightSilo0',
  14: '::[PLC_Ofil]OFIL_SILO4:I.OutputFreq',
};
// Raw names of the MAPPED tags only — none may reach the wire. The unmapped
// tags legitimately still carry raw names, so this list is deliberately narrow.
const RAW_FRAGMENTS = ['PF_CSH', 'VIBRATION_FEED', 'BRS_REAL[00]'];
// Counts every logged sample regardless of machine state, so `hour` measures
// the cadence divisor rather than how busy the crusher happened to be.
const ALL = -99999;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= eps;

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

const win = ([tbf, taf]) => `${encodeURIComponent(tbf)}/${encodeURIComponent(taf)}`;
const countUrl = (base, tag, [tbf, taf], threshold = ALL, extra = '') =>
  `${base}/plants/countCSH?tagIndex=${tag}&tbf=${encodeURIComponent(tbf)}` +
  `&taf=${encodeURIComponent(taf)}&threshold=${threshold}${extra}`;

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
  const pool = await new sql.ConnectionPool({ ...dbConfig_PROD, database: '' }).connect();

  // 1. Tag list: exactly the three mapped tags are renamed, the rest are not.
  console.log('--- tag list is PARTIALLY renamed ---');
  const list = await get(`${BASE}/plants/CSH`);
  ok('GET /plants/CSH 200', list.status === 200, `got ${list.status}`);
  ok(`CSH lists ${TAG_COUNT} tags`,
     Array.isArray(list.body) && list.body.length === TAG_COUNT,
     `got ${Array.isArray(list.body) ? list.body.length : list.text.slice(0, 200)}`);
  const byIndex = Object.fromEntries((list.body || []).map(t => [t.TagIndex, t.TagName]));
  for (const [i, m] of Object.entries(MAPPED)) {
    ok(`tag ${i} is renamed to ${m.name}`, byIndex[i] === m.name, `got ${byIndex[i]}`);
  }
  for (const [i, raw] of Object.entries(UNMAPPED)) {
    ok(`tag ${i} keeps its raw historian name`, byIndex[i] === raw, `got ${byIndex[i]}`);
  }
  ok('no mapped tag\'s raw name leaks into the tag list',
     RAW_FRAGMENTS.every(f => !list.text.includes(f)),
     RAW_FRAGMENTS.filter(f => list.text.includes(f)).join(', '));

  // 2. Latest value: mapped tags converted against the historian directly, so a
  //    wrong divisor fails here rather than looking self-consistent.
  console.log('\n--- latest value: mapped tags are converted ---');
  for (const [i, m] of Object.entries(MAPPED)) {
    const raw = await pool.request().query`
  SELECT TOP (1) DateAndTime, Val FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = ${i} AND Status <> 'E' ORDER BY DateAndTime DESC`;
    const got = await get(`${BASE}/plants/CSH/${i}`);
    const row = Array.isArray(got.body) ? got.body[0] : null;
    const expected = raw.recordset[0].Val / m.divisor;
    ok(`tag ${i} latest is ${m.name} = raw/${m.divisor}`,
       row && row.TagName === m.name && near(row.Val, expected),
       `api ${row && row.Val} vs raw ${raw.recordset[0].Val}/${m.divisor} = ${expected}`);
  }
  // Hz sanity: a drive frequency can never be in the thousands.
  for (const i of [8, 19]) {
    const got = await get(`${BASE}/plants/CSH/${i}`);
    const v = got.body[0].Val;
    ok(`tag ${i} reads on a Hz scale (< 100)`, v < 100, `got ${v}`);
  }
  // Tag 20 is rename-only: the value must be EXACTLY what the DB holds.
  const raw20 = await pool.request().query`
  SELECT TOP (1) Val FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = 20 AND Status <> 'E' ORDER BY DateAndTime DESC`;
  const api20 = await get(`${BASE}/plants/CSH/20`);
  ok('tag 20 value is NOT divided (rename-only)',
     api20.body[0].Val === raw20.recordset[0].Val,
     `api ${api20.body[0].Val} vs raw ${raw20.recordset[0].Val}`);

  // 3. Unmapped tags must be byte-identical to a direct read — name AND value.
  console.log('\n--- latest value: unmapped tags are untouched ---');
  for (const [i, rawName] of Object.entries(UNMAPPED)) {
    const raw = await pool.request().query`
  SELECT TOP (1) Val FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = ${i} AND Status <> 'E' ORDER BY DateAndTime DESC`;
    const got = await get(`${BASE}/plants/CSH/${i}`);
    const row = Array.isArray(got.body) ? got.body[0] : null;
    ok(`tag ${i} passes through raw`,
       row && row.TagName === rawName && row.Val === raw.recordset[0].Val,
       `api ${row && row.TagName}=${row && row.Val} vs raw ${rawName}=${raw.recordset[0].Val}`);
  }

  // 4. /all interleaves every tag: each row must be converted against its OWN
  //    TagIndex, mapped and unmapped side by side in one response.
  console.log('\n--- /all converts per row ---');
  const all = await get(`${BASE}/plants/CSH/all`);
  ok('GET /plants/CSH/all 200', all.status === 200, `got ${all.status}`);
  const mappedRows = (all.body || []).filter(r => r.TagIndex in MAPPED);
  const unmappedRows = (all.body || []).filter(r => r.TagIndex in UNMAPPED);
  ok('/all renames every mapped row',
     mappedRows.length > 0 && mappedRows.every(r => r.TagName === MAPPED[r.TagIndex].name),
     JSON.stringify(mappedRows.slice(0, 2)));
  ok('/all leaves every unmapped row raw',
     unmappedRows.length > 0 && unmappedRows.every(r => r.TagName === UNMAPPED[r.TagIndex]),
     JSON.stringify(unmappedRows.slice(0, 2)));
  ok('/all leaks no mapped raw name',
     RAW_FRAGMENTS.every(f => !all.text.includes(f)),
     RAW_FRAGMENTS.filter(f => all.text.includes(f)).join(', '));

  // 5. /avg is aggregated in SQL then converted — cross-check the arithmetic.
  console.log('\n--- /avg ---');
  const aggSql = await pool.request().query`
  SELECT MIN(Val) mn, MAX(Val) mx, AVG(Val) av FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = 19 AND Status <> 'E' AND DateAndTime BETWEEN ${HOUR[0]} AND ${HOUR[1]}`;
  const a = aggSql.recordset[0];
  const avg19 = await get(`${BASE}/plants/CSH/19/${win(HOUR)}/avg`);
  ok('/avg on tag 19 is renamed and /100',
     avg19.body.tagName === 'Screen_Hz' &&
     near(avg19.body.max, a.mx / 100) && near(avg19.body.min, a.mn / 100) &&
     near(avg19.body.avg, a.av / 100),
     `api ${JSON.stringify(avg19.body)} vs sql ${JSON.stringify(a)}`);
  const aggSql0 = await pool.request().query`
  SELECT MIN(Val) mn, MAX(Val) mx FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = 0 AND Status <> 'E' AND DateAndTime BETWEEN ${HOUR[0]} AND ${HOUR[1]}`;
  const avg0 = await get(`${BASE}/plants/CSH/0/${win(HOUR)}/avg`);
  ok('/avg on an unmapped tag is untouched',
     avg0.body.tagName === UNMAPPED[0] &&
     avg0.body.max === aggSql0.recordset[0].mx && avg0.body.min === aggSql0.recordset[0].mn,
     `api ${JSON.stringify(avg0.body)} vs sql ${JSON.stringify(aggSql0.recordset[0])}`);

  // 6. Window route, raw and gap-filled. cadence=5 makes the real 15s spacing
  //    look like a gap, which forces synthetic rows to exist so we can check
  //    they are converted too (the fill must run BEFORE the conversion).
  console.log('\n--- window route ---');
  const w19 = await get(`${BASE}/plants/CSH/19/${win(HOUR)}`);
  ok('window rows are renamed and /100',
     Array.isArray(w19.body) && w19.body.length === 240 &&
     w19.body.every(r => r.TagName === 'Screen_Hz' && r.Val < 100),
     `${Array.isArray(w19.body) ? w19.body.length : w19.text.slice(0, 120)}`);
  const w0 = await get(`${BASE}/plants/CSH/0/${win(HOUR)}`);
  ok('window rows of an unmapped tag are untouched',
     Array.isArray(w0.body) && w0.body.every(r => r.TagName === UNMAPPED[0]),
     w0.text.slice(0, 120));
  const filled = await get(`${BASE}/plants/CSH/19/${win(HOUR)}?fillGaps=true&cadence=5`);
  const synth = (filled.body.readings || []).filter(r => r.Filled);
  ok('gap fill produced synthetic rows to check',
     synth.length > 0, `filledReadings=${filled.body.filledReadings}`);
  ok('synthetic rows are renamed and /100 like the real ones',
     synth.length > 0 && synth.every(r => r.TagName === 'Screen_Hz' && r.Val < 100),
     JSON.stringify(synth.slice(0, 2)));

  // 7. countCSH: &threshold= is in Hz for the mapped frequency tags. Compared
  //    against the raw-units count SQL gives for the same cut, so a missing
  //    multiply-back fails here.
  console.log('\n--- countCSH &threshold= is in Hz for tags 8/19 ---');
  const rawOver = await pool.request().query`
  SELECT COUNT(*) n FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = 19 AND Status <> 'E' AND Val > 3000
AND DateAndTime BETWEEN ${HOUR[0]} AND ${HOUR[1]}`;
  const hz30 = await get(countUrl(BASE, 19, HOUR, 30, '&fillGaps=false'));
  ok('threshold=30 (Hz) counts what raw > 3000 counts',
     hz30.body.count === rawOver.recordset[0].n,
     `api ${hz30.body.count} vs sql ${rawOver.recordset[0].n}`);
  const hz3000 = await get(countUrl(BASE, 19, HOUR, 3000, '&fillGaps=false'));
  ok('threshold=3000 now counts nothing (it would be 30000 raw)',
     hz3000.body.count === 0, `got ${hz3000.body.count}`);
  ok('countCSH reports the friendly name',
     hz30.body.tagName === 'Screen_Hz', `got ${hz30.body.tagName}`);
  // Unmapped tags keep raw-unit thresholds.
  const rawOver0 = await pool.request().query`
  SELECT COUNT(*) n FROM [REPL_Crushing_Log].[dbo].[FloatValue]
WHERE TagIndex = 0 AND Status <> 'E' AND Val > 1
AND DateAndTime BETWEEN ${HOUR[0]} AND ${HOUR[1]}`;
  const c0 = await get(countUrl(BASE, 0, HOUR, 1, '&fillGaps=false'));
  ok('an unmapped tag\'s threshold stays in raw units',
     c0.body.count === rawOver0.recordset[0].n && c0.body.tagName === UNMAPPED[0],
     `api ${c0.body.count}/${c0.body.tagName} vs sql ${rawOver0.recordset[0].n}`);

  // 8. The cadence era is untouched by the display layer: a full hour of 15s
  //    logging must still read exactly 1.0 h off 240 samples.
  console.log('\n--- cadence era is unaffected ---');
  const full = await get(countUrl(BASE, 19, HOUR));
  ok('a full hour reads 1.0 h from 240 samples',
     full.body.count === 240 && near(full.body.hour, 1, 1e-9),
     `count=${full.body.count} hour=${full.body.hour}`);
  ok('the fillGaps audit reports the 15s cadence',
     full.body.fillGaps && full.body.fillGaps.fillGapsOptions.cadenceS === 15,
     JSON.stringify(full.body.fillGaps && full.body.fillGaps.fillGapsOptions));

  // 9. Edge cases must behave exactly as every other plant does.
  console.log('\n--- edge cases ---');
  const noThr = await get(`${BASE}/plants/countCSH?tagIndex=19&tbf=${encodeURIComponent(HOUR[0])}&taf=${encodeURIComponent(HOUR[1])}`);
  ok('countCSH without &threshold= is 400', noThr.status === 400, `got ${noThr.status}`);
  const badThr = await get(countUrl(BASE, 19, HOUR, 'abc'));
  ok('countCSH with a non-numeric &threshold= is 400', badThr.status === 400, `got ${badThr.status}`);
  const unknown = await get(`${BASE}/plants/CSH/9999/${win(HOUR)}`);
  ok('unknown tagIndex window returns []',
     Array.isArray(unknown.body) && unknown.body.length === 0, unknown.text.slice(0, 120));
  const unknownAvg = await get(`${BASE}/plants/CSH/9999/${win(HOUR)}/avg`);
  ok('unknown tagIndex /avg returns nulls',
     unknownAvg.body.tagName === null && unknownAvg.body.max === null,
     JSON.stringify(unknownAvg.body));
  const preAvg = await get(`${BASE}/plants/CSH/19/${win(EMPTY)}/avg`);
  ok('window predating the data returns nulls from /avg',
     preAvg.body.tagName === null && preAvg.body.avg === null, JSON.stringify(preAvg.body));
  const preCount = await get(countUrl(BASE, 19, EMPTY));
  ok('window predating the data counts 0', preCount.body.count === 0, JSON.stringify(preCount.body));

  // 10. The root listing carries the same partial rename.
  console.log('\n--- root listing ---');
  const root = await get(`${BASE}/plants/`);
  const entry = Array.isArray(root.body) && root.body.find(e => 'CSH' in e);
  ok('root listing includes CSH', Boolean(entry), root.text.slice(0, 200));
  const rootByIndex = Object.fromEntries(((entry && entry.tags) || []).map(t => [t.TagIndex, t.TagName]));
  ok('root listing applies the same partial rename',
     entry && entry.tags.length === TAG_COUNT &&
     Object.entries(MAPPED).every(([i, m]) => rootByIndex[i] === m.name) &&
     Object.entries(UNMAPPED).every(([i, n]) => rootByIndex[i] === n),
     JSON.stringify((entry && entry.tags || []).slice(0, 3)));
  ok('root listing documents the conversion in note_CSH',
     root.body.some(e => 'note_CSH' in e), 'note_CSH missing');
  for (const plant of ['RRM', 'OFIL', 'Silo', 'LC_CSH']) {
    ok(`root listing still includes ${plant}`,
       root.body.some(e => plant in e), `${plant} missing`);
  }

  await pool.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
