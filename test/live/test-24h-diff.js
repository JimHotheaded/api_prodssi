// 24-hour comparison: production (:3334) vs modified (:3336).
// 1) default /count* over full days must be byte-identical
// 2) fillGaps=true on :3336 shows the per-machine daily runtime correction
const PROD = 'http://localhost:3334/plants';
const MOD  = 'http://localhost:3336/plants';
const q = encodeURIComponent;

const DAYS = [
  ['Mon 2026-07-06 (weekday, A/B)', '2026-07-06 00:00:00.000', '2026-07-07 00:00:00.000'],
  ['Sun 2026-07-05 (weekend, C/D)', '2026-07-05 00:00:00.000', '2026-07-06 00:00:00.000'],
];
const PLANTS = ['BM2_con','BM2','CT6_con','CT6_heater','CT7_con','CT7_heater',
  'CSH','FeedRaw','HYD','RMM1','RMM2','RRM','LC_CSH','Hour_OFIL','WL'];

let identical = 0, different = 0;
const diffs = [];

async function get(base, path) {
  const t0 = Date.now();
  const res = await fetch(base + path, { signal: AbortSignal.timeout(120000) });
  let body; const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, text, body, ms: Date.now() - t0 };
}

async function main() {
  // 1) default 24h /count* diff
  for (const plant of PLANTS) {
    for (const [label, tbf, taf] of DAYS) {
      const path = `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`;
      const [p, m] = await Promise.all([get(PROD, path), get(MOD, path)]);
      if (p.status === m.status && p.text === m.text) identical++;
      else { different++; diffs.push({ label: `count${plant} ${label}`, ps: p.status, ms: m.status, p: p.text.slice(0,150), m: m.text.slice(0,150) }); }
    }
  }
  console.log(`default 24h /count* vs production: ${identical}/${identical + different} byte-identical`);
  for (const d of diffs) console.log(`  DIFF ${d.label}\n    prod(${d.ps}): ${d.p}\n    mod (${d.ms}): ${d.m}`);

  // 2) daily runtime correction per machine (Monday), threshold=0
  console.log('\nFull-day runtime, Monday 2026-07-06 (threshold=0, 10s-cadence machines):');
  console.log('plant        prod hour   fillGaps hour   real rows   filled   flagged gaps (total s)');
  const [ , tbf, taf] = DAYS[0];
  for (const plant of ['BM2_con','BM2','CT6_con','CT6_heater','CT7_con','CT7_heater','CSH','FeedRaw','HYD','RMM1','RMM2','RRM']) {
    const base = await get(PROD, `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`);
    const fg = await get(MOD, `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0&fillGaps=true`);
    const g = fg.body.fillGaps;
    const flaggedS = g.flaggedGaps.reduce((s, x) => s + x.gap_s, 0);
    console.log(
      plant.padEnd(12),
      String(base.body.hour.toFixed(3)).padStart(9),
      String(fg.body.hour.toFixed(3)).padStart(13),
      String(g.realReadings).padStart(11),
      String(g.filledReadings).padStart(8),
      `  ${g.flaggedGaps.length} (${flaggedS.toFixed(0)}s)`
    );
  }

  // 3) tariff-bucket integrity on the corrected data (BM2_con Monday):
  const fg = await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0&fillGaps=true`);
  const d = fg.body.distHour;
  const sumOk = Math.abs((d.A + d.B + d.C + d.D) - d.total) < 1e-9 && Math.abs(d.total - fg.body.hour) < 1e-9;
  console.log(`\nBM2_con Monday distHour: A=${d.A.toFixed(3)} B=${d.B.toFixed(3)} C=${d.C.toFixed(3)} D=${d.D.toFixed(3)} total=${d.total.toFixed(3)}`);
  console.log(`${sumOk ? 'ok  ' : 'FAIL'}  buckets sum to total and match hour; total <= 24: ${d.total <= 24}`);

  // Sunday: weekday buckets must be zero
  const [ , stbf, staf] = DAYS[1];
  const sun = await get(MOD, `/countBM2_con?tagIndex=0&tbf=${q(stbf)}&taf=${q(staf)}&threshold=0&fillGaps=true`);
  const sd = sun.body.distHour;
  const sunOk = sd.A === 0 && sd.B === 0;
  console.log(`BM2_con Sunday distHour: A=${sd.A} B=${sd.B} C=${sd.C.toFixed(3)} D=${sd.D.toFixed(3)} total=${sd.total.toFixed(3)}`);
  console.log(`${sunOk ? 'ok  ' : 'FAIL'}  Sunday hours land only in weekend buckets C/D`);

  process.exit(different === 0 && sumOk && sunOk ? 0 : 1);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
