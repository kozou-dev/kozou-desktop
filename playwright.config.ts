import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  // Electron apps: one at a time.
  workers: 1,
  use: {
    trace: 'retain-on-failure',
  },
});
