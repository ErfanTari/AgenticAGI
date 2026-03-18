import assert from 'node:assert';
import http from 'node:http';
import app from './server.js';

const server = app.listen(3001);

try {
  const res = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/ok', (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  assert.deepStrictEqual(res, { ok: true }, 'GET /ok should return { ok: true }');
  console.log('All tests passed!');
} finally {
  server.close();
}