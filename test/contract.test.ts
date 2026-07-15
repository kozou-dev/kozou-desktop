// Contract test: the worker's direct-import pipeline must produce a
// SchemaContext deep-equal to `kozou inspect`'s output for the same
// database — pinning the app to the shipped CLI surface so the two can never
// drift silently.
//
// Requires a reachable PostgreSQL: set KOZOU_TEST_DATABASE_URL (the CI job
// provisions postgres:16 + fixtures/contract.sql; locally, any database
// works — e.g. the kozou quickstart compose stack).

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInspect } from '../src/worker/runInspect.js';

const url = process.env.KOZOU_TEST_DATABASE_URL;
const SCHEMAS = ['public'];

type Ctx = { meta: { builtAt?: string; serverVersion?: string } } & Record<string, unknown>;

function normalize(ctx: Ctx): Ctx {
  // builtAt is a wall-clock timestamp; everything else must match exactly.
  const meta = { ...ctx.meta };
  delete meta.builtAt;
  return { ...ctx, meta };
}

describe.skipIf(!url)('worker ≡ kozou inspect (contract)', () => {
  it('produces a SchemaContext deep-equal to the CLI output', async () => {
    const { context } = await runInspect({ url: url!, schemas: SCHEMAS });

    // CLI run: empty cwd (no kozou.config.yaml -> defaults: schemas=[public]),
    // connection injected via env DATABASE_URL — same resolution shipped users get.
    const cliBin = join(import.meta.dirname, '..', 'node_modules', '.bin', 'kozou');
    const cliOut = execFileSync(cliBin, ['inspect', '--format', 'json'], {
      cwd: mkdtempSync(join(tmpdir(), 'kozou-desktop-contract-')),
      env: { ...process.env, DATABASE_URL: url! },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const cliContext = JSON.parse(cliOut) as Ctx;

    expect(normalize(context as unknown as Ctx)).toEqual(normalize(cliContext));

    // Record the renderer-payload measurements for the CI log.
    const fullBytes = Buffer.byteLength(JSON.stringify(context));
    const { trimContext } = await import('../src/shared/trim.js');
    const trimmedBytes = Buffer.byteLength(
      JSON.stringify(trimContext(context as unknown as Record<string, unknown>)),
    );
    console.info(
      `[contract] full=${fullBytes}B trimmed=${trimmedBytes}B ratio=${(fullBytes / trimmedBytes).toFixed(2)}x`,
    );
    expect(trimmedBytes).toBeLessThan(fullBytes);
  });
});
