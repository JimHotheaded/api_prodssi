/*
 * Live regression for the per-machine logging-cadence eras (CADENCE_ERAS in
 * api/routes/plants.js).
 *
 * The whole plant moved from a 10s to a 15s Kepware log interval on 2026-08-06
 * (RMM1 a month earlier, 2026-07-09). count{plant} run-hours are sample counts
 * divided by samples-per-hour, so each side of a changeover has to be counted
 * with its own divisor or a running machine reports 2/3 of its real hours.
 *
 * Unlike the other scripts in this folder, this one does NOT need a candidate
 * server: it starts the app in-process on an ephemeral port. It still needs the
 * plant network and the production API on :3334 to diff history against.
 *
 *   node test/live/test-cadence-eras.js
 *
 * The windows below are fixed historical ones and stay valid as long as the
 * historian retains 2026-07-06/09 and 2026-08-05/06.
 */
const app = require('../../app');

const PROD = process.env.PROD_URL || 'http://localhost:3334';

// Windows for the plant-wide 2026-08-06 changeover. `straddle` brackets it.
const BEFORE   = ['2026-08-05 10:00:00.000', '2026-08-05 11:00:00.000'];
const AFTER    = ['2026-08-06 12:00:00.000', '2026-08-06 13:00:00.000'];
const STRADDLE = ['2026-08-06 11:00:00.000', '2026-08-06 12:00:00.000'];
// RMM1 changed a month earlier, so "before" for it has to predate 2026-07-09.
const RMM1_BEFORE   = ['2026-07-06 10:00:00.000', '2026-07-06 11:00:00.000'];
const RMM1_STRADDLE = ['2026-07-09 09:00:00.000', '2026-07-09 10:00:00.000'];

// One busy tag per machine, its measured changeover instant, and the windows
// that sit either side of it.
const MACHINES = [
  { plant: 'BM2_con',    tag: 9,  change: '2026-08-06T11:27:15.000Z' },
  { plant: 'BM2',        tag: 5,  change: '2026-08-06T11:27:25.000Z' },
  { plant: 'CT6_con',    tag: 1,  change: '2026-08-06T11:28:05.000Z' },
  { plant: 'CT6_heater', tag: 1,  change: '2026-08-06T11:29:24.000Z' },
  { plant: 'CT7_con',    tag: 13, change: '2026-08-06T11:30:05.000Z' },
  { plant: 'CT7_heater', tag: 1,  change: '2026-08-06T11:30:16.000Z' },
  { plant: 'CSH',        tag: 1,  change: '2026-08-06T11:30:24.000Z' },
  { plant: 'FeedRaw',    tag: 1,  change: '2026-08-06T11:30:36.000Z' },
  { plant: 'HYD',        tag: 1,  change: '2026-08-06T11:30:56.000Z' },
  { plant: 'RMM2',       tag: 1,  change: '2026-08-06T11:31:17.000Z' },
  { plant: 'RRM',        tag: 5,  change: '2026-08-06T11:31:28.000Z' },
  { plant: 'RMM1',       tag: 9,  change: '2026-07-09T09:18:12.000Z',
    before: RMM1_BEFORE, straddle: RMM1_STRADDLE },
].map(m => ({ before: BEFORE, after: AFTER, straddle: STRADDLE, ...m }));

// Machines with no cadence to split: 60s counter, on-change logging, event data.
const EXCLUDED = [
  { plant: 'Hour_OFIL', tag: 5, extra: '&pointsPerHour=60' },
  { plant: 'LC_CSH',    tag: 0, extra: '' },
  { plant: 'WL',        tag: 1, extra: '' },
];

// Counts every logged sample regardless of the machine's state, so `hour`
// measures the divisor rather than how busy the plant happened to be.
const ALL = -99999;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};
const near = (a, b, eps = 0.02) => typeof a === 'number' && Math.abs(a - b) <= eps;

const countUrl = (base, plant, tag, [tbf, taf], extra = '') =>
  `${base}/plants/count${plant}?tagIndex=${tag}&tbf=${encodeURIComponent(tbf)}` +
  `&taf=${encodeURIComponent(taf)}&threshold=${ALL}${extra}`;

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

