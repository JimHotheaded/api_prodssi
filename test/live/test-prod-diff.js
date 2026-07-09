// Differential test: production (original time logic, :3334) vs modified (:3336).
// For identical historical windows, count/avg/raw responses must be byte-identical.
// Windows deliberately straddle every tariff boundary so any clock/holiday
// discrepancy in the new clock:'utc' bucketing would surface as a diff.
const PROD = 'http://localhost:3334/plants';
const MOD  = 'http://localhost:3336/plants';
const q = encodeURIComponent;

// 2026-07-03 Fri, 07-04 Sat, 07-05 Sun, 07-06 Mon
const WINDOWS = [
  ['Mon pure A (10-11)',        '2026-07-06 10:00:00.000', '2026-07-06 11:00:00.000'],
  ['Mon pure B (01-04)',        '2026-07-06 01:00:00.000', '2026-07-06 04:00:00.000'],
  ['Mon B->A boundary (08-10)', '2026-07-06 08:00:00.000', '2026-07-06 10:00:00.000'],
  ['Mon A->B boundary (21-23)', '2026-07-06 21:00:00.000', '2026-07-06 23:00:00.000'],
  ['Sun pure C (10-12)',        '2026-07-05 10:00:00.000', '2026-07-05 12:00:00.000'],
  ['Sun pure D (03-05)',        '2026-07-05 03:00:00.000', '2026-07-05 05:00:00.000'],
  ['Sun C->D boundary (17-19)', '2026-07-05 17:00:00.000', '2026-07-05 19:00:00.000'],
  ['Fri->Sat A+B+D+C (20-08)',  '2026-07-03 20:00:00.000', '2026-07-04 08:00:00.000'],
];
const PLANTS = ['BM2_con','BM2','CSH','HYD','RRM','LC_CSH','Hour_OFIL'];

let identical = 0, different = 0, expectedDiffs = 0;
const diffs = [];

async function get(base, path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(70000) });
  return { status: res.status, text: await res.text() };
}

async function compare(path, label) {
  const [p, m] = await Promise.all([get(PROD, path), get(MOD, path)]);
  if (p.status === m.status && p.text === m.text) { identical++; return; }
  different++;
  diffs.push({ label, path, prodStatus: p.status, modStatus: m.status,
    prod: p.text.slice(0, 200), mod: m.text.slice(0, 200) });
}

async function main() {
  // 1. count endpoints (the time-bucketing logic under test) — every plant x window
  for (const plant of PLANTS) {
    for (const [label, tbf, taf] of WINDOWS) {
      await compare(`/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`, `count ${plant} ${label}`);
    }
  }

  // 2. avg endpoints — one boundary window per plant (skip BM2_con: fixed bug = expected diff)
  for (const plant of PLANTS.filter(p => p !== 'BM2_con')) {
    const [label, tbf, taf] = WINDOWS[7];
    await compare(`/${plant}/0/${q(tbf)}/${q(taf)}/avg`, `avg ${plant} ${label}`);
  }

  // 3. raw window data — timestamps serialized identically?
  for (const plant of ['BM2', 'Hour_OFIL']) {
    const [label, tbf, taf] = WINDOWS[0];
    await compare(`/${plant}/0/${q(tbf)}/${q(taf)}`, `raw ${plant} ${label}`);
  }

  // 4. Expected differences (fixes) — verify they differ in the intended direction
  const [, tbf, taf] = WINDOWS[0];
  const bugAvg = await Promise.all([
    get(PROD, `/BM2_con/0/${q(tbf)}/${q(taf)}/avg`),
    get(MOD,  `/BM2_con/0/${q(tbf)}/${q(taf)}/avg`)]);
  const e1 = bugAvg[0].status === 500 && bugAvg[1].status === 200;
  console.log(`${e1 ? 'ok  ' : 'FAIL'}  expected diff: BM2_con avg prod=500 mod=200 (got ${bugAvg[0].status}/${bugAvg[1].status})`);
  if (e1) expectedDiffs++;

  const noThresh = await Promise.all([
    get(PROD, `/countBM2?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}`),
    get(MOD,  `/countBM2?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}`)]);
  const e2 = noThresh[0].status === 200 && noThresh[1].status === 400;
  console.log(`${e2 ? 'ok  ' : 'FAIL'}  expected diff: missing threshold prod=200(silent 0) mod=400 (got ${noThresh[0].status}/${noThresh[1].status})`);
  if (e2) expectedDiffs++;

  // Summary
  console.log(`\n===== RESULT =====`);
  console.log(`byte-identical responses: ${identical}/${identical + different}`);
  console.log(`unexpected differences:   ${different}`);
  for (const d of diffs) {
    console.log(`\nDIFF  ${d.label}\n  ${d.path}\n  prod(${d.prodStatus}): ${d.prod}\n  mod (${d.modStatus}): ${d.mod}`);
  }
  process.exit(different === 0 && expectedDiffs === 2 ? 0 : 1);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
