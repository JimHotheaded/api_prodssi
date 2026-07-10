const express = require('express');
const app = express();

const plantRoutes = require('./api/routes/plants');
const alarmRoutes = require('./api/alarms');
app.use('/plants', plantRoutes);
app.use('/api/alm', alarmRoutes);

module.exports = app;
