import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Real-database suites live under the contract config.
    exclude: ['test/contract.test.ts', 'test/mcpServer.integration.test.ts'],
  },
});
