---
code: WHAT.KN-000022
nb: WHAT
type: KN
name: HackerNews API File Caching Method
handle: hackernews-api-file-caching-method
status: active
updated: 2026-04-11
summary: Describes the file-based caching strategy for the Node.js HackerNews API.
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

# HackerNews API File Caching Method

The caching mechanism for the HackerNews API uses the local file system to store and retrieve data, minimizing calls to the external HackerNews API.

**Process Flow:**
1.  **Request Received**: A request to the `/news` endpoint triggers the cache check.
2.  **Check Cache File**: The system checks for the existence and modification time of a `cache.json` file.
3.  **Cache Validation**: If the file exists and was modified less than 10 minutes ago, its contents are served directly.
4.  **Cache Invalidation/Miss**: If the file does not exist or is older than 10 minutes, it is considered stale. The system then proceeds to fetch fresh data from the HackerNews API.
5.  **Cache Refresh**: After fetching the top 5 headlines, the new data is written to `cache.json`, updating its content and modification timestamp.

This strategy ensures that the API is responsive and avoids rate-limiting by only fetching new data once every 10 minutes at most.
