// /api/index.js
// Vercel serverless entry that proxies all /api/* requests to your Express app.

const app = require('../app'); // CommonJS import; app.js uses module.exports = app

module.exports = (req, res) => {
  // Let Express handle the request
  return app(req, res);
};
