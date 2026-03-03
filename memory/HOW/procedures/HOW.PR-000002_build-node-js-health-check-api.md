---
code: HOW.PR-000002
nb: HOW
type: PR
name: Build Node.js Health Check API
status: active
updated: 2026-02-26
summary: Create a simple Node.js REST API with /health endpoint
---

# Build Node.js Health Check API

```json
{
  "steps": [
    {
      "step": "Install dependencies",
      "cmd": "npm init -y && npm install express"
    },
    {
      "step": "Create server file (server.js)",
      "code": "const express = require('express');\nconst app = express();\nconst PORT = 3000;\n\napp.get('/health', (req, res) => {\n  res.json({ status: 'ok' });\n});\n\napp.listen(PORT, () => {\n  console.log(`Server running on http://localhost:${PORT}`);\n});"
    },
    {
      "step": "Run server in background",
      "cmd": "node server.js &"
    },
    {
      "step": "Test endpoint",
      "cmd": "curl -X GET http://localhost:3000/health || fetch('http://localhost:3000/health')"
    },
    {
      "step": "Kill server",
      "cmd": "ps aux | grep 'node server.js' | awk '{print $2}' | xargs kill -9"
    },
    {
      "step": "Verify cleanup",
      "cmd": "ps aux | grep 'node server.js'"
    }
  ],
  "verification": {
    "expected_response": "{\"status":\"ok\"}",
    "http_status": 200
  },
  "common_issues": [
    {"error": "Port in use", "solution": "Change PORT variable or kill existing process"},
    {"error": "Missing dependencies", "solution": "Run npm install first"}
  ]
}
```
