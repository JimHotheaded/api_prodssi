/*
 * Presentation layer for historian tags: friendly names and engineering units.
 *
 * The `REPL_*` databases store OPC tag names verbatim
 * ("SiemensOPC.RingRollerMill.M208_Current") and raw scaled integers — the PLC
 * publishes current as tenths of an amp, and the RRM belt feeder as hundredths.
 * The historian is the system of record and this API is read-only against it,
 * so the rename and the unit conversion happen here, on the way out.
 *
 * Keyed by plant so another machine can be added later without touching the
 * routes. **Adding a plant here changes that plant's wire format** (TagName and
 * Val), so treat it like any other downstream-visible change. Plants absent
 * from the table pass through untouched, which is every plant but RRM today.
 *
 * Scaling divides without rounding — precision is preserved and the values stay
 * exactly raw/divisor (137 -> 1.37, an average of 142.65 -> 1.4265).
 */

const TAG_DISPLAY = {
  RRM: {
    0:  { name: 'M201B_RB_CurrentDisplay',  divisor: 10 },
    1:  { name: 'M203_Classifier_Current',  divisor: 10 },
    2:  { name: 'M203_Classifier_ReadFreq', divisor: 10 },
    3:  { name: 'M204_Blower_Current',      divisor: 10 },
    4:  { name: 'M204_Blower_ReadFreq',     divisor: 10 },
    5:  { name: 'M205_Host_Current',        divisor: 10 },
    6:  { name: 'M205_Host_Temp',           divisor: 10 },
    7:  { name: 'M208_Feeder_Current',      divisor: 100 },
    8:  { name: 'M208_Feeder_ReadFreq',     divisor: 10 },
    // Raw Siemens analog output word (QW), not a scaled measurement — passed
    // through unconverted. The damper's engineering value is tag 10.
    9:  { name: 'V204_Damper_Out_QW',       divisor: 1 },
    10: { name: 'V204_Damper%',             divisor: 10 },
  },
};

// tagIndex reaches the routes as a string (req.params / req.query) and comes
// back from the driver as a number; normalise both to look the entry up.
function entryFor(plant, tagIndex) {
  const byIndex = TAG_DISPLAY[plant];
  if (!byIndex) return null;
  return byIndex[Number(tagIndex)] || null;
}

// Falls back to whatever the tag table holds, so a tag missing from the map
// (or an unknown index) behaves exactly as it did before this layer existed.
function displayName(plant, tagIndex, dbName) {
  const e = entryFor(plant, tagIndex);
  return e ? e.name : dbName;
}

function divisorFor(plant, tagIndex) {
  const e = entryFor(plant, tagIndex);
  return e ? e.divisor : 1;
}

function scaleValue(plant, tagIndex, val) {
  if (val === null || val === undefined) return val;
  const d = divisorFor(plant, tagIndex);
  return d === 1 ? val : val / d;
}

/**
 * Rename and scale an array of reading rows. Each row is converted against its
 * OWN TagIndex, because /{plant}/all returns every tag interleaved. Key order
 * is preserved so the wire format is otherwise byte-identical.
 */
function presentRows(plant, rows) {
  if (!TAG_DISPLAY[plant] || !Array.isArray(rows)) return rows;
  return rows.map(r => {
    const out = { ...r };
    if ('Val' in out) out.Val = scaleValue(plant, r.TagIndex, r.Val);
    if ('TagName' in out) out.TagName = displayName(plant, r.TagIndex, r.TagName);
    return out;
  });
}

/** Rename a {TagName, TagIndex} tag-list recordset (the /{plant} route). */
function presentTagList(plant, rows) {
  if (!TAG_DISPLAY[plant] || !Array.isArray(rows)) return rows;
  return rows.map(r => ({ ...r, TagName: displayName(plant, r.TagIndex, r.TagName) }));
}

/**
 * Window-route response: with ?fillGaps=true applyFillGaps returns an object
 * wrapping `readings`, otherwise the bare row array. Scale whichever it is —
 * always AFTER the fill, so gap detection still runs on raw values and the
 * synthetic rows it produces get scaled along with the real ones.
 */
function presentWindow(plant, payload) {
  if (!TAG_DISPLAY[plant]) return payload;
  if (Array.isArray(payload)) return presentRows(plant, payload);
  if (payload && Array.isArray(payload.readings)) {
    return { ...payload, readings: presentRows(plant, payload.readings) };
  }
  return payload;
}

module.exports = {
  TAG_DISPLAY,
  displayName,
  divisorFor,
  scaleValue,
  presentRows,
  presentTagList,
  presentWindow,
};
