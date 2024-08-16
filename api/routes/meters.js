const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { findMax, findMin, calculateAverage, countValues} = require('../../utils');
const dbConfig_CENTER =   require('../../config');

sql.connect(dbConfig_CENTER, (err) => {
    if (err) {
        console.log('Error connecting to the database: ',err);
        return;
    }
    console.log('Connected to the Database CENTER');
});

router.get('/', async (req, res) => {
  try {
    res.json([{"message":"//how to use// {host}:3333/meters/name,data/{tag_id}/{time_before}/{time_after}/sum,avg #example:http://172.30.1.112:3333/meters/data/kWhCSH/2024-07-01%2000:00:00.000/2024-07-31%2000:00:00.000/sum or http://172.30.1.112:3333/meters/count?tag=kWCSH&tbf=2024-07-01%2000:00:00.000&taf=2024-07-31%2000:00:00.000&threshold=10"},
      {"function_list":["/name    ==show all meter parameters.",
        "/data    ==>query top 1000 data in database.",
        "/data/{tag_id}/{time_before}/{time_after}    ==query choosen meter parameter data in choosen timeframe.",
        "/data/{tag_id}/{time_before}/{time_after}/sum    ==sum choosen meter paremeter data in choosen timeframe.//for Energy Consumption Report",
        "/data/{tag_id}/{time_before}/{time_after}/avg    ==average choosen meter parameter data in choosen timeframe.",
        "/count?tag={tagName}&tbf={time}&taf={time}&threshold={..}    ==count choosen tagdata between choosen time frame and filter with larger selected threshold"
      ]}
]);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/name', async (req, res) => {
  try {
    const result = await sql.query`SELECT * FROM [Power_Meter_Log].[dbo].[TagPower_Meter]`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/data', async (req, res) => {
  try {
    const result = await sql.query`
  SELECT TOP (1000) FloatPower_Meter.DateAndTime,FloatPower_Meter.Val,TagPower_Meter.TagName
FROM [Power_Meter_Log].[dbo].[FloatPower_Meter]
INNER JOIN Power_Meter_Log.dbo.TagPower_Meter ON FloatPower_Meter.TagIndex = TagPower_Meter.TagIndex
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

//tbf=time before, taf=time after
router.get('/data/:tag/:tbf/:taf', async (req, res) => {
  const {tag,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatPower_Meter.DateAndTime,FloatPower_Meter.Val,TagPower_Meter.TagName
FROM [Power_Meter_Log].[dbo].[FloatPower_Meter]
INNER JOIN Power_Meter_Log.dbo.TagPower_Meter ON FloatPower_Meter.TagIndex = TagPower_Meter.TagIndex
WHERE DateAndTime between ${tbf} and ${taf} and TagName= ${tag}
ORDER BY DateAndTime DESC`;
    res.json(result.recordset);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/data/:tag/:tbf/:taf/sum', async (req, res) => {
  const {tag,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatPower_Meter.DateAndTime,FloatPower_Meter.Val,TagPower_Meter.TagName
FROM [Power_Meter_Log].[dbo].[FloatPower_Meter]
INNER JOIN Power_Meter_Log.dbo.TagPower_Meter ON FloatPower_Meter.TagIndex = TagPower_Meter.TagIndex
WHERE DateAndTime between ${tbf} and ${taf} and TagName= ${tag}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const maxVal = findMax(data, 'Val');
    const minVal = findMin(data, 'Val');
    const sumVal = maxVal - minVal;
    res.json({meter: tag, date_before:tbf, date_after:taf, max: maxVal, min: minVal, sum: sumVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/data/:tag/:tbf/:taf/avg', async (req, res) => {
  const {tag,tbf,taf} = req.params;
  try {
    const result = await sql.query`
  SELECT FloatPower_Meter.DateAndTime,FloatPower_Meter.Val,TagPower_Meter.TagName
FROM [Power_Meter_Log].[dbo].[FloatPower_Meter]
INNER JOIN Power_Meter_Log.dbo.TagPower_Meter ON FloatPower_Meter.TagIndex = TagPower_Meter.TagIndex
WHERE DateAndTime between ${tbf} and ${taf} and TagName= ${tag}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const maxVal = findMax(data, 'Val');
    const minVal = findMin(data, 'Val');
    const avgVal = calculateAverage(data, 'Val');
    res.json({meter: tag, date_before:tbf, date_after:taf, max: maxVal, min: minVal, avg: avgVal});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

router.get('/count', async (req, res) => {
  const {tag,tbf,taf,threshold} = req.query;
  const thresholdValue = Number(threshold);
  try {
    const result = await sql.query`
  SELECT FloatPower_Meter.DateAndTime,FloatPower_Meter.Val,TagPower_Meter.TagName
FROM [Power_Meter_Log].[dbo].[FloatPower_Meter]
INNER JOIN Power_Meter_Log.dbo.TagPower_Meter ON FloatPower_Meter.TagIndex = TagPower_Meter.TagIndex
WHERE DateAndTime between ${tbf} and ${taf} and TagName= ${tag}
ORDER BY DateAndTime DESC`;
    const data = result.recordset;
    const count = countValues(data, 'Val', '>', thresholdValue)
    res.json({meter: tag, date_before:tbf, date_after:taf, count: count});
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;