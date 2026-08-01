import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/contract.test.ts',
      'test/mcpServer.integration.test.ts',
      'test/data.integration.test.ts',
      'test/comment.integration.test.ts',
    ],
    // Introspection against a real database + a CLI subprocess run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
