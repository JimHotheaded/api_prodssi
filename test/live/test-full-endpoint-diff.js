// Pre-go-live gate: compare EVERY endpoint on this copy (:3336) against
// production (:3334). Exit 0 only if the sole differences are the three
// deliberate ones:
//   1. root "/" doc text (structural compare instead: tag lists must match)
//   2. /count* default responses are gap-filled (byte-identity asserted on the
//      &fillGaps=false leg; countWL/countHour_OFIL/countLC_CSH must be
//      byte-identical even by default)
//   3. /count* returns 400 on missing/non-numeric threshold
//   4. /BM2_con/:tagIndex/:tbf/:taf/avg works here (200) while production
//      still 500s on it (copy-paste typo "TagIndex <> 'E'" fixed in this copy)
// Live endpoints (/{plant}, /all, latest value) race against ~10s logging:
// fetch both servers in parallel and retry a mismatch up to 3x before
// declaring it real.
const PROD = 'http://localhost:3334/plants';
const MOD  = 'http://localhost:3336/plants';
const q = encodeURIComponent;

// [label, tbf, taf, heavy] — heavy windows are skipped for raw-row routes
const WINDOWS = [
  ['Mon 1h',      '2026-07-06 10:00:00.000', '2026-07-06 11:00:00.000', false],
  ['Sun C->D 2h', '2026-07-05 17:00:00.000', '2026-07-05 19:00:00.000', false],
  ['recent 24h',  '2026-07-08 00:00:00.000', '2026-07-09 00:00:00.000', true],
];
const STD_PLANTS = ['BM2_con','BM2','CT6_con','CT6_heater','CT7_con','CT7_heater',
  'RRM','LC_CSH','Hour_OFIL','CSH','FeedRaw','HYD','RMM1','RMM2'];
const NOFILL_COUNTS = ['WL','Hour_OFIL','LC_CSH']; // default must equal prod byte-for-byte

const stats = { identical: 0, retried: 0, expected: 0, unexpected: 0 };
const unexpectedDetails = [];
const expectedNotes = [];

async function get(base, path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  return { status: res.status, text };
}

// Deterministic endpoints: single parallel fetch, byte-compare.
async function diffOnce(path, label) {
  const [p, m] = await Promise.all([get(PROD, path), get(MOD, path)]);
  if (p.status === m.status && p.text === m.text) { stats.identical++; return true; }
  // deliberate fix: BM2_con /avg 500s in production (TagIndex <> 'E' typo)
  if (/^\/BM2_con\/[^/]+\/.+\/avg$/.test(path) && p.status === 500 && m.status === 200) {
    stats.expected++;
    expectedNotes.push(`BM2_con /avg (${label}): prod 500 Server error -> fixed here, 200 with data`);
    console.log(`ok          ${label} (expected: prod 500 bug, fixed in this copy)`);
    return true;
  }
  stats.unexpected++;
  unexpectedDetails.push({ label, path, ps: p.status, ms: m.status, p: p.text.slice(0, 200), m: m.text.slice(0, 200) });
  console.log(`UNEXPECTED  ${label}  ${path}`);
  return false;
}

