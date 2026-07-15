// The single introspection entry point shared by the utilityProcess worker
// and the contract test. Directly consumes the published kozou packages —
// no CLI in between. The contract test pins this output to `kozou inspect`'s,
// so the two can never drift silently.

import { buildSchemaContext } from '@kozou/core';
import type { SchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';

export type RunInspectOptions = {
  /** Full connection URL (with password). Callers keep it out of argv/logs. */
  url: string;
  schemas: string[];
  /** Statement timeout for introspection queries (ms). Defaults inside
   *  @kozou/introspect (10s) when omitted. */
  timeoutMs?: number;
};

export type RunInspectResult = {
  context: SchemaContext;
  timings: { introspectMs: number; buildMs: number };
};

export async function runInspect(opts: RunInspectOptions): Promise<RunInspectResult> {
  const t0 = performance.now();
  const raw = await introspect({
    connection: opts.url,
    schemas: opts.schemas,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const t1 = performance.now();
  const context = await buildSchemaContext({ raw });
  const t2 = performance.now();
  return {
    context,
    timings: { introspectMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1) },
  };
}
