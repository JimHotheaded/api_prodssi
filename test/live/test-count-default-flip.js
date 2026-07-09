// Verify the flipped default on /count* routes:
// A) &fillGaps=false on :3336 == :3334 default (legacy escape hatch), all plants x windows
// B) default (:3336, no param) == golden fillGaps values; explicit true == no param
// C) countWL / countHour_OFIL unaffected in every variant, still == :3334
// D) window routes still opt-in; threshold validation intact
const PROD = 'http://localhost:3334/plants';
const MOD  = 'http://localhost:3336/plants';
const q = encodeURIComponent;

const WINDOWS = [
  ['Mon A (10-11)',            '2026-07-06 10:00:00.000', '2026-07-06 11:00:00.000'],
  ['Mon A->B boundary (21-23)','2026-07-06 21:00:00.000', '2026-07-06 23:00:00.000'],
  ['Sun C->D boundary (17-19)','2026-07-05 17:00:00.000', '2026-07-05 19:00:00.000'],
  ['Fri->Sat all buckets',     '2026-07-03 20:00:00.000', '2026-07-04 08:00:00.000'],
];
const PLANTS = ['BM2_con','BM2','CT6_con','CT6_heater','CT7_con','CT7_heater',
  'CSH','FeedRaw','HYD','RMM1','RMM2','RRM','LC_CSH','Hour_OFIL','WL'];

let identical = 0, different = 0, failed = 0;
const diffs = [];

function check(name, cond, detail = '') {
  if (!cond) { failed++; console.log(`FAIL  ${name}  ${detail}`); }
  else console.log(`ok    ${name}  ${detail}`);
}
async function get(base, path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(70000) });
  let body; const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, text, body };
}

async function main() {
  // A) legacy escape hatch: mod?fillGaps=false vs prod default
  for (const plant of PLANTS) {
    for (const [label, tbf, taf] of WINDOWS) {
      const base = `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`;
      const [p, m] = await Promise.all([get(PROD, base), get(MOD, base + '&fillGaps=false')]);
      if (p.status === m.status && p.text === m.text) identical++;
      else { different++; diffs.push({ label: `count${plant} ${label}`, ps: p.status, ms: m.status, p: p.text.slice(0,150), m: m.text.slice(0,150) }); }
    }
  }
  console.log(`A) fillGaps=false vs production default: ${identical}/${identical + different} byte-identical`);
  for (const d of diffs) console.log(`   DIFF ${d.label}\n     prod(${d.ps}): ${d.p}\n     mod (${d.ms}): ${d.m}`);

  // B) new default = golden fillGaps values (BM2_con Mon 10-11)
  const [, tbf, taf] = WINDOWS[0];
  const dflt = await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`);
  const expl = await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0&fillGaps=true`);
  const off  = await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0&fillGaps=false`);
  check('B1 default hour is filled 0.9833', Math.abs(dflt.body.hour - 354/360) < 1e-12, `hour=${dflt.body.hour}`);
  check('B2 default has audit block 312/42/5',
    dflt.body.fillGaps && dflt.body.fillGaps.realReadings === 312 && dflt.body.fillGaps.filledReadings === 42 && dflt.body.fillGaps.flaggedGaps.length === 5,
    JSON.stringify(dflt.body.fillGaps && {real: dflt.body.fillGaps.realReadings, filled: dflt.body.fillGaps.filledReadings, flagged: dflt.body.fillGaps.flaggedGaps.length}));
  check('B3 explicit fillGaps=true == default bytes', expl.text === dflt.text);
  check('B4 fillGaps=false gives legacy 0.8667 without audit block',
    Math.abs(off.body.hour - 0.8666666666666667) < 1e-12 && off.body.fillGaps === undefined, `hour=${off.body.hour}`);
  check('B5 singular fillGap=false also works',
    (await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0&fillGap=false`)).text === off.text);
  check('B6 distHour follows filled data', Math.abs(dflt.body.distHour.A - 354/360) < 1e-12, `A=${dflt.body.distHour.A}`);

  // C) excluded routes: identical across no param / true / false, and == prod
  for (const p of ['Hour_OFIL','WL','LC_CSH']) {
    const base = `/count${p}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`;
    const [none, on, offP, prod] = await Promise.all([
      get(MOD, base), get(MOD, base + '&fillGaps=true'), get(MOD, base + '&fillGaps=false'), get(PROD, base)]);
    check(`C count${p} unaffected by param and == prod`,
      none.text === on.text && none.text === offP.text && none.text === prod.text && none.status === 200);
  }

  // D) window routes still opt-in + threshold validation
  const wPath = `/BM2_con/0/${q(tbf)}/${q(taf)}`;
  const [wProd, wMod, wFill] = await Promise.all([get(PROD, wPath), get(MOD, wPath), get(MOD, wPath + '?fillGaps=true')]);
  check('D1 window default still byte-identical to prod', wProd.text === wMod.text);
  check('D2 window fillGaps=true golden 354 total / 5 flagged', wFill.body.totalReadings === 354 && wFill.body.flaggedGaps.length === 5);
  const t = await get(MOD, `/countBM2?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}`);
  check('D3 missing threshold still 400', t.status === 400);

  console.log(`\n===== RESULT: ${different} unexpected diffs, ${failed} failed checks =====`);
  process.exit(different === 0 && failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
