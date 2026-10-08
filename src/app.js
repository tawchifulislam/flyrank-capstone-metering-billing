const express = require('express');
const tenantRoutes = require('./routes/tenants');
const generateRoutes = require('./routes/generate');
const billingRoutes = require('./routes/billing');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/tenants', tenantRoutes);
app.use('/generate', generateRoutes);
app.use('/billing', billingRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
