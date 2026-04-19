const http = require('http');

// Simple test without external dependencies
function testOkEndpoint() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/ok',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok === true) {
            console.log('✓ Test PASSED: GET /ok returned {"ok":true}');
            resolve(true);
          } else {
            console.log('✗ Test FAILED: Response did not match expected');
            resolve(false);
          }
        } catch (e) {
          console.log('✗ Test FAILED: Invalid JSON response');
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.log('✗ Test FAILED: Could not connect to server');
      reject(e);
    });

    req.end();
  });
}

testOkEndpoint()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
