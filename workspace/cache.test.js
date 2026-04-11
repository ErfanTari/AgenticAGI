import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// This function represents the logic that would be exported from `server.js`.
// It's included here to make the test file self-contained and runnable.
async function getCachedData(fetchFunction) {
  const CACHE_FILE = 'cache.json';
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      const lastModified = stats.mtime.getTime();
      const now = Date.now();

      if (now - lastModified < CACHE_TTL_MS) {
        const cachedData = fs.readFileSync(CACHE_FILE, 'utf-8');
        return JSON.parse(cachedData);
      }
    }
  } catch (error) {
    // Ignore errors reading cache and proceed to fetch
  }

  const freshData = await fetchFunction();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(freshData));
  return freshData;
}


describe('Cache Logic', () => {

  test('should fetch fresh data when no cache exists', async (t) => {
    // Mock fs methods
    const existsSyncMock = t.mock.method(fs, 'existsSync', () => false);
    const writeFileSyncMock = t.mock.method(fs, 'writeFileSync', () => {});
    // These should not be called
    t.mock.method(fs, 'statSync', () => { throw new Error('statSync should not be called'); });
    t.mock.method(fs, 'readFileSync', () => { throw new Error('readFileSync should not be called'); });

    const freshData = { message: 'This is fresh data' };
    const fetchFunction = t.mock.fn(async () => freshData);