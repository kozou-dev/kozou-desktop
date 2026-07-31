// Shared types crossing the main / preload / worker / renderer boundaries.
//
// The renderer never sees secrets: profiles are exposed to it in sanitized
// form only, and inspect results carry a trimmed SchemaContext (raw catalog
// records stripped — see trim.ts).

/** App-wide MCP serving mode. 'off' (the default) disables everything;
 *  'local' lets profiles run app-managed loopback MCP servers; 'remote-only'
 *  disables local serving and only surfaces remote declarations. A single
 *  value, so the modes are mutually exclusive by construction. */
export type McpMode = 'off' | 'local' | 'remote-only';

/** Main-assigned local-MCP allocation for one profile. Sticky by design:
 *  the port is assigned once and only changes on an explicit reassignment,
 *  because AI-client configs the user has already pasted reference it. */
export type LocalMcpAllocation = {
  port: number;
  /** Random capability path ("/mcp-<hex>"). Raises the bar from "any local
   *  process can port-scan the tools" to "must read the user's files"; it is
   *  not authentication and lands in AI-client configs in plaintext. */
  path: string;
  /** Start this profile's server on app launch. Set true by an explicit
   *  start and false by an explicit stop — never toggled implicitly. */
  autoStart: boolean;
};

/** Per-profile row-data access level. 'off' (the default) means the app
 *  never reads or writes row data for that profile — introspection only, the
 *  posture every profile starts from. 'read' allows browsing rows; 'readwrite'
 *  additionally allows insert/update/delete from the desktop UI. Granting is
 *  main-owned: it is not part of the profile form, and an escalation is
 *  persisted only after a native approval dialog. The MCP surface is
 *  unaffected — it stays read-only by construction whatever this says. */
export type RowAccess = 'off' | 'read' | 'readwrite';

/** A granted row-data capability: RowAccess without the 'off' floor. This is
 *  what a data worker is forked as, and it never changes for that process. */
export type DataCapability = Exclude<RowAccess, 'off'>;

/** User declaration that a remote MCP server (e.g. `kozou mcp` run
 *  elsewhere) already serves this profile's database. Only used to warn
 *  before starting a duplicate local server against the same database. */
export type RemoteMcpDeclaration = {
  declared: true;
  /** Optional remote server URL, display-only. */
  url?: string;
};

/** A named database profile as the renderer sees it (no secrets). */
export type ProfileView = {
  name: string;
  label?: string;
  color?: string;
  /** Connection URL with the password removed. */
  url: string;
  schemas: string[];
  /** Per-profile introspection statement timeout (ms). */
  timeoutMs?: number;
  /** Whether a password is stored (encrypted) for this profile. */
  hasPassword: boolean;
  /** Row-data access level (main-owned; 'off' unless explicitly granted). */
  rowAccess: RowAccess;
  /** Local-MCP allocation, present once assigned (main-owned). */
  localMcp?: LocalMcpAllocation;
  /** Remote-MCP declaration, present when the user declared one. */
  remoteMcp?: RemoteMcpDeclaration;
};

/** Input for creating/updating a profile. `url` may carry a password once —
 *  the main process splits it out into encrypted storage immediately. */
export type ProfileInput = {
  name: string;
  label?: string;
  color?: string;
  url: string;
  schemas: string[];
  timeoutMs?: number;
  /** Remote-MCP declaration. Omitted -> preserve the stored value;
   *  `{ declared: false }` -> clear it. The local-MCP allocation and the
   *  row-access level are main-owned and never part of renderer input:
   *  granting a capability must not ride along with a form save. */
  remoteMcp?: { declared: boolean; url?: string };
};

/** What the worker is asked to do (the connection URL travels via env,
 *  never in this message and never in argv). */
export type WorkerRequest = {
  schemas: string[];
  timeoutMs?: number;
};

/** Prefix the data worker puts on every line it writes itself. It is also the
 *  manager's allowlist: only lines carrying it are echoed to the app log, so
 *  unexpected output from a dependency can never carry a row value into a log
 *  (the worker's own lines are value-free by construction). Shared here so the
 *  worker and the manager cannot drift — and so main never has to import from
 *  a worker module, which would pull the write-capable package into its
 *  bundle. */
export const DATA_LOG_PREFIX = '[kozou-desktop-data]';

/** Upper bound for a row-data page. Mirrors @kozou/api's `MAX_PAGE_SIZE`
 *  without importing it: the write-capable package must stay out of the
 *  main-process bundle (see scripts/check-treeshake.mjs), so the constant is
 *  restated here and pinned against the real one by a unit test. */
export const DATA_MAX_PAGE_SIZE = 200;

/** Per-value budget the data worker applies to a browse page before the rows
 *  are serialized: characters for text, bytes for a byte array, approximate
 *  serialized bytes for a json/array/composite value. A page is up to
 *  DATA_MAX_PAGE_SIZE rows wide and a single column can hold an arbitrarily
 *  large value, so without this a page could move hundreds of megabytes through
 *  two IPC hops and hold them in the renderer for a pane that shows a few
 *  hundred characters per cell. The cut happens in the worker, before
 *  serialization — the worker itself still holds whatever the driver read. */
