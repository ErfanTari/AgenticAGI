import express from 'express';

export const app = express();

app.get('/ok', (req, res) => {
  res.json({ ok: true });
});