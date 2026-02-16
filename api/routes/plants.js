const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { findMax, findMin, calculateAverage, returnTagName, countValues, calSum, calCap, countValuesHour, isHoliday } = require('../../utils');
const {dbConfig_PROD} = require('../../config');

sql.connect(dbConfig_PROD, (err) => {
    if (err) {
        console.log('Error connecting to the database: ',err);
        return;
    }
    console.log('Connected to the Database SSI-PC');
});

router.get('/', async (req, res) => {
  try {
    const tagBM2_con = await sql.query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [REPL_BallMill_Conveyor_LOG].[dbo].[TagBallMill_Conveyor]`;
    const tagBM2 = await sql.query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [REPL_BallMill_Log].[dbo].[TagBallMill]`;
    const tagCT6_con = await sql.query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con]`;
    const tagCT6_heater = await sql.query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`;
    const tagCT7_con = await sql.query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`;
    const tagCT7_heater = await sql.query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]`;
    const tagCSH = await sql.query`SELECT TagName.TagName, TagName.TagIndex FROM [REPL_Crushing_Log].[dbo].[TagName]`;
    const tagFeedRaw = await sql.query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw]`;
    const tagHYD = await sql.query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic]`;
    const tagRMM1 = await sql.query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill]`;
    const tagRMM2 = await sql.query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]`;
    const tagWL = await sql.query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_WL_LOG].[dbo].[TagTable]`;
    const tagRRM = await sql.query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_RingRollerMill].[dbo].[TagTable]`;

    res.json([
      {"message":["//how to use// {host}:3334/plants/{plant}/all,{tag_id}/{time_before}/{time_after}/avg",
                        "example : http://172.30.1.112:3334/plants/BM2/1/2024-07-01%2000:00:00.000/2024-07-31%2000:00:00.000/avg",
                        "example : http://172.30.1.112:3334/plants/countRMM2?tagIndex=5&tbf=2024-08-01%2000:00:00.000&taf=2024-08-02%2000:00:00.000&threshold=1"]},
      {"function_list":["/{plant}   ==get all tagIndex",
                        "/{plant}/{tag_id}    ==get lastest tagIndex data",
                        "/{plant}/all   ==query top 1000 in database",
                        "/{plant}/{tag_id}/{time_before}/{time_after}/avg   ==average data",
                        "/count{plant}?tagIndex={tag_no.}&tbf={time}&taf={time}&threshold={..}    ==count choosen tagdata between choosen time frame and filter with larger selected threshold"]},
      {"BM2_con":"BallMill2 Conveyor","tags":tagBM2_con.recordset},
      {"BM2":"BallMill2","tags":tagBM2.recordset},
      {"CT6_con":"Coating6 Conveyor","tags":tagCT6_con.recordset},
      {"CT6_heater":"Coating6 Heater","tags":tagCT6_heater.recordset},
      {"CT7_con":"Coating7 Conveyor","tags":tagCT7_con.recordset},
      {"CT7_heater":"Coating7 Heater","tags":tagCT7_heater.recordset},
      {"CSH":"Crushing","tags":tagCSH.recordset},
      {"FeedRaw":"FeedRaw Material VM/BM1/BM2","tags":tagFeedRaw.recordset},
      {"HYD":"Hydraulics Vertical Roller Mill","tags":tagHYD.recordset},
      {"RMM1":"Raymond Mill1","tags":tagRMM1.recordset},
      {"RMM2":"Raymond Mill2","tags":tagRMM2.recordset},
      {"WL_Weight":"Wheel Loader Weight","tags ([0]=id [1]=WL_no. [2]=Load [3]=Gross Weight)":tagWL.recordset},
      {"RRM":"RingRollerMill","tags":tagRRM.recordset}
    ]);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////