// Live endpoints: retry mismatches (a new sample can land between reads).
async function diffLive(path, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    const [p, m] = await Promise.all([get(PROD, path), get(MOD, path)]);
    if (p.status === m.status && p.text === m.text) {
      if (i > 1) { stats.retried++; console.log(`retried-ok  ${label} (attempt ${i})`); }
      else stats.identical++;
      return true;
    }
    if (i === tries) {
      stats.unexpected++;
      unexpectedDetails.push({ label, path, ps: p.status, ms: m.status, p: p.text.slice(0, 200), m: m.text.slice(0, 200) });
      console.log(`UNEXPECTED  ${label}  ${path} (persisted through ${tries} attempts)`);
      return false;
    }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function main() {
  const t0 = Date.now();

  // ---- 1. root "/": structural compare (doc text is an expected diff) ----
  {
    const [p, m] = await Promise.all([get(PROD, '/'), get(MOD, '/')]);
    let ok = p.status === 200 && m.status === 200;
    let docDiff = false;
    if (ok) {
      const pj = JSON.parse(p.text), mj = JSON.parse(m.text);
      const tagObjs = arr => Object.assign({}, ...arr.filter(o => o && o.tags !== undefined)
        .map(o => { const k = Object.keys(o).find(k => k !== 'tags'); return { [k]: o.tags }; }));
      const pt = tagObjs(pj), mt = tagObjs(mj);
      const keys = new Set([...Object.keys(pt), ...Object.keys(mt)]);
      for (const k of keys) if (JSON.stringify(pt[k]) !== JSON.stringify(mt[k])) ok = false;
      docDiff = p.text !== m.text;
    }
    if (ok) {
      if (docDiff) { stats.expected++; expectedNotes.push('root "/": doc text differs (port + new usage docs); all tag lists identical'); }
      else stats.identical++;
      console.log('ok          root "/" structural (tag lists identical; doc text = expected diff)');
    } else {
      stats.unexpected++;
      unexpectedDetails.push({ label: 'root /', path: '/', ps: p.status, ms: m.status, p: '', m: '' });
      console.log('UNEXPECTED  root "/" tag lists differ');
    }
  }

  // ---- 2. per-plant standard routes ----
  for (const plant of STD_PLANTS) {
    // tag list (live class, should be stable)
    await diffLive(`/${plant}`, `${plant} taglist`);

    // pick up to 3 tags for latest-value checks
    let tags = [];
    try { tags = JSON.parse((await get(PROD, `/${plant}`)).text); } catch {}
    const idxs = [...new Set([tags[0], tags[Math.floor(tags.length / 2)], tags[tags.length - 1]]
      .filter(Boolean).map(t => t.TagIndex))];

    await diffLive(`/${plant}/all`, `${plant} /all`);
    for (const ti of idxs) await diffLive(`/${plant}/${ti}`, `${plant} latest tag ${ti}`);

    for (const [wl, tbf, taf, heavy] of WINDOWS) {
      if (!heavy) await diffOnce(`/${plant}/0/${q(tbf)}/${q(taf)}`, `${plant} window ${wl}`);
      await diffOnce(`/${plant}/0/${q(tbf)}/${q(taf)}/avg`, `${plant} avg ${wl}`);
      if (plant === 'CT7_con') await diffOnce(`/${plant}/0/${q(tbf)}/${q(taf)}/calCap`, `${plant} calCap ${wl}`);
    }
    console.log(`done        ${plant} standard routes`);
  }

  // ---- 3. WL special routes ----
  await diffLive('/WL/all', 'WL /all');
  await diffLive('/WL/0', 'WL latest tag 0');
  for (const [wl, tbf, taf, heavy] of WINDOWS) {
    if (heavy) continue;
    for (const sub of ['ins', 'asc', 'datacal']) {
      await diffOnce(`/WL/0/${q(tbf)}/${q(taf)}/${sub}`, `WL /${sub} ${wl}`);
    }
    await diffOnce(`/WL/pivotData/${q(tbf)}/${q(taf)}`, `WL pivotData ${wl}`);
    await diffOnce(`/WL/pivotDataFilter/${q(tbf)}/${q(taf)}`, `WL pivotDataFilter ${wl}`);
  }
  console.log('done        WL special routes');

  // ---- 4. count routes ----
  for (const plant of [...STD_PLANTS, 'WL']) {
    for (const [wl, tbf, taf] of WINDOWS) {
      const base = `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`;
      // escape hatch must always be byte-identical
      await diffOnce(base + '&fillGaps=false', `count${plant} fillGaps=false ${wl}`);
      // excluded plants must be identical even by default
      if (NOFILL_COUNTS.includes(plant)) await diffOnce(base, `count${plant} default ${wl}`);
    }
    // expected diff: default is gap-filled for the other 12
    if (!NOFILL_COUNTS.includes(plant)) {
      const [, tbf, taf] = WINDOWS[0];
      const base = `/count${plant}?tagIndex=0&tbf=${q(tbf)}&taf=${q(taf)}&threshold=0`;
      const [p, m] = await Promise.all([get(PROD, base), get(MOD, base)]);
      const ph = JSON.parse(p.text).hour, mj = JSON.parse(m.text);
      stats.expected++;
      expectedNotes.push(`count${plant} default (Mon 1h): prod hour=${ph} -> filled hour=${mj.hour} (+${(mj.hour - ph).toFixed(4)}, ${mj.fillGaps.filledReadings} filled, ${mj.fillGaps.flaggedGaps.length} flagged)`);
    }
    console.log(`done        count${plant}`);
  }

  // ---- 5. threshold validation (expected behavior change) ----
  {
    const path = `/countBM2?tagIndex=0&tbf=${q(WINDOWS[0][1])}&taf=${q(WINDOWS[0][2])}`;
    const [p, m] = await Promise.all([get(PROD, path), get(MOD, path)]);
    if (m.status === 400) {
      stats.expected++;
      expectedNotes.push(`count* missing threshold: prod ${p.status} (silent count) -> mod 400 with error message`);
      console.log('ok          threshold validation (expected 400)');
    } else {
      stats.unexpected++;
      unexpectedDetails.push({ label: 'threshold 400', path, ps: p.status, ms: m.status, p: p.text.slice(0, 200), m: m.text.slice(0, 200) });
      console.log(`UNEXPECTED  missing threshold returned ${m.status}, wanted 400`);
    }
  }

  // ---- summary ----
  console.log('\n================ SUMMARY ================');
  console.log(`byte-identical:        ${stats.identical}`);
  console.log(`identical after retry: ${stats.retried} (live-data race)`);
  console.log(`expected diffs:        ${stats.expected}`);
  console.log(`UNEXPECTED diffs:      ${stats.unexpected}`);
  console.log('\nExpected (deliberate) differences:');
  for (const n of expectedNotes) console.log('  - ' + n);
  if (unexpectedDetails.length) {
    console.log('\nUNEXPECTED details:');
    for (const d of unexpectedDetails) {
      console.log(`  ${d.label}  ${d.path}\n    prod(${d.ps}): ${d.p}\n    mod (${d.ms}): ${d.m}`);
    }
  }
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(stats.unexpected === 0 ? 0 : 1);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
