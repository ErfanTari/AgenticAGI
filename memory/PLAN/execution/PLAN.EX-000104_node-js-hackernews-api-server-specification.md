---
code: PLAN.EX-000104
nb: PLAN
type: EX
name: Node.js HackerNews API Server Specification
handle: node-js-spec
status: active
updated: 2026-04-11
summary: Specification for a Node.js server that fetches, caches, and serves HackerNews top headlines.
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

# Node.js HackerNews API Server Specification

Create a Node.js application using Express.js that exposes a single GET /news endpoint.

1.  **Dependencies**: Use the native 'fs' and 'path' modules for file operations. Use Express for the web server.
2.  **Caching Logic**:
    -   Define a cache file path, e.g., 'cache.json'.
    -   Define a cache duration of 10 minutes (600,000 milliseconds).
    -   When a request comes to /news, check if 'cache.json' exists.
    -   If it exists, check its modification timestamp.
    -   If the file is less than 10 minutes old, read its content, parse the JSON, and return it to the client.
    -   If the file is older than 10 minutes or doesn't exist, proceed to fetch fresh data.
3.  **HackerNews API Fetching**:
    -   First, fetch the list of top story IDs from `https://hacker-news.firebaseio.com/v0/topstories.json`.
    -   Take the first 5 story IDs.
    -   For each of the 5 IDs, fetch the full story details from `https://hacker-news.firebaseio.com/v0/item/{story_id}.json`.
    -   Use `Promise.all` to fetch the 5 stories concurrently.
    -   Extract the 'title', 'url', and 'score' from each story object.
4.  **Cache Writing**:
    -   Once the 5 headlines are fetched and formatted, write them as a JSON array to 'cache.json'.
5.  **Endpoint**: 
    -   The `GET /news` endpoint should return the (possibly cached) list of 5 headlines.
    -   The server should listen on a port, e.g., 3000.
    -   The entire application should be contained within a single `server.js` file using ES Modules (`import`/`export`).
