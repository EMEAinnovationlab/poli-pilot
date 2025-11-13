// Serverless adapter that forwards to the Express app exported by app.js
const app = require('../app');
module.exports = (req, res) => app(req, res);
