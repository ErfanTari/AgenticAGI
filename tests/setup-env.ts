// Load .env for integration tests that need real LLM/embedding endpoints.
// This runs before any test file is imported, so env vars are available
// when modules like core/llm.ts read process.env at import time.
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env') });
