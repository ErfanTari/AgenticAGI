---
code: HOW.PR-000015
nb: HOW
type: PR
name: Node.js REST API Health Check Setup
status: active
updated: 2026-02-26
summary: Build, run, test, and document a simple Node.js REST API with GET /health endpoint.
---

# Node.js REST API Health Check Setup

# Node.js REST API Health Check Setup

## Objective
Create a minimal Node.js REST API with a single health check endpoint.

## Steps
1. **Initialize Project**
   ```bash
   mkdir node-health-api && cd node-health-api
   npm init -y
   npm install express
   ```

2. **Create Server File (server.js)**
   ```javascript
   const express = require('express');
   const app = express();
   const PORT = 3000;

   app.get('/health', (req, res) => {
     res.json({ status: 'ok' });
   });

   app.listen(PORT, () => {
     console.log(`Server running on http://localhost:${PORT}`);
   });
   ```

3. **Run in Background**
   ```bash
   node server.js &
   ```

4. **Test Endpoint**
   ```bash
   curl http://localhost:3000/health
   # Expected output: {"status":"ok"}
   ```

5. **Kill Server**
   ```bash
   pkill -f "node server.js"
   ```

6. **Fix Issues (if any)**
   - Ensure Express is installed correctly.
   - Verify port availability.
   - Check for syntax errors in server.js.

7. **Documentation**
   Save this procedure as a HOW entry for future reference.
