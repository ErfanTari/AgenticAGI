import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ok', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});