// The mssql pool connects lazily after listen(); firing requests before it is
// ready just returns ECONNCLOSED.
async function warmup(base) {
  for (let i = 0; i < 60; i++) {
    try { if ((await get(`${base}/plants/BM2`)).status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('candidate never became ready');
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const CAND = `http://localhost:${server.address().port}`;
  await warmup(CAND);
  console.log(`candidate (in-process) ${CAND}\nproduction             ${PROD}\n`);

  // 1. A full hour of 15s logging is one run-hour. This is the actual bug fix:
  //    with a hardcoded 360 divisor these all come back as 0.6667.
  console.log('--- post-changeover windows: a full hour must read 1.0 h ---');
  for (const m of MACHINES) {
    const r = await get(countUrl(CAND, m.plant, m.tag, m.after));
    ok(`count${m.plant} 15s hour=1.0`, near(r.body.hour, 1.0),
       `got hour=${r.body.hour} count=${r.body.count}`);
    ok(`count${m.plant} 15s audit reports cadence 15`,
       r.body.fillGaps && r.body.fillGaps.fillGapsOptions.cadenceS === 15,
       `got ${JSON.stringify(r.body.fillGaps && r.body.fillGaps.fillGapsOptions)}`);
  }

  // 2. History must not move: windows wholly before a machine's changeover have
  //    to stay byte-identical to what production already serves, flat audit and all.
  console.log('\n--- pre-changeover windows: byte-identical to production ---');
  for (const m of MACHINES) {
    const [c, p] = await Promise.all([
      get(countUrl(CAND, m.plant, m.tag, m.before)),
      get(countUrl(PROD, m.plant, m.tag, m.before)),
    ]);
    // Divides by 360, not 240. Asserted against the count rather than 1.0 h,
    // because a window with a genuinely unfillable gap legitimately reads below
    // a full hour (RMM1's 2026-07-06 window is one such).
    ok(`count${m.plant} pre-change divides by 360`,
       near(c.body.hour, c.body.count / 360, 1e-9) && c.body.count > 300,
       `got hour=${c.body.hour} count=${c.body.count}`);
    // RMM1 is the one exception: production era-split it already, and reported
    // even a single-era window with the nested eras[] audit wrapper. Its numbers
    // must match; only that wrapper is expected to flatten.
    if (m.plant === 'RMM1') {
      ok('countRMM1 pre-change numbers unchanged',
         c.body.count === p.body.count && c.body.hour === p.body.hour &&
         JSON.stringify(c.body.distHour) === JSON.stringify(p.body.distHour),
         `cand ${c.body.count}/${c.body.hour} vs prod ${p.body.count}/${p.body.hour}`);
      ok('countRMM1 single-era audit is now flat like every other plant',
         c.body.fillGaps.fillGapsOptions.cadenceS === 10 &&
         c.body.fillGaps.fillGapsOptions.eras === undefined,
         JSON.stringify(c.body.fillGaps.fillGapsOptions));
    } else {
      ok(`count${m.plant} pre-change byte-identical`, c.text === p.text,
         `cand ${c.text.slice(0, 220)}\n       prod ${p.text.slice(0, 220)}`);
    }
  }

  // 3. A window crossing the boundary is the case no single divisor can get
  //    right: 10s samples on one side, 15s on the other, and the boundary row
  //    must be counted exactly once (double-counting reads >1 h, dropping <1 h).
  console.log('\n--- straddling windows: both eras, still exactly 1.0 h ---');
  for (const m of MACHINES) {
    const r = await get(countUrl(CAND, m.plant, m.tag, m.straddle));
    const eras = r.body.fillGaps && r.body.fillGaps.fillGapsOptions.eras;
    ok(`count${m.plant} straddle hour=1.0`, near(r.body.hour, 1.0),
       `got hour=${r.body.hour} count=${r.body.count}`);
    ok(`count${m.plant} straddle audit lists both cadences`,
       Array.isArray(eras) && eras.length === 2 &&
       eras[0].cadenceS === 10 && eras[1].cadenceS === 15 &&
       eras[0].until === m.change && eras[1].from === m.change,
       JSON.stringify(eras));
    // distHour/distHourFine are per-era sums, so their totals must still agree
    // with the top-level hour.
    ok(`count${m.plant} straddle distHour total matches hour`,
       near(r.body.distHour.total, r.body.hour, 1e-9) &&
       near(r.body.distHourFine.total, r.body.hour, 1e-9),
       `distHour ${r.body.distHour.total} distHourFine ${r.body.distHourFine.total} hour ${r.body.hour}`);
    ok(`count${m.plant} straddle A+B+C+D equals total`,
       near(r.body.distHour.A + r.body.distHour.B + r.body.distHour.C + r.body.distHour.D,
            r.body.distHour.total, 1e-9),
       JSON.stringify(r.body.distHour));
  }

  // 4. The documented pre-era-split workaround has to keep working unchanged.
  console.log('\n--- explicit &pointsPerHour=/&cadence= still force one cadence ---');
  for (const m of MACHINES.slice(0, 4)) {
    const [c, p] = await Promise.all([
      get(countUrl(CAND, m.plant, m.tag, m.before, '&pointsPerHour=360&cadence=10')),
      get(countUrl(PROD, m.plant, m.tag, m.before, '&pointsPerHour=360&cadence=10')),
    ]);
    ok(`count${m.plant} forced 360/10 unchanged`, c.text === p.text,
       `cand ${c.text.slice(0, 200)}\n       prod ${p.text.slice(0, 200)}`);
    // Forcing the old cadence over 15s data is meant to reproduce the old wrong
    // answer, not to be silently corrected.
    const forcedAfter = await get(countUrl(CAND, m.plant, m.tag, m.after, '&pointsPerHour=360'));
    ok(`count${m.plant} forced 360 over 15s data still divides by 360`,
       near(forcedAfter.body.hour, 240 / 360, 0.03),
       `got ${forcedAfter.body.hour}`);
  }

  // 5. Raw (unfilled) counts must use the era divisors too.
  console.log('\n--- &fillGaps=false keeps era-correct divisors ---');
  for (const m of MACHINES.slice(0, 4)) {
    const r = await get(countUrl(CAND, m.plant, m.tag, m.after, '&fillGaps=false'));
    ok(`count${m.plant} raw 15s hour=count/240`,
       near(r.body.hour, r.body.count / 240, 1e-9) && r.body.fillGaps === undefined,
       `count=${r.body.count} hour=${r.body.hour}`);
  }

  // 6. Machines with no fixed cadence must be untouched by any of this.
  console.log('\n--- excluded machines byte-identical to production ---');
  for (const e of EXCLUDED) {
    for (const [label, win] of [['pre', BEFORE], ['post', AFTER]]) {
      const [c, p] = await Promise.all([
        get(countUrl(CAND, e.plant, e.tag, win, e.extra)),
        get(countUrl(PROD, e.plant, e.tag, win, e.extra)),
      ]);
      ok(`count${e.plant} ${label}-change byte-identical`, c.text === p.text,
         `cand ${c.text.slice(0, 200)}\n       prod ${p.text.slice(0, 200)}`);
    }
  }

  // 7. Window routes: raw rows are cadence-independent, but the opt-in fill has
  //    to synthesize at the rate that was actually in force.
  console.log('\n--- window-route fill cadence follows the window ---');
  for (const m of MACHINES.slice(0, 3)) {
    const w = (win) => `${CAND}/plants/${m.plant}/${m.tag}/` +
      `${encodeURIComponent(win[0])}/${encodeURIComponent(win[1])}?fillGaps=true`;
    const [before, after] = await Promise.all([get(w(m.before)), get(w(m.after))]);
    ok(`${m.plant} window pre-change defaults to cadence 10`,
       before.body.fillGapsOptions && before.body.fillGapsOptions.cadenceS === 10,
       JSON.stringify(before.body.fillGapsOptions));
    ok(`${m.plant} window post-change defaults to cadence 15`,
       after.body.fillGapsOptions && after.body.fillGapsOptions.cadenceS === 15,
       JSON.stringify(after.body.fillGapsOptions));
    const explicit = await get(w(m.after) + '&cadence=10');
    ok(`${m.plant} window explicit &cadence=10 still wins`,
       explicit.body.fillGapsOptions.cadenceS === 10,
       JSON.stringify(explicit.body.fillGapsOptions));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
