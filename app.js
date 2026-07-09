const express = require('express');
const app = express();

const plantRoutes = require('./api/routes/plants');
app.use('/plants', plantRoutes);

module.exports = app;
