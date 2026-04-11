---
code: PLAN.EX-000105
nb: PLAN
type: EX
name: Cache Logic Test Specification
handle: cache-logic-spec
status: active
updated: 2026-04-11
summary: Specification for testing the file-based caching logic.
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-11
pinned: 0
source: agent
---

# Cache Logic Test Specification

Write a Node.js test script `cache.test.js` using the built-in `node:assert` module.

The script should test the caching functions which will need to be exported from `server.js`. The tests should cover three scenarios:

1.  **No Cache Exists**: The test should confirm that when no `cache.json` is present, the logic proceeds to fetch fresh data.
2.  **Valid Cache Exists**: The test should create a `cache.json` file with a recent timestamp, and confirm that the logic reads from this cache file instead of fetching new data.
3.  **Expired Cache Exists**: The test should create a `cache.json` file with a timestamp older than 10 minutes, and confirm that the logic ignores the cache and fetches fresh data.

Mock the `fs` calls to control file existence and stats. The test file should use ES Modules (`import`/`export`).
