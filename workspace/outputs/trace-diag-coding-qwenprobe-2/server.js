// server.js - Node.js Express server with GET /ok endpoint

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// GET /ok endpoint returning JSON {"ok":true}
app.get('/ok', (req, res) => {
  res.json({ ok: true });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});