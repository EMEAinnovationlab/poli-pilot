// /api/index.js
// Thin wrapper that hands every routed request to your Express app.

const app = require('../app'); // app.js exports the Express instance

module.exports = (req, res) => {
  // Ensure Express sees the original URL path Vercel matched
  // (Vercel already sets req.url appropriately for this handler)
  return app(req, res);
};