export const DATA_VALUE_BUDGET = 1024;

/** Longest cell text the browse pane renders (and puts in the tooltip). Kept
 *  at or below DATA_VALUE_BUDGET: the pane must not promise more than the wire
 *  carries — pinned by a unit test. */
export const DATA_CELL_PREVIEW_CHARS = 500;

/** One value the worker refused to carry in full, addressed by its position in
 *  the page it was cut from. Reported alongside the rows rather than mixed into
 *  them: a marker inside a row could collide with real json data, and a value
 *  silently replaced by a smaller one is exactly the kind of claim this pane
 *  must not make. */
export type DataTruncation = {
  /** Index into the page's `rows` array. */
  row: number;
  column: string;
  /** How the value was cut. 'text' and 'bytes' keep a leading slice; 'json' is
   *  replaced by null, because a partly serialized object is not a value. */
  kind: 'text' | 'bytes' | 'json';
  /** Characters ('text') or bytes ('bytes') the worker measured. For 'json' it
   *  is the budget the value passed — measurement stops there, so the real size
   *  is only known to be larger. */
  size: number;
};

/** List controls for a row-data browse request. Everything is optional; the
 *  worker turns these into @kozou/api's list grammar. Deliberately a closed
 *  shape rather than a URL or a raw query string — the renderer never composes
 *  a request path, and main validates every field before a worker sees it. */
export type DataListParams = {
  /** Rows per page (1..DATA_MAX_PAGE_SIZE). */
  pageSize?: number;
  /** Sort spec in the kozou list grammar: `col.asc,other.desc`. */
  sort?: string;
  /** Opaque keyset cursors handed back by a previous page. */
  after?: string;
  before?: string;
  /** Free-text search over the resource's searchable columns. */
  search?: string;
  /** Horizontal filters as `[column, "<op>.<value>"]` pairs (repeatable per
   *  column, combined with AND — the same grammar the REST layer parses). */
  filters?: [string, string][];
};

/** One row-data operation. `list`/`get` need row `read` access; the mutations
 *  need `readwrite` — enforced in main (before a worker is reached) and again
 *  inside the worker, whose capability is fixed at fork time. */
export type DataOperation =
  | { kind: 'list'; resource: string; params?: DataListParams }
  | { kind: 'get'; resource: string; id: string }
  | { kind: 'insert'; resource: string; values: Record<string, unknown> }
  | { kind: 'update'; resource: string; id: string; values: Record<string, unknown> }
  | { kind: 'delete'; resource: string; id: string };

/** Stable failure vocabulary for row-data operations. Derived from the
 *  outcome's status alone — never from the REST error body, which names
 *  primary keys and resources (see EGRESS.md item 12). */
export type DataErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'read_only'
  | 'unavailable'
  | 'failed';

/** Outcome of one row-data operation. `body` shapes follow @kozou/api's wire
 *  format (a list page, or a single row). A failure carries a controlled
 *  message: fixed text for every status except 400, whose message describes
 *  the input the user just typed. */
export type DataResult =
  | {
      ok: true;
      status: number;
      body: unknown;
      /** Values the worker cut out of a browse page to keep it within
       *  DATA_VALUE_BUDGET. Absent when nothing was cut, and never present for
       *  a single-row `get`: that path carries its values in full, which is
       *  what an editor needs and is bounded by one row rather than a page. */
      truncated?: DataTruncation[];
    }
  | { ok: false; status: number; code: DataErrorCode; message: string };

/** What the data worker is asked to do. The connection URL and the capability
 *  travel via env, never in these messages and never in argv. */
export type DataWorkerInbound =
  | { type: 'open'; schemas: string[]; timeoutMs?: number }
  | { type: 'run'; id: number; op: DataOperation };

/** The data worker's replies: one startup report, then one result per run. */
export type DataWorkerOutbound =
  | { type: 'opened'; ok: true }
  | { type: 'opened'; ok: false; error: string }
  | { type: 'result'; id: number; result: DataResult };

/** What the MCP server worker is asked to serve (the connection URL travels
 *  via env, never in this message and never in argv). */
export type McpWorkerRequest = {
  port: number;
  mcpPath: string;
  schemas: string[];
};

/** The MCP server worker's single startup report; after `ok: true` the
 *  worker stays resident until the parent kills it. */
export type McpWorkerStarted =
  | { ok: true; port: number }
  | { ok: false; error: string; portBusy?: boolean };

/** Live state of one profile's local MCP server (registry state in main;
 *  volatile — the store persists only the allocation and the autoStart
 *  intent). */
export type McpServerStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopped-crashed'
  | 'stopped-profile-updated'
  | 'error-port-busy'
  | 'error'
  | 'blocked-duplicate';

