const express = require('express');
const app = express();

const plantRoutes = require('./api/routes/plants');
app.use('/plants', plantRoutes);

// const meterRoutes = require('./api/routes/meters');
// app.use('/meters', meterRoutes);

module.exports = app;
