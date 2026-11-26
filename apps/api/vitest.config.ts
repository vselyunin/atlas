import { defineConfig } from 'vitest/config';

// Building the app (migrations, key generation) can take several seconds when every package's
// tests run at once, so tests and hooks get more room than Vitest's 5 s and 10 s defaults.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
