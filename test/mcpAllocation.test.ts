import { describe, expect, it } from 'vitest';
import { generateMcpPath, nextFreePort } from '../src/main/mcpAllocation.js';

describe('nextFreePort', () => {
  it('starts at 3335 and skips taken ports', () => {
    expect(nextFreePort([])).toBe(3335);
    expect(nextFreePort([3335])).toBe(3336);
    expect(nextFreePort([3335, 3337])).toBe(3336);
    expect(nextFreePort([3335, 3336])).toBe(3337);
  });

  it('throws when the range is exhausted', () => {
    expect(() => nextFreePort([65_535], 65_535)).toThrow(/no free/);
  });
});

describe('generateMcpPath', () => {
  it('produces a 128-bit capability path and does not repeat', () => {
    const a = generateMcpPath();
    const b = generateMcpPath();
    expect(a).toMatch(/^\/mcp-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
