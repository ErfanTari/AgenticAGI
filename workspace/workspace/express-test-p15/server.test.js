import assert from 'node:assert';
import http from 'node:http';
import { app } from './server.js';

const server = http.createServer(app);

await new Promise((resolve, reject) => {
  server.listen(0, () => {
    resolve();
  });
});

const port = server.address().port;

http.get(`http://localhost:${port}/ok`, (res) => {
  let data = '';
  
  res.on('data', chunk => {
    data += chunk;
  });
  
  res.on('end', () => {
    assert.strictEqual(res.statusCode, 200, 'Status should be 200');
    const json = JSON.parse(data);
    assert.deepStrictEqual(json, { ok: true }, 'Response should be {ok: true}');
    console.log('All tests passed!');
    server.close();
  });
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});