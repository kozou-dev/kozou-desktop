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
  /** main -> renderer push (webContents.send), not an invoke channel. */
  mcpStatusChanged: 'mcp:status-changed',
} as const;
