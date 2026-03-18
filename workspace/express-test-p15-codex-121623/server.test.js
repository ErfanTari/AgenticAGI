import assert from 'node:assert';
import http from 'http';
import { app } from './server.js';

const server = http.createServer(app);

// Start the server before making requests
server.listen(0, () => {
  const port = server.address().port;
  
  // Test GET /ok returns status 200 and body {ok:true}
  http.get(`http://localhost:${port}/ok`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      assert.strictEqual(res.statusCode, 200, 'Status should be 200');
      const body = JSON.parse(data);
      assert.deepStrictEqual(body, { ok: true }, 'Body should be {ok:true}');
      server.close();
      console.log('All tests passed!');
    });
  }).on('error', (err) => {
    server.close();
    throw err;
  });
});