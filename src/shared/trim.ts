// Trim a SchemaContext for the renderer: drop the raw catalog records
// (`rawTable` / `rawView` / `rawFunction`), which the human-facing map never
// renders and which inflate the JSON severalfold. The full context stays
// available inside the worker for anything computed there.

type AnyRecord = Record<string, unknown>;

const RAW_KEYS = new Set(['rawTable', 'rawView', 'rawFunction']);

function stripRaw<T extends AnyRecord>(entry: T): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!RAW_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Structurally clone `context` without raw catalog records. The input is
 *  treated as untyped JSON so this file has no dependency on @kozou/core —
 *  the contract test pins the real shape. */
export function trimContext(context: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...context };
  for (const key of ['tables', 'views', 'functions'] as const) {
    const list = context[key];
    if (Array.isArray(list)) {
      out[key] = list.map((entry) => (entry && typeof entry === 'object' ? stripRaw(entry as AnyRecord) : entry));
    }
  }
  return out;
}