router.get('/BM2_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [REPL_BallMill_Conveyor_LOG].[dbo].[TagBallMill_Conveyor]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2_con/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
WHERE FloatBallMill_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
      SELECT TOP (1) FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
  FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  and FloatBallMill_Conveyor.Status <> 'E'
  ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/BM2_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
      SELECT FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
  FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  and FloatBallMill_Conveyor.Status <> 'E'
  ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/BM2_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
      SELECT FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
  FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  and FloatBallMill_Conveyor.TagIndex <> 'E'
  ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countBM2_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
      SELECT FloatBallMill_Conveyor.DateAndTime,FloatBallMill_Conveyor.Val,FloatBallMill_Conveyor.TagIndex ,TagBallMill_Conveyor.TagName
  FROM [REPL_BallMill_Conveyor_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN REPL_BallMill_Conveyor_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  and FloatBallMill_Conveyor.Status <> 'E'
  ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

///////////////////////////////////////////

router.get('/BM2', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [REPL_BallMill_Log].[dbo].[TagBallMill]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
and FloatBallMill.TagIndex = ${tagIndex}
WHERE FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/BM2/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
and FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/BM2/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
and FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countBM2', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatBallMill.DateAndTime,FloatBallMill.Val,FloatBallMill.TagIndex ,TagBallMill.TagName
FROM [REPL_BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN REPL_BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
and FloatBallMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////

router.get('/CT6_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[TagCoating_MC6_Con]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_con/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
and FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT6_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
and FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT6_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
and FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT6_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC6_Con.DateAndTime,FloatCoating_MC6_Con.Val,FloatCoating_MC6_Con.TagIndex ,TagCoating_MC6_Con.TagName
FROM [REPL_Coating_MC6_Conveyor_LOG].[dbo].[FloatCoating_MC6_Con]
INNER JOIN REPL_Coating_MC6_Conveyor_LOG.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
and FloatCoating_MC6_Con.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour,distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////////

router.get('/CT6_heater', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [REPL_Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_heater/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_heater/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
and FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT6_heater/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
and FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT6_heater/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
and FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT6_heater', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC6_Heater.DateAndTime,FloatCoating_MC6_Heater.Val,FloatCoating_MC6_Heater.TagIndex ,TagCoating_MC6_Heater.TagName
FROM [REPL_Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN REPL_Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
and FloatCoating_MC6_Heater.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////

router.get('/CT7_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE FloatCoating_MC7_Conveyor.Status <>'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT7_con/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <>'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT7_con/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con/:tagIndex/:tbf/:taf/calCap', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const capVal = calCap(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, cap: capVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT7_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [REPL_Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN REPL_Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
and FloatCoating_MC7_Conveyor.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex, tagName: tagName,date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

///////////////////////////////////////////////

router.get('/CT7_heater', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [REPL_Coating_MC7_Log].[dbo].[TagCoating_MC7]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_heater/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_heater/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
and FloatCoating_MC7.TagIndex = ${tagIndex}
and FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CT7_heater/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
and FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CT7_heater/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
and FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCT7_heater', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7.DateAndTime,FloatCoating_MC7.Val,FloatCoating_MC7.TagIndex ,TagCoating_MC7.TagName
FROM [REPL_Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN REPL_Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
and FloatCoating_MC7.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RRM', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagTable.TagName, TagTable.TagIndex FROM [REPL_RingRollerMill].[dbo].[TagTable]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RRM/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RRM/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RRM/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RRM/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRRM', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_RingRollerMill].[dbo].[FloatTable]
INNER JOIN REPL_RingRollerMill.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////////////

router.get('/CSH', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagName.TagName, TagName.TagIndex FROM [REPL_Crushing_Log].[dbo].[TagName]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CSH/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CSH/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
and FloatValue.TagIndex = ${tagIndex}
and FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/CSH/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
and FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/CSH/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
and FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countCSH', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatValue.DateAndTime,FloatValue.Val,FloatValue.TagIndex ,TagName.TagName
FROM [REPL_Crushing_Log].[dbo].[FloatValue]
INNER JOIN REPL_Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
and FloatValue.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//////////////////////////////////////////////

router.get('/FeedRaw', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [REPL_FeedRaw_Log].[dbo].[TagFeedRaw]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/FeedRaw/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/FeedRaw/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
and FloatFeedRaw.TagIndex = ${tagIndex}
and FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/FeedRaw/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
    SELECT FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
  FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
  INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatFeedRaw.TagIndex = ${tagIndex}
  and FloatFeedRaw.Status <> 'E'
  ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/FeedRaw/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatFeedRaw.TagIndex = ${tagIndex}
and FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countFeedRaw', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatFeedRaw.DateAndTime,FloatFeedRaw.Val,FloatFeedRaw.TagIndex ,TagFeedRaw.TagName
FROM [REPL_FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN REPL_FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatFeedRaw.TagIndex = ${tagIndex}
and FloatFeedRaw.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////

router.get('/HYD', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [REPL_Hydraulic_Log].[dbo].[TagHydraulic]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/HYD/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/HYD/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
and FloatHydraulic.TagIndex = ${tagIndex}
and FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/HYD/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
and FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/HYD/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
and FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countHYD', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatHydraulic.DateAndTime,FloatHydraulic.Val,FloatHydraulic.TagIndex ,TagHydraulic.TagName
FROM [REPL_Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN REPL_Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
and FloatHydraulic.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RMM1', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [REPL_RaymondMill_Log].[dbo].[TagRayMondMill]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM1/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM1/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
and FloatRayMondMill.TagIndex = ${tagIndex}
and FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RMM1/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
and FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RMM1/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
and FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRMM1', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatRayMondMill.DateAndTime,FloatRayMondMill.Val,FloatRayMondMill.TagIndex ,TagRayMondMill.TagName
FROM [REPL_RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN REPL_RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
and FloatRayMondMill.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

/////////////////////////////////////////

router.get('/RMM2', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [REPL_RaymondMill2_Log].[dbo].[TagRaymondMill2]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM2/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP(1000) FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM2/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
and FloatRaymondMill2.TagIndex = ${tagIndex}
and FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/RMM2/:tagIndex/:tbf/:taf', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
and FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/RMM2/:tagIndex/:tbf/:taf/avg', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
and FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val');
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countRMM2', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatRaymondMill2.DateAndTime,FloatRaymondMill2.Val,FloatRaymondMill2.TagIndex ,TagRaymondMill2.TagName
FROM [REPL_RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN REPL_RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
and FloatRaymondMill2.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    const distHour = countValuesHour(data, 'Val', ">", thresholdValue, {
  timeField: 'DateAndTime', // your timestamp field name
  isHoliday, // example: weekend as holiday
  pointsPerHour: 360,
  returnHours: true,
  tzOffsetMinutes: -420, // +7 hours (Asia/Bangkok)
});
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour, distHour: distHour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

////////////////////////////////////////////////////////////

router.get('/WL/pivotData/:tbf/:taf', async (req, res) => {
   const {tbf,taf} = req.params;
try {
  const result = await sql.query`
  SELECT FloatTable.DateAndTime,TagTable.TagName,FloatTable.Val 
FROM [REPL_WL_LOG].[dbo].[FloatTable]
INNER JOIN REPL_WL_LOG.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime ASC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/WL/all', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP(1000) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/WL/:tagIndex', async (req, res) => {
  const {tagIndex} = req.params;
  try {
    const result = await sql.query`
  SELECT TOP (1) FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/WL/:tagIndex/:tbf/:taf/ins', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/WL/:tagIndex/:tbf/:taf/asc', async (req, res) => {
    const {tagIndex,tbf,taf} = req.params;
    try {
      const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime ASC`;
      res.json(result.recordset);
    } catch (err) {
      console.error('Database query error:', err);
      res.status(500).send('Server error');
    }
  });

router.get('/WL/:tagIndex/:tbf/:taf/datacal', async (req, res) => {
  const {tagIndex,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
  const data = result.recordset;
  const tagName = returnTagName(data);
  const maxVal = findMax(data, 'Val');
  const minVal = findMin(data, 'Val');
  const avgVal = calculateAverage(data, 'Val')*2;
  const sumVal = calSum(data, 'Val');
  const count = countValues(data, 'Val', '!=', 0);
  res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, max: maxVal, min: minVal, sum: sumVal, avg: avgVal, count: count});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/countWL', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
FROM [REPL_WL_Log].[dbo].[FloatTable]
INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatTable.TagIndex = ${tagIndex}
and FloatTable.Status <> 'E'
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex, tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

// router.get('/WL/:tagIndex/:tbf/:taf/sum', async (req, res) => {
//   const {tagIndex,tbf,taf} = req.params;
//   try {
//     const result = await sql.query`
//   SELECT FloatTable.DateAndTime,FloatTable.Val,FloatTable.TagIndex ,TagTable.TagName
// FROM [REPL_WL_Log].[dbo].[FloatTable]
// INNER JOIN REPL_WL_Log.dbo.TagTable ON FloatTable.TagIndex = TagTable.TagIndex
// WHERE DateAndTime between ${tbf} and ${taf}
// and FloatTable.TagIndex = ${tagIndex}
// ORDER BY DateAndTime ASC`;
//     const data = result.recordset;
//     const maxVal = findMax(data, 'Val');
//     const minVal = findMin(data, 'Val');
//     const sumVal = calSum(data, 'Val');
//     res.json({meter: tag, date_before:tbf, date_after:taf, max: maxVal, min: minVal, sum: sumVal});
//   } catch (err) {
//     console.error('Database query error:', err);
//     res.status(500).send('Server error');
//   }
// });

router.get('/WL/pivotDataFilter/:tbf/:taf', async (req, res) => {
  const { tbf, taf } = req.params;

  // all filters passed as query params, NOT as route params
  const {
    silo,
    material,
    wlno,
    id,
    minWeight,
    maxWeight,
    minId,
    maxId
  } = req.query;

  try {
    const result = await sql.query`
      SELECT FloatTable.DateAndTime, TagTable.TagName, FloatTable.Val 
      FROM [REPL_WL_LOG].[dbo].[FloatTable]
      INNER JOIN REPL_WL_LOG.dbo.TagTable 
      ON FloatTable.TagIndex = TagTable.TagIndex
      WHERE DateAndTime BETWEEN ${tbf} AND ${taf}
      and FloatTable.Status <> 'E'
      ORDER BY DateAndTime ASC
    `;

    const rows = result.recordset;

    // 1) Group + pivot
    const grouped = {};

    rows.forEach(row => {
      if (row.Val === 0) return;

      const dtKey = row.DateAndTime.toISOString();

      if (!grouped[dtKey]) {
        grouped[dtKey] = {
          DateAndTime: row.DateAndTime,
          id: null,       // BRS_INT[14]
          WL_No: null,    // BRS_INT[08]
          Weight: null,   // BRS_REAL[26]
          Silo: null,     // BRS_DINT[3]
          Material: null  // BRS_DINT[4]
        };
      }

      switch (row.TagName) {
        case "[PLC_Crushing]BRS_DINT[3]":
          grouped[dtKey].Silo = row.Val;
          break;
        case "[PLC_Crushing]BRS_REAL[26]":
          grouped[dtKey].Weight = row.Val;
          break;
        case "[PLC_Crushing]BRS_DINT[4]":
          grouped[dtKey].Material = row.Val;
          break;
        case "[PLC_Crushing]BRS_INT[08]":
          grouped[dtKey].WL_No = row.Val;
          break;
        case "[PLC_Crushing]BRS_INT[14]":
          grouped[dtKey].id = row.Val;
          break;
      }
    });

    let data = Object.values(grouped);

    // 2) Apply filters in JS (no type conversion problems in SQL)
    if (silo)      data = data.filter(r => r.Silo === parseInt(silo, 10));
    if (material)  data = data.filter(r => r.Material === parseInt(material, 10));
    if (wlno)      data = data.filter(r => r.WL_No === parseInt(wlno, 10));
    if (id)        data = data.filter(r => r.id === parseInt(id, 10));
    if (minWeight) data = data.filter(r => r.Weight >= parseFloat(minWeight));
    if (maxWeight) data = data.filter(r => r.Weight <= parseFloat(maxWeight));
    if (minId)     data = data.filter(r => r.id >= parseInt(minId, 10));
    if (maxId)     data = data.filter(r => r.id <= parseInt(maxId, 10));

    // 3) Sort by time
    data.sort((a, b) => a.DateAndTime - b.DateAndTime);

    // 4) Summary
    const cycles = data.length;
    const totalWeight = data.reduce((sum, r) => sum + (r.Weight || 0), 0);
    const avgWeight = cycles > 0 ? totalWeight / cycles : 0;

    // 5) Format output
    const formattedData = data.map(r => ({
      DateAndTime: r.DateAndTime.toISOString(),
      id: r.id,
      WL_No: r.WL_No,
      Weight: Number(r.Weight?.toFixed(2) || 0),
      Silo: r.Silo,
      Material: r.Material
    }));

    res.json({
      tbf,
      taf,
      filters: req.query,
      summary: {
        cycles,
        totalWeight: Number(totalWeight.toFixed(2)),
        avgWeight: Number(avgWeight.toFixed(2))
      },
      data: formattedData
    });

  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;