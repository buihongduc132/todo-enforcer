/**
 * pi-hooks-manager — Type definitions
 */
// @ts-nocheck

// 

// 

// 


/** Persistence scope for hook state */
export type Scope = "global" | "local";

/** Hook source — where the hook conceptually originates from */
export type HookSource = "pi" | "claude";

/** Hook origin — where the extension is loaded from */
export type HookOrigin = "global" | "local" | "package";

/** A registered hook's metadata */
export interface HookRegistration {
  /** Extension name (directory/file name) */
  extension: string;
  /** Pi event name (e.g., "tool_call", "session_start") */
  event: string;
  /** Whether this hook can block the main workflow */
  blocking: boolean;
  /** Where the hook conceptually originates: native pi or Claude Code adapter */
  source: HookSource;
  /** Where the extension is loaded from: global (~/.pi/agent/), local (.pi/), or package */
  origin: HookOrigin;
}

/** Persisted state of disabled hooks */
export interface HookState {
  /** Current persistence scope */
  scope: Scope;
  /** Map of extension name → array of disabled event names */
  disabled: Record<string, string[]>;
}

/** Options for state operations */
export interface StatePaths {
  /** Global state directory (e.g., ~/.pi/agent/) */
  globalDir: string;
  /** Local state directory (e.g., .pi/) */
  localDir: string;
}

/** Parsed /hooks command */
export type ParsedCommand =
  | { action: "list" }
  | { action: "enable"; extension: string; event?: string }
  | { action: "disable"; extension: string; event?: string }
  | { action: "status" }
  | { action: "scope"; scope: Scope }
  | { action: "unknown"; raw: string };
