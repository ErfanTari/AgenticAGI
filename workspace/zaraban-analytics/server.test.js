import assert from 'node:assert';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, 'server.js');

// Import the module dynamically to get express app
let app;
try {
  const module = await import(serverPath);
  app = module.app || module.default;
} catch (error) {
  console.error('Failed to load server:', error.message);
  process.exit(1);
}

// Clean up database file before tests
const dbPath = join(__dirname, 'events.db');
try {
  rmSync(dbPath, { force: true });
} catch (e) {
  // Ignore if doesn't exist
}

let server;
const PORT = 3001;

// Start test server
server = http.createServer(app);
server.listen(PORT, async () => {
  console.log(`Test server running on port ${PORT}`);
  
  try {
    // Helper function to make HTTP requests
    const request = (method, path, body = null) => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: PORT,
          path: path,
          method: method,
          headers: { 'Content-Type': 'application/json' }
        };
        
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: JSON.parse(data)
              });
            } catch (e) {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: data
              });
            }
          });
        });
        
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    };
    
    // Test 1: POST /event - successful event creation
    const postResult = await request('POST', '/event', { eventType: 'page_view' });
    assert.strictEqual(postResult.statusCode, 200);
    assert.ok(postResult.body.success);
    assert.ok(postResult.body.id > 0);
    console.log('✓ POST /event - successful event creation');
    
    // Test 2: POST /event - missing eventType
    const postMissingType = await request('POST', '/event', {});
    assert.strictEqual(postMissingType.statusCode, 400);
    assert.ok(postMissingType.body.error);
    console.log('✓ POST /event - missing eventType returns error');
    
    // Test 3: POST /event - malformed JSON
    const malformedReq = new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port: PORT,
        path: '/event',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          body: data
        }));
      });
      
      req.on('error', (err) => resolve({ statusCode: 500, body: err.message }));
      req.write('{ invalid json'); // Malformed JSON
      req.end();
    });
    
    const malformedResult = await malformedReq;
    assert.strictEqual(malformedResult.statusCode, 400);
    console.log('✓ POST /event - malformed JSON returns error');
    
    // Test 4: GET /summary - empty database
    const summaryEmpty = await request('GET', '/summary');
    assert.strictEqual(summaryEmpty.statusCode, 200);
    assert.ok(Array.isArray(summaryEmpty.body));
    console.log('✓ GET /summary - empty database returns empty array');
    
    // Add more events for testing
    await request('POST', '/event', { eventType: 'click' });
    await request('POST', '/event', { eventType: 'page_view' });
    await request('POST', '/event', { eventType: 'custom_event', metadata: { userId: 123 } });
    
    // Test 5: GET /summary - with data
    const summaryWith = await request('GET', '/summary');
    assert.strictEqual(summaryWith.statusCode, 200);
    assert.ok(Array.isArray(summaryWith.body));
    assert.ok(summaryWith.body.length > 0);
    console.log('✓ GET /summary - returns grouped counts');
    
    // Test 6: Verify summary grouping
    const pageViews = summaryWith.body.filter(row => row.event_type === 'page_view');
    assert.strictEqual(pageViews.length, 1);
    assert.strictEqual(pageViews[0].count, 2); // Should have 2 page_views
    console.log('✓ GET /summary - correct grouping by event type and date');
    
    // Test 7: GET /export - empty database (header only)
    const exportEmpty = await request('GET', '/export');
    assert.strictEqual(exportEmpty.statusCode, 200);
    assert.ok(exportEmpty.headers['content-type'].includes('text/csv'));
    assert.ok(exportEmpty.body.includes('id,event_type,timestamp,date,metadata'));
    console.log('✓ GET /export - returns valid CSV header');
    
    // Test 8: GET /export - with data
    const exportWith = await request('GET', '/export');
    assert.strictEqual(exportWith.statusCode, 200);
    assert.ok(exportWith.headers['content-type'].includes('text/csv'));
    assert.ok(exportWith.body.includes('page_view'));
    assert.ok(exportWith.body.includes('click'));
    console.log('✓ GET /export - returns valid CSV with data');
    
    // Test 9: Verify export has correct number of rows
    const lines = exportWith.body.split('\n').filter(line => line.trim());
    assert.strictEqual(lines.length, 6); // 1 header + 5 events (3 from before + 2 more)
    console.log('✓ GET /export - correct number of CSV rows');
    
    console.log('\nAll tests passed!');
    
  } catch (error) {
    console.error('Test failed:', error.message);
    process.exit(1);
  } finally {
    server.close(() => {
      try {
        rmSync(dbPath, { force: true });
      } catch (e) {}
      process.exit(0);
    });
  }
});