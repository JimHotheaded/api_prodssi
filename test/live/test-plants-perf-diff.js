// Differential test for the 2026-07-20 plants.js performance rework
// (trimmed window/count fetches, SQL-side /avg + /calCap, parallel root).
//
// Byte-compares a candidate on :3336 against the running production server on
// :3334 across EVERY plant block, on fixed historical windows (closed days, so
// both sides read identical data). Needs the plant network and both servers up.
//
// Expected (whitelisted) diffs — everything else must be byte-identical:
//   - /avg's `avg` and /calCap's `cap`: SQL AVG/SUM can differ from the old JS
//     sum in the last decimals (float summation order). Compared with relative
//     tolerance 1e-9; every other field must match exactly.
const PROD = 'http://172.30.1.112:3334';
const CAND = 'http://localhost:3336';

const PLANTS = ['BM2_con', 'BM2', 'CT6_con', 'CT6_heater', 'CT7_con', 'CT7_heater',
  'RRM', 'LC_CSH', 'Hour_OFIL', 'CSH', 'FeedRaw', 'HYD', 'RMM1', 'RMM2'];

const DAY1 = ['2026-07-15%2000:00:00.000', '2026-07-16%2000:00:00.000'];   // 1-day window
const DAY7 = ['2026-07-12%2000:00:00.000', '2026-07-19%2000:00:00.000'];   // 7-day window
const EMPTY = ['1990-01-01%2000:00:00.000', '1990-01-02%2000:00:00.000'];  // no data

async function get(base, path) {
  const t0 = Date.now();
  const r = await fetch(base + path);
  const text = await r.text();
  return { status: r.status, text, ms: Date.now() - t0 };
}

let failed = 0, checks = 0;
function report(name, ok, extra) {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

async function byteEqual(path) {
  const [a, b] = await Promise.all([get(PROD, path), get(CAND, path)]);
  const ok = a.status === b.status && a.text === b.text;
  report(path, ok, `prod ${a.ms}ms | cand ${b.ms}ms | ${(a.text.length / 1024).toFixed(0)}KB` +
    (ok ? '' : ` | status ${a.status}/${b.status} len ${a.text.length}/${b.text.length}`));
  if (!ok && a.status === b.status && a.text.length === b.text.length) {
    for (let i = 0; i < a.text.length; i++) {
      if (a.text[i] !== b.text[i]) {
        console.log(`      first diff at ${i}: ...${a.text.slice(i - 40, i + 40)}... vs ...${b.text.slice(i - 40, i + 40)}...`);
        break;
      }
    }
  }
}

// avg/calCap: all fields exact except the float-summation field (rel 1e-9)
async function aggEqual(path, floatField) {
  const [a, b] = await Promise.all([get(PROD, path), get(CAND, path)]);
  if (a.status !== 200 || b.status !== 200) {
    return report(path, false, `status ${a.status}/${b.status}`);
  }
  const ja = JSON.parse(a.text), jb = JSON.parse(b.text);
  const keys = new Set([...Object.keys(ja), ...Object.keys(jb)]);
  let ok = true, why = '';
  for (const k of keys) {
    if (k === floatField) {
      const va = ja[k], vb = jb[k];
      const same = va === vb ||
        (typeof va === 'number' && typeof vb === 'number' &&
         Math.abs(va - vb) <= 1e-9 * Math.max(Math.abs(va), Math.abs(vb)));
      if (!same) { ok = false; why = `${k}: ${va} vs ${vb}`; }
    } else if (JSON.stringify(ja[k]) !== JSON.stringify(jb[k])) {
      ok = false; why = `${k}: ${JSON.stringify(ja[k])} vs ${JSON.stringify(jb[k])}`;
    }
  }
  const exact = a.text === b.text;
  report(path, ok, `prod ${a.ms}ms | cand ${b.ms}ms | ${exact ? 'byte-identical' : 'tolerated ' + floatField + ' diff'}${ok ? '' : ' | ' + why}`);
}

(async () => {
  // first tag of each plant (from production's own listing)
  const tag = {};
  for (const p of PLANTS) {
    const r = await get(PROD, `/plants/${p}`);
    tag[p] = JSON.parse(r.text)[0].TagIndex;
  }
  console.log('tag per plant:', PLANTS.map(p => `${p}=${tag[p]}`).join(' '), '\n');

  // warm the candidate's pool
  await get(CAND, '/plants/BM2');

  console.log('--- root listing ---');
  await byteEqual('/plants/');

  console.log('\n--- window routes (1-day fixed) ---');
  for (const p of PLANTS) {
    await byteEqual(`/plants/${p}/${tag[p]}/${DAY1[0]}/${DAY1[1]}`);
  }

  console.log('\n--- window + fillGaps=true (opt-in) ---');
  await byteEqual(`/plants/BM2/${tag.BM2}/${DAY1[0]}/${DAY1[1]}?fillGaps=true&cadence=10`);
  await byteEqual(`/plants/RMM1/${tag.RMM1}/${DAY1[0]}/${DAY1[1]}?fillGaps=true`);

  console.log('\n--- avg routes (7-day fixed; avg tolerated to 1e-9) ---');
  for (const p of PLANTS) {
    await aggEqual(`/plants/${p}/${tag[p]}/${DAY7[0]}/${DAY7[1]}/avg`, 'avg');
  }
  await aggEqual(`/plants/CT7_con/${tag.CT7_con}/${DAY7[0]}/${DAY7[1]}/calCap`, 'cap');

  console.log('\n--- count routes (7-day fixed, threshold=1) ---');
  for (const p of PLANTS) {
    await byteEqual(`/plants/count${p}?tagIndex=${tag[p]}&tbf=${DAY7[0]}&taf=${DAY7[1]}&threshold=1`);
  }
  await byteEqual(`/plants/countBM2?tagIndex=${tag.BM2}&tbf=${DAY7[0]}&taf=${DAY7[1]}&threshold=1&fillGaps=false`);
  // RMM1 era-split: window spanning the 10s->15s changeover (2026-07-09 09:18)
  await byteEqual(`/plants/countRMM1?tagIndex=${tag.RMM1}&tbf=2026-07-08%2000:00:00.000&taf=2026-07-10%2000:00:00.000&threshold=1`);

  console.log('\n--- edge cases ---');
  await byteEqual(`/plants/BM2/9999/${DAY1[0]}/${DAY1[1]}`);                 // unknown tag -> []
  await aggEqual(`/plants/BM2/${tag.BM2}/${EMPTY[0]}/${EMPTY[1]}/avg`, 'avg'); // empty window -> nulls
  await byteEqual(`/plants/countBM2?tagIndex=${tag.BM2}&tbf=${EMPTY[0]}&taf=${EMPTY[1]}&threshold=1`);
  await byteEqual(`/plants/countBM2?tagIndex=${tag.BM2}&tbf=${DAY1[0]}&taf=${DAY1[1]}`); // missing threshold -> 400

  console.log('\n--- untouched routes (WL, tag lists) ---');
  await byteEqual('/plants/WL');
  await byteEqual(`/plants/WL/pivotData/${DAY1[0]}/${DAY1[1]}`);
  await byteEqual(`/plants/countWL?tagIndex=2&tbf=${DAY1[0]}&taf=${DAY1[1]}&threshold=1`);
  await byteEqual('/plants/BM2');

  console.log(failed === 0
    ? `\nALL ${checks} LIVE CHECKS PASSED`
    : `\n${failed}/${checks} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