export type McpStatusEntry = {
  profile: string;
  status: McpServerStatus;
  /** Allocated port/path (persisted), present once assigned. */
  port?: number;
  path?: string;
  autoStart: boolean;
  /** Sanitized failure detail for error states. */
  error?: string;
};

/** Result of a start request. 'blocked-duplicate' means a declared remote
 *  MCP serves the same database — the renderer confirms and retries with
 *  `override: true`. */
export type McpStartOutcome = {
  outcome: 'started' | 'blocked-duplicate' | 'error' | 'not-local-mode';
  duplicates?: string[];
  error?: string;
  status: McpStatusEntry[];
};

export type InspectStats = {
  /** Milliseconds spent in @kozou/introspect (queries against pg_catalog). */
  introspectMs: number;
  /** Milliseconds spent in buildSchemaContext. */
  buildMs: number;
  /** Byte length of the full SchemaContext JSON (raw records included). */
  fullBytes: number;
  /** Byte length of the trimmed context JSON sent to the renderer. */
  trimmedBytes: number;
  /** Byte length of the AI-view payloads riding the same IPC message —
   *  counted separately so "sent" reporting stays honest. */
  aiViewsBytes: number;
};

/** What the AI receives from the MCP describe tools of a default-configured
 *  kozou server: the same pure functions, serialized through the server's own
 *  `successResult` (constructive identity — see worker/aiViews.ts, including
 *  the fidelity boundary for server-side opt-ins). Keyed by qualified name
 *  (concepts by concept name; functions is the single describe_functions
 *  payload). */
export type AiViews = {
  tables: Record<string, string>;
  views: Record<string, string>;
  concepts: Record<string, string>;
  functions: string | null;
};

export type InspectSuccess = {
  ok: true;
  /** Trimmed SchemaContext (rawTable/rawView/rawFunction stripped). */
  context: unknown;
  aiViews: AiViews;
  stats: InspectStats;
};

export type InspectFailure = {
  ok: false;
  /** Sanitized message — connection secrets are masked before this leaves
   *  the worker. */
  error: string;
};

export type InspectResult = InspectSuccess | InspectFailure;

/** The API surface preload exposes to the renderer. */
export type KozouDesktopApi = {
  listProfiles(): Promise<ProfileView[]>;
  saveProfile(input: ProfileInput): Promise<ProfileView[]>;
  deleteProfile(name: string): Promise<ProfileView[]>;
  inspect(name: string): Promise<InspectResult>;
  mcpModeGet(): Promise<McpMode>;
  mcpModeSet(mode: McpMode): Promise<McpMode>;
  mcpStart(name: string, opts?: { override?: boolean }): Promise<McpStartOutcome>;
  mcpStop(name: string): Promise<McpStatusEntry[]>;
  mcpStatus(): Promise<McpStatusEntry[]>;
  mcpReassignPort(name: string): Promise<McpStatusEntry[]>;
  /** Ask main to change a profile's row-access level. The renderer can only
   *  ask: an escalation is persisted after a native approval dialog and
   *  resolves to the unchanged level when the user declines. Downgrades
   *  (including 'off') apply without a prompt. */
  requestRowAccess(name: string, level: RowAccess): Promise<RowAccess>;
  /** Row-data operations. All five need the profile to be opted in — main
   *  rejects them otherwise, before any data worker is reached. The mutations
   *  additionally need 'readwrite'. */
  dataList(name: string, resource: string, params?: DataListParams): Promise<DataResult>;
  dataGet(name: string, resource: string, id: string): Promise<DataResult>;
  dataInsert(name: string, resource: string, values: Record<string, unknown>): Promise<DataResult>;
  dataUpdate(
    name: string,
    resource: string,
    id: string,
    values: Record<string, unknown>,
  ): Promise<DataResult>;
  dataDelete(name: string, resource: string, id: string): Promise<DataResult>;
  /** Subscribe to status pushes (server exit, restore progress). Returns an
   *  unsubscribe function. */
  onMcpStatusChanged(listener: (entries: McpStatusEntry[]) => void): () => void;
};

export const IPC = {
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  inspectRun: 'inspect:run',
  mcpModeGet: 'mcp:mode-get',
  mcpModeSet: 'mcp:mode-set',
  mcpStart: 'mcp:start',
  mcpStop: 'mcp:stop',
  mcpStatus: 'mcp:status',
  mcpReassignPort: 'mcp:reassign-port',
  /** Row-access grant requests ride their own channel, kept apart from the
   *  profile-save channel so a capability change is always an explicit act. */
  dataSetRowAccess: 'data:set-row-access',
  dataList: 'data:list',
  dataGet: 'data:get',
  dataInsert: 'data:insert',
  dataUpdate: 'data:update',
  dataDelete: 'data:delete',
  /** main -> renderer push (webContents.send), not an invoke channel. */
  mcpStatusChanged: 'mcp:status-changed',
} as const;
