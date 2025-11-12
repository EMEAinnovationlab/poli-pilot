// /api/index.js
// Minimal Vercel serverless wrapper for your Express app
const app = require('../app');

// Vercel Node functions can call an Express app as a request handler.
module.exports = (req, res) => {
  // Ensure proxies (X-Forwarded-For etc.) are available if you ever use them.
  req.headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers['host'];
  return app(req, res);
};
