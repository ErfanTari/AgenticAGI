import { defineConfig } from 'vitest/config';

// Separate vitest config for real-LLM integration tests.
// Run with: pnpm vitest run --config vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ['tests/phase9/test1-persian-poetry.test.ts'],
    globals: false,
    testTimeout: 300_000, // 5 min — LLM planning takes time
    setupFiles: ['./tests/setup-env.ts'],
  },
});
