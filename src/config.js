require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3001',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    priceIdPro: process.env.STRIPE_PRICE_ID_PRO,
  },
  pricing: {
    apiCallMicros: 1000,
    inputPerMillionMicros: 300000,
    cachedInputPerMillionMicros: 75000,
    outputPerMillionMicros: 2500000,
  },
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

module.exports = config;
