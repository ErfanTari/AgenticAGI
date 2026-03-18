import express from 'express';

const app = express();

app.get('/ok', (req, res) => {
  res.json({ ok: true });
});

export default app;