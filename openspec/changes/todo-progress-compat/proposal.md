# Proposal: todo-progress compatibility mode

## Why

When `todo-enforcer` and `@firstpick/pi-extension-todo-progress` (bundled in `pi-package-webui`) run together, both parse `- [ ]`/`- [x]`/`[-]` markdown checklists from assistant output and both inject system-prompt policy text — but with conflicting rules. `todo-progress` also auto-clears the progress widget on agent_end (`shouldAutoClearOnAgentEnd`), which masks stalls that `todo-enforcer` is specifically designed to detect. Agents see two competing todo rule sets, leading to ambiguous behavior.

The fix: make `todo-enforcer` natively read from `todo-progress`'s persisted widget state (the canonical checklist source) instead of independently re-parsing the branch, and let `todo-enforcer` take over stall detection so `todo-progress`'s auto-clear does not hide stuck agents. This makes the two extensions complementary rather than conflicting.

## What Changes

- **New**: `todo-progress` adapter in `todo-snapshot.ts` that reads `todo-progress`'s persisted state entry (`STATE_KEY = "todo-progress-state"`) from the session branch, extracting its `items[]` and mapping `todo`/`partial`/`done` → `pending`/`in_progress`/`completed`.
- **New**: Config option `todoSource: "branch" | "todo-progress" | "auto"`. Default `"auto"` — detects whether `todo-progress` state entries exist in the branch and uses them if present, falls back to branch parsing otherwise.
- **New**: Config option `respectProgressAutoClear: boolean` (default `true`). When `todo-progress` clears its widget on a normal agent_end, `todo-enforcer` treats this as "all tasks resolved" and suppresses injection for that turn — but stagnation/backoff counters still update, so genuine stalls are still caught on subsequent turns.
- **New**: Config option `injectTodoPolicy: boolean` (default `false`). When `false`, `todo-enforcer` does NOT inject any system-prompt todo policy text (avoids double-policy when `todo-progress` is active). When `true` and `todo-progress` is NOT detected, injects a minimal enforcer-specific policy.
- **New**: Config option `todoPolicyText: string` (optional). Custom policy text to inject when `injectTodoPolicy` is enabled.
- **Modified**: `before_agent_start` hook added to optionally inject policy text into `systemPrompt`.
- **Modified**: `todo-snapshot.ts` `buildTodoSnapshot` now dispatches to the appropriate source based on config.

## Capabilities

### New Capabilities

- `todo-progress-bridge`: Adapter layer that reads `todo-progress`'s persisted widget state as a todo source, with auto-detection of `todo-progress` presence in the session branch.

### Modified Capabilities

(none — this is a new capability added to an existing extension; no prior spec-level requirements exist)

## Impact

- **Code**: `src/todo-snapshot.ts` (add adapter + dispatch), `src/index.ts` (add `before_agent_start` hook, auto-clear detection), `src/config.ts` (new config fields), `src/session-state.ts` (track auto-clear suppressions).
- **Dependencies**: None new. The adapter reads `todo-progress` state from the session branch — no import of `todo-progress` code required.
- **Compatibility**: Fully backward-compatible. Default `todoSource: "auto"` means existing users without `todo-progress` see zero behavior change. Users with both extensions get automatic coordination.
- **Config**: New optional fields added to `TodoEnforcerConfig`. All default to safe values; existing configs continue to work without changes.
- **Tests**: New test suite for the adapter, auto-detection, auto-clear handling, and policy injection logic.
