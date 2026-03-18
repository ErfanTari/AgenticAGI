---
code: HOW.PR-000048
nb: HOW
type: PR
name: Implementation: express-test-p15/server.js
status: active
updated: 2026-03-17
summary: Working express-test-p15/server.js implementation, tests passed on attempt 2
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-03-17
pinned: 0
source: agent
---

# Implementation: express-test-p15/server.js

## Working Solution

Tests passed on attempt 2.

### Code
```javascript
import express from 'express';

const app = express();

app.get('/ok', (req, res) => {
  res.json({ ok: true });
});

export default app;
```

### Test Output
```
All tests passed!
```
