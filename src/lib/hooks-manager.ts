/**
 * hooks-manager — Shared library for pi hook management
 *
 * Provides:
 * - State persistence (global/local scope)
 * - Hook registry (registerHook / isEnabled / getRegistry)
 * - Toggle operations (addDisabled / removeDisabled)
 */
// @ts-nocheck

// 

// 

// 


import fs from "node:fs";
import path from "node:path";
import type { HookOrigin, HookRegistration, HookSource, HookState, Scope, StatePaths } from "./types";

const STATE_FILE = "hooks-state.json";

// ── Registry (in-memory, per-process, shared via globalThis) ────────────

const GLOBAL_REGISTRY_KEY = "__PI_HOOKS_REGISTRY__" as const;
const GLOBAL_DISABLED_KEY = "__PI_HOOKS_DISABLED__" as const;

function getGlobalRegistry(): HookRegistration[] {
  if (!(globalThis as any)[GLOBAL_REGISTRY_KEY]) {
    (globalThis as any)[GLOBAL_REGISTRY_KEY] = [];
  }
  return (globalThis as any)[GLOBAL_REGISTRY_KEY];
}

function getGlobalDisabled(): Record<string, string[]> {
  if (!(globalThis as any)[GLOBAL_DISABLED_KEY]) {
    (globalThis as any)[GLOBAL_DISABLED_KEY] = {};
  }
  return (globalThis as any)[GLOBAL_DISABLED_KEY];
}


/** Register a hook's metadata. Called by each extension at load time. */
export function registerHook(
  extension: string,
  event: string,
  opts: { blocking?: boolean; source?: HookSource; origin?: HookOrigin } = {},
): void {
  // Avoid duplicates (extension + event combo)
  const reg = getGlobalRegistry();
  const exists = reg.some((r) => r.extension === extension && r.event === event);
  if (!exists) {
    reg.push({
      extension,
      event,
      blocking: opts.blocking === true,
      source: opts.source ?? "pi",
      origin: opts.origin ?? "global",
    });
  }
}

/** Get all registered hooks. */
export function getRegistry(): HookRegistration[] {
  return [...getGlobalRegistry()];
}

/** Clear registry (for tests). */
export function clearRegistry(): void {
  getGlobalRegistry().length = 0;
}

/** Set the current disabled map. Called by pi-hooks-manager on state changes. */
export function setCurrentDisabled(disabled: Record<string, string[]>): void {
  (globalThis as any)[GLOBAL_DISABLED_KEY] = disabled;
}

/** Get the current disabled map (for tests/integration). */
export function getCurrentDisabled(): Record<string, string[]> {
  return getGlobalDisabled();
}

/** Check if a specific hook is enabled using the shared current disabled state. */
export function isEnabled(extension: string, event: string): boolean {
  const disabled = getGlobalDisabled();
  const events = disabled[extension];
  if (!events) return true;
  return !events.includes(event);
}

/** Check if a specific hook is enabled given an explicit disabled map (for tests). */
export function isEnabledWithState(extension: string, event: string, disabled: Record<string, string[]>): boolean {
  const events = disabled[extension];
  if (!events) return true;
  return !events.includes(event);
}

// ── State Persistence ──────────────────────────────────────────────────

function stateFilePath(dir: string): string {
  return path.join(dir, STATE_FILE);
}

function readStateFile(dir: string): HookState | null {
  const fp = stateFilePath(dir);
  try {
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed);
  } catch {
    return null;
  }
}

function sanitizeState(raw: unknown): HookState {
  if (!raw || typeof raw !== "object") return { scope: "global", disabled: {} };
  const obj = raw as Record<string, unknown>;
  const scope: Scope = obj.scope === "local" ? "local" : "global";
  let disabled: Record<string, string[]>;
  if (obj.disabled && typeof obj.disabled === "object" && !Array.isArray(obj.disabled)) {
    disabled = {};
    for (const [key, val] of Object.entries(obj.disabled as Record<string, unknown>)) {
      if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
        disabled[key] = val;
      }
    }
  } else {
    disabled = {};
  }
  return { scope, disabled };
}

/** Load state from global and/or local files, merging as needed. */
export function loadState(paths: StatePaths, scope: Scope): HookState {
  const globalState = readStateFile(paths.globalDir);

  if (scope === "global") {
    return globalState ?? { scope: "global", disabled: {} };
  }

  // scope === "local": merge local over global
  const localState = readStateFile(paths.localDir);

  if (!globalState && !localState) {
    return { scope: "local", disabled: {} };
  }

  if (!localState) {
    return { ...globalState!, scope: "local" };
  }

  if (!globalState) {
    return localState;
  }

  // Merge: local overrides global for same extension, global entries preserved if not in local
  const merged: Record<string, string[]> = { ...globalState.disabled };
  for (const [ext, events] of Object.entries(localState.disabled)) {
    merged[ext] = events; // local takes precedence
  }

  return { scope: "local", disabled: merged };
}

/** Save state to the appropriate directory based on scope. */
export function saveState(state: HookState, paths: StatePaths): void {
  const dir = state.scope === "local" ? paths.localDir : paths.globalDir;
  const fp = stateFilePath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), "utf-8");
}

/** Switch scope. Returns new state. Saves to new scope's file. */
export function switchScope(current: HookState, newScope: Scope, paths: StatePaths): HookState {
  if (current.scope === newScope) return current;

  // Load the target scope's existing state
  const targetState = loadState(paths, newScope);
  saveState(targetState, paths);
  return targetState;
}

// ── Toggle Operations ──────────────────────────────────────────────────

/** Add an event to the disabled list for an extension. Idempotent. */
export function addDisabled(state: HookState, extension: string, event: string): void {
  if (!state.disabled[extension]) {
    state.disabled[extension] = [];
  }
  if (!state.disabled[extension].includes(event)) {
    state.disabled[extension].push(event);
  }
}

/** Remove an event from the disabled list for an extension. Removes key if empty. */
export function removeDisabled(state: HookState, extension: string, event: string): void {
  const events = state.disabled[extension];
  if (!events) return;
  const idx = events.indexOf(event);
  if (idx === -1) return;
  events.splice(idx, 1);
  if (events.length === 0) {
    delete state.disabled[extension];
  }
}
