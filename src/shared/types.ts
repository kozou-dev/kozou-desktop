// Shared types crossing the main / preload / worker / renderer boundaries.
//
// The renderer never sees secrets: profiles are exposed to it in sanitized
// form only, and inspect results carry a trimmed SchemaContext (raw catalog
// records stripped — see trim.ts).

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
};

/** What the worker is asked to do (the connection URL travels via env,
 *  never in this message and never in argv). */
export type WorkerRequest = {
  schemas: string[];
  timeoutMs?: number;
};

export type InspectStats = {
  /** Milliseconds spent in @kozou/introspect (queries against pg_catalog). */
  introspectMs: number;
  /** Milliseconds spent in buildSchemaContext. */
  buildMs: number;
  /** Byte length of the full SchemaContext JSON (raw records included). */
  fullBytes: number;
  /** Byte length of the trimmed JSON actually sent to the renderer. */
  trimmedBytes: number;
};

/** What the AI literally receives from the MCP describe tools: the same
 *  pure functions, serialized exactly as the MCP server does
 *  (JSON.stringify(payload, null, 2)). Keyed by qualified name (concepts by
 *  concept name; functions is the single describe_functions payload). */
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
};

export const IPC = {
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  inspectRun: 'inspect:run',
} as const;
