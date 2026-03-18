import assert from 'node:assert';
import http from 'node:http';
import server from './server.js';

const testServer = server.listen(3001);

try {
  const response = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/ok', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  assert.deepStrictEqual(response, { ok: true }, 'GET /ok should return { ok: true }');
} finally {
  testServer.close();
}

console.log('All tests passed!');