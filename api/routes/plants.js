const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { findMax, findMin, calculateAverage, returnTagName, countValues } = require('../../utils');
const {dbConfig_PROD} = require('../../config');

sql.connect(dbConfig_PROD, (err) => {
    if (err) {
        console.log('Error connecting to the database: ',err);
        return;
    }
    console.log('Connected to the Database SSI-PC/PROD');
});

router.get('/', async (req, res) => {
  try {
    const tagBM2_con = await sql.query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [BallMill_Con_LOG].[dbo].[TagBallMill_Conveyor]`;
    const tagBM2 = await sql.query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [BallMill_Log].[dbo].[TagBallMill]`;
    const tagCT6_con = await sql.query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [Coating_MC6_Conveyor].[dbo].[TagCoating_MC6_Con]`;
    const tagCT6_heater = await sql.query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`;
    const tagCT7_con = await sql.query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`;
    const tagCT7_heater = await sql.query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [Coating_MC7_Log].[dbo].[TagCoating_MC7]`;
    const tagCSH = await sql.query`SELECT TagName.TagName, TagName.TagIndex FROM [Crushing_Log].[dbo].[TagName]`;
    const tagFeedRaw = await sql.query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [FeedRaw_Log].[dbo].[TagFeedRaw]`;
    const tagHYD = await sql.query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [Hydraulic_Log].[dbo].[TagHydraulic]`;
    const tagRMM1 = await sql.query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [RaymondMill_Log].[dbo].[TagRayMondMill]`;
    const tagRMM2 = await sql.query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [RaymondMill2_Log].[dbo].[TagRaymondMill2]`;

    res.json([
      {"message":"//how to use// {host}:3334/plants/{plant_id}/all,{tag_id}/{time_before}/{time_after}/avg  #example: http://172.30.1.112:3334/plants/BM2/1/2024-07-01%2000:00:00.000/2024-07-31%2000:00:00.000/avg or http://172.30.1.112:3334/plants/countRMM2?tagIndex=5&tbf=2024-08-01%2000:00:00.000&taf=2024-08-02%2000:00:00.000&threshold=1"},
      {"BM2_con":"BallMill2 Conveyor","tags":tagBM2_con.recordset},
      {"BM2":"BallMill2","tags":tagBM2.recordset},
      // {"BM1":"BallMill1","tags":tagCT6_con.recordset},
      {"CT6_con":"Coating6 Conveyor","tags":tagCT6_con.recordset},
      {"CT6_heater":"Coating6 Heater","tags":tagCT6_heater.recordset},
      {"CT7_con":"Coating7 Conveyor","tags":tagCT7_con}.recordset,
      {"CT7_heater":"Coating7 Heater","tags":tagCT7_heater.recordset},
      {"CSH":"Crushing","tags":tagCSH.recordset},
      {"FeedRaw":"FeedRaw Material VM/BM1/BM2","tags":tagFeedRaw.recordset},
      {"HYD":"Hydraulics Vertical Roller Mill","tags":tagHYD.recordset},
      {"RMM1":"Raymond Mill1","tags":tagRMM1.recordset},
      {"RMM2":"Raymond Mill2","tags":tagRMM2.recordset}]);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagBallMill_Conveyor.TagName, TagBallMill_Conveyor.TagIndex FROM [BallMill_Con_LOG].[dbo].[TagBallMill_Conveyor]`;
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
FROM [BallMill_Con_Log].[dbo].[FloatBallMill_Conveyor]
INNER JOIN BallMill_Con_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
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
  FROM [BallMill_Con_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN BallMill_Con_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
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
  FROM [BallMill_Con_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN BallMill_Con_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
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
  FROM [BallMill_Con_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN BallMill_Con_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
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
  FROM [BallMill_Con_Log].[dbo].[FloatBallMill_Conveyor]
  INNER JOIN BallMill_Con_LOG.dbo.TagBallMill_Conveyor ON FloatBallMill_Conveyor.TagIndex = TagBallMill_Conveyor.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatBallMill_Conveyor.TagIndex = ${tagIndex}
  ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/BM2', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagBallMill.TagName, TagBallMill.TagIndex FROM [BallMill_Log].[dbo].[TagBallMill]`;
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
FROM [BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
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
FROM [BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
and FloatBallMill.TagIndex = ${tagIndex}
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
FROM [BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
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
FROM [BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
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
FROM [BallMill_Log].[dbo].[FloatBallMill]
INNER JOIN BallMill_Log.dbo.TagBallMill ON FloatBallMill.TagIndex = TagBallMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatBallMill.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC6_Con.TagName, TagCoating_MC6_Con.TagIndex FROM [Coating_MC6_Conveyor].[dbo].[TagCoating_MC6_Con]`;
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
FROM [Coating_MC6_Conveyor].[dbo].[FloatCoating_MC6_Con]
INNER JOIN Coating_MC6_Conveyor.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
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
FROM [Coating_MC6_Conveyor].[dbo].[FloatCoating_MC6_Con]
INNER JOIN Coating_MC6_Conveyor.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Conveyor].[dbo].[FloatCoating_MC6_Con]
INNER JOIN Coating_MC6_Conveyor.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Conveyor].[dbo].[FloatCoating_MC6_Con]
INNER JOIN Coating_MC6_Conveyor.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Conveyor].[dbo].[FloatCoating_MC6_Con]
INNER JOIN Coating_MC6_Conveyor.dbo.TagCoating_MC6_Con ON FloatCoating_MC6_Con.TagIndex = TagCoating_MC6_Con.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Con.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT6_heater', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC6_Heater.TagName, TagCoating_MC6_Heater.TagIndex FROM [Coating_MC6_Heater_Log].[dbo].[TagCoating_MC6_Heater]`;
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
FROM [Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
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
FROM [Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
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
FROM [Coating_MC6_Heater_Log].[dbo].[FloatCoating_MC6_Heater]
INNER JOIN Coating_MC6_Heater_Log.dbo.TagCoating_MC6_Heater ON FloatCoating_MC6_Heater.TagIndex = TagCoating_MC6_Heater.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC6_Heater.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_con', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC7_Conveyor.TagName, TagCoating_MC7_Conveyor.TagIndex FROM [Coating_MC7_Conveyor_Log].[dbo].[TagCoating_MC7_Conveyor]`;
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
FROM [Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
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
FROM [Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
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
FROM [Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
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
FROM [Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
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

router.get('/countCT7_con', async (req, res) => {
  const {tagIndex,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatCoating_MC7_Conveyor.DateAndTime,FloatCoating_MC7_Conveyor.Val,FloatCoating_MC7_Conveyor.TagIndex ,TagCoating_MC7_Conveyor.TagName
FROM [Coating_MC7_Conveyor_Log].[dbo].[FloatCoating_MC7_Conveyor]
INNER JOIN Coating_MC7_Conveyor_Log.dbo.TagCoating_MC7_Conveyor ON FloatCoating_MC7_Conveyor.TagIndex = TagCoating_MC7_Conveyor.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7_Conveyor.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex, tagName: tagName,date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/CT7_heater', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagCoating_MC7.TagName, TagCoating_MC7.TagIndex FROM [Coating_MC7_Log].[dbo].[TagCoating_MC7]`;
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
FROM [Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
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
FROM [Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
and FloatCoating_MC7.TagIndex = ${tagIndex}
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
FROM [Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
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
FROM [Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
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
FROM [Coating_MC7_Log].[dbo].[FloatCoating_MC7]
INNER JOIN Coating_MC7_Log.dbo.TagCoating_MC7 ON FloatCoating_MC7.TagIndex = TagCoating_MC7.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatCoating_MC7.TagIndex = ${tagIndex}
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

router.get('/CSH', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagName.TagName, TagName.TagIndex FROM [Crushing_Log].[dbo].[TagName]`;
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
FROM [Crushing_Log].[dbo].[FloatValue]
INNER JOIN Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
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
FROM [Crushing_Log].[dbo].[FloatValue]
INNER JOIN Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
and FloatValue.TagIndex = ${tagIndex}
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
FROM [Crushing_Log].[dbo].[FloatValue]
INNER JOIN Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
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
FROM [Crushing_Log].[dbo].[FloatValue]
INNER JOIN Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
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
FROM [Crushing_Log].[dbo].[FloatValue]
INNER JOIN Crushing_Log.dbo.TagName ON FloatValue.TagIndex = TagName.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatValue.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/FeedRaw', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagFeedRaw.TagName, TagFeedRaw.TagIndex FROM [FeedRaw_Log].[dbo].[TagFeedRaw]`;
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
FROM [FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
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
FROM [FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
and FloatFeedRaw.TagIndex = ${tagIndex}
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
  FROM [FeedRaw_Log].[dbo].[FloatFeedRaw]
  INNER JOIN FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
  WHERE DateAndTime between ${tbf} and ${taf}
  and FloatFeedRaw.TagIndex = ${tagIndex}
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
FROM [FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatFeedRaw.TagIndex = ${tagIndex}
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
FROM [FeedRaw_Log].[dbo].[FloatFeedRaw]
INNER JOIN FeedRaw_Log.dbo.TagFeedRaw ON FloatFeedRaw.TagIndex = TagFeedRaw.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatFeedRaw.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName:tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/HYD', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagHydraulic.TagName, TagHydraulic.TagIndex FROM [Hydraulic_Log].[dbo].[TagHydraulic]`;
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
FROM [Hydraulic_Log].[dbo].[FloatValue]
INNER JOIN Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
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
FROM [Hydraulic_Log].[dbo].[FloatValue]
INNER JOIN Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
and FloatHydraulic.TagIndex = ${tagIndex}
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
FROM [Hydraulic_Log].[dbo].[FloatValue]
INNER JOIN Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
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
FROM [Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
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
FROM [Hydraulic_Log].[dbo].[FloatHydraulic]
INNER JOIN Hydraulic_Log.dbo.TagHydraulic ON FloatHydraulic.TagIndex = TagHydraulic.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatHydraulic.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM1', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagRayMondMill.TagName, TagRayMondMill.TagIndex FROM [RaymondMill_Log].[dbo].[TagRayMondMill]`;
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
FROM [RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
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
FROM [RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
and FloatRayMondMill.TagIndex = ${tagIndex}
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
FROM [RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
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
FROM [RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
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
FROM [RaymondMill_Log].[dbo].[FloatRayMondMill]
INNER JOIN RaymondMill_Log.dbo.TagRayMondMill ON FloatRayMondMill.TagIndex = TagRayMondMill.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRayMondMill.TagIndex = ${tagIndex}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue);
    const hour = count/360;
    const tagName = returnTagName(data);
    res.json({tagIndex: tagIndex,tagName: tagName, date_before:tbf, date_after:taf, count: count, hour: hour});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/RMM2', async (req, res) => {
  try {
    const result = await sql.query`SELECT TagRaymondMill2.TagName, TagRaymondMill2.TagIndex FROM [RaymondMill2_Log].[dbo].[TagRaymondMill2]`;
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
FROM [RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
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
FROM [RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
and FloatRaymondMill2.TagIndex = ${tagIndex}
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
FROM [RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
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
FROM [RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
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
FROM [RaymondMill2_Log].[dbo].[FloatRaymondMill2]
INNER JOIN RaymondMill2_Log.dbo.TagRaymondMill2 ON FloatRaymondMill2.TagIndex = TagRaymondMill2.TagIndex
WHERE DateAndTime between ${tbf} and ${taf}
and FloatRaymondMill2.TagIndex = ${tagIndex}
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

module.exports = router;