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
 * from the table pass through untouched, which is every plant but RRM, OFIL,
 * CSH and Silo today.
 *
 * A plant's map need not cover every tag: CSH maps only 3 of its 21, and the
 * unmapped ones fall back to the historian's own name at divisor 1, exactly as
 * if the plant were absent from the table.
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
  // OFIL drive output frequencies. The tag table holds the raw Logix paths
  // ("::[PLC_Ofil]OFIL_SILO4:I.OutputFreq") and the drives publish OutputFreq
  // in hundredths of a Hz (a 30.00 Hz setpoint is stored as 3000), so every tag
  // here divides by 100.
  OFIL: {
    0: { name: 'SILO4_OutputFreq',          divisor: 100 },
    1: { name: 'Rotary_Screen2_OutputFreq', divisor: 100 },
    2: { name: 'Rotary_Screen3_OutputFreq', divisor: 100 },
    3: { name: 'Rotary_Screen4_OutputFreq', divisor: 100 },
    4: { name: 'Rotary_Screen5_OutputFreq', divisor: 100 },
  },
  // Crushing. A PARTIAL block: only these three tags are mapped — tags 0-7 and
  // 9-18 are deliberately absent and pass through with their raw historian name
  // and raw value, exactly as before this block existed.
  //
  // Both OutputFreq tags come off [PLC_Crushing] drives that publish frequency
  // in hundredths of a Hz (3300 = 33.00 Hz, 5000 = 50.00 Hz at the VFD max), the
  // same encoding as every OFIL tag. Verified against the value distribution
  // rather than assumed: the steady readings are all round hundreds
  // (0/2200/2600/3300/4000/5000) with only rare intermediate ramp samples.
  //
  // NOTE tag 8 was served RAW from 2025-09-02 until 2026-09-01, so scaling it is
  // a breaking wire-format change for anything already dividing it downstream
  // (~3M rows of history). Chosen deliberately so both CSH frequency tags read
  // in the same units. Tags 19/20 were added 2026-08-31 and had no consumers.
  CSH: {
    8:  { name: 'Grizzly_Hz',   divisor: 100 },
    19: { name: 'Screen_Hz',    divisor: 100 },
    // Loadcell real, already in engineering units — rename only. Its sibling
    // BRS_REAL[01] (the whole of LC_CSH) spans -1206..25494, a different scale
    // entirely, so don't infer a shared divisor from the shared BRS_REAL name.
    20: { name: 'Hopper_level', divisor: 1 },
  },
  // Silo levels and weights, gathered from four PLCs into one database. This is
  // a RENAME-ONLY block — every divisor is 1, because these tags are already
  // logged as real floats in engineering units. It exists because the raw
  // historian names are actively misleading about which silo they describe:
  // "RaymondMill\Weight_Silo3" is silo 41, "Coating7_Con\Net_Weight" is silo 1,
  // and TONSILOCSH[0..3] are silos 1..4 (offset by one). Names supplied by the
  // plant 2026-08-14; the DB is untouched.
  //
  // NOTE the units are mixed and are NOT harmonised here: SILO1/3/43/44_WEIGHT
  // read in the tens of thousands (kg) while every other *_WEIGHT reads in the
  // tens or low hundreds (tonnes). Adding divisors is a separate, deliberate
  // decision — don't infer one from the shared "_WEIGHT" suffix.
  Silo: {
    0:  { name: 'SILO31_LEVEL',    divisor: 1 },
    1:  { name: 'SILO31_WEIGHT',   divisor: 1 },
    2:  { name: 'SILO32_LEVEL',    divisor: 1 },
    3:  { name: 'SILO32_WEIGHT',   divisor: 1 },
    4:  { name: 'SILO33_LEVEL',    divisor: 1 },
    5:  { name: 'SILO33_WEIGHT',   divisor: 1 },
    6:  { name: 'SILO34_LEVEL',    divisor: 1 },
    7:  { name: 'SILO34_WEIGHT',   divisor: 1 },
    8:  { name: 'SILO35_LEVEL',    divisor: 1 },
    9:  { name: 'SILO35_WEIGHT',   divisor: 1 },
    10: { name: 'SILO36_LEVEL',    divisor: 1 },
    11: { name: 'SILO36_WEIGHT',   divisor: 1 },
    // Per-minute production delta, not a stock level — negative means drawdown.
    12: { name: 'CAP_SILO3_1_min', divisor: 1 },
    13: { name: 'SILO9_WEIGHT',    divisor: 1 },
    14: { name: 'SILO10_WEIGHT',   divisor: 1 },
    15: { name: 'SILO9_LEVEL',     divisor: 1 },
    16: { name: 'SILO10_LEVEL',    divisor: 1 },
    17: { name: 'SILO0CSH_WEIGHT', divisor: 1 },
    18: { name: 'SILO1CSH_WEIGHT', divisor: 1 },
    19: { name: 'SILO2CSH_WEIGHT', divisor: 1 },
    20: { name: 'SILO3CSH_WEIGHT', divisor: 1 },
    21: { name: 'SILO4CSH_WEIGHT', divisor: 1 },
    22: { name: 'SILO43_WEIGHT',   divisor: 1 },
    23: { name: 'SILO44_WEIGHT',   divisor: 1 },
    24: { name: 'SILO1_WEIGHT',    divisor: 1 },
    25: { name: 'SILO3_WEIGHT',    divisor: 1 },
    26: { name: 'SILO41_WEIGHT',   divisor: 1 },
    27: { name: 'SILO42_WEIGHT',   divisor: 1 },
    // Added to the historian 2026-08-31 15:32:34, off a fifth PLC (SILO1_2).
    // Level only — no matching weight tags exist. These raw names already
    // identify their silo correctly (unlike tags 24-27); they are renamed only
    // to keep the "_LEVEL" spelling uniform across the plant.
    28: { name: 'SILO21_LEVEL',    divisor: 1 },
    29: { name: 'SILO22_LEVEL',    divisor: 1 },
    30: { name: 'SILO23_LEVEL',    divisor: 1 },
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
