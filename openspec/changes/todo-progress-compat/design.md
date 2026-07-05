## Context

`todo-enforcer` and `@firstpick/pi-extension-todo-progress` (bundled in `pi-package-webui`) currently conflict when both are loaded:

1. **Double policy injection** — both inject system-prompt todo policy text on `before_agent_start`. Agent sees two conflicting rule sets.
2. **Double checklist parsing** — both parse `- [ ]`/`- [x]`/`[-]` from assistant messages independently. `todo-progress` then strips those lines from the message (via `stripChecklistLines`). This means `todo-enforcer`'s branch parser sees a *depleted* branch — the checklist text is gone from the visible conversation.
3. **Auto-clear masking** — `todo-progress` calls `clear()` on `agent_end` when `shouldAutoClearOnAgentEnd` returns true (normal final assistant text response). After clearing, `todo-progress`'s `items[]` is empty. If `todo-enforcer` reads from the widget state at that point, it sees zero incomplete tasks and suppresses injection — even if the agent genuinely stalled.

`todo-progress` persists its widget state via `pi.appendEntry(STATE_KEY, snapshotState(state))` where `STATE_KEY = "todo-progress-state"`. Each entry is a `PersistedTodoState` with `version: 1`, `visible`, `items[]`, `offset`, `goal`, `awaitingGoalCheck`, `allowNextListReplacement`. Items have `{ text, status }` where status ∈ `todo | partial | done`.

## Goals / Non-Goals

**Goals:**
- Read `todo-progress` persisted state as canonical todo source when present.
- Auto-detect `todo-progress` presence — zero config for the common case.
- Suppress enforcer's own policy injection when `todo-progress` is active (it has its own richer policy).
- Respect `todo-progress` auto-clear as a signal, but not blindly — still catch genuine stalls across subsequent turns.
- Full backward compatibility — existing configs and setups without `todo-progress` are unchanged.

**Non-Goals:**
- Not replacing `todo-progress`'s widget rendering or UI features.
- Not importing `todo-progress` as a code dependency (decoupled via branch entry reading).
- Not suppressing `todo-progress`'s auto-clear behavior (that's its design choice; we adapt to it).
- Not handling `todo-progress` versions other than `version: 1` (graceful fallback only).

## Decisions

### D1: Read state via session branch entries, not imports

**Choice**: Parse `todo-progress-state` custom entries from `ctx.sessionManager.getBranch()` directly.

**Rationale**: No npm dependency on `@firstpick/pi-extension-todo-progress`. The state schema is simple JSON persisted as custom entries. We already read the branch for our own snapshots. Decoupled — survives `todo-progress` version bumps as long as `version: 1` schema holds.

**Alternative considered**: Import `@firstpick/pi-utils`'s `extractChecklist` and re-parse. Rejected — duplicates work `todo-progress` already did, and we'd still need to handle the stripped-lines problem.

### D2: Auto-detection via branch scan

**Choice**: `todoSource: "auto"` (default) scans the branch for any entry with `customType === "todo-progress-state"`. If found, uses the `todo-progress` adapter. Otherwise, falls back to the existing branch parser.

**Rationale**: Zero-friction. Users don't need to know whether `todo-progress` is bundled in their pi build. The scan is O(n) on branch length but only checks `customType` — cheap.

**Alternative**: Explicit `todoSource: "todo-progress"` config. Available as override, but auto-detection covers 99% of cases.

### D3: Status mapping

**Choice**: `todo-progress` status → enforcer status:
- `todo` → `pending`
- `partial` → `in_progress`
- `done` → `completed`

**Rationale**: Direct semantic mapping. Enforcer conditions (`has_incomplete`, `all_complete`, `has_in_progress`) operate on these statuses. No information loss.

### D4: Auto-clear handling — suppress one turn, not forever

**Choice**: When `respectProgressAutoClear` is `true` (default) and the latest `todo-progress-state` entry shows `items: []` AND `visible: false` (meaning `todo-progress` cleared), suppress injection for the current `agent_end` evaluation. BUT still record the branch length for progress detection and do NOT mark the agent as cancelled. On the next `agent_end` or poll, re-evaluate normally — if the agent truly stalled, the next turn's state will still show incomplete tasks (or `todo-progress` will repopulate).

**Rationale**: `todo-progress` clears on *normal* final assistant responses. If the agent produced a real final answer, suppressing is correct. If the agent stalled and `todo-progress` prematurely cleared, the enforcer's polling timer (after cooldown) will re-check and catch it — by then either `todo-progress` has repopulated (agent continued) or the branch shows no progress (genuine stall).

**Alternative**: Ignore auto-clear entirely. Rejected — causes spurious injections after legitimate task completion.

### D5: Policy injection suppression

**Choice**: `injectTodoPolicy` config (default `false`). When `false`, enforcer does NOT inject ANY system prompt policy text. `todo-progress` handles that. When `true` (user explicitly enables, e.g., running enforcer standalone without `todo-progress`), injects a minimal policy via `before_agent_start` hook returning `{ systemPrompt: event.systemPrompt + policy }`.

**Rationale**: Default `false` because `todo-progress` is bundled in the standard webui build and provides a richer, more specific policy. Avoids double-injection. Users running enforcer standalone can opt in.

### D6: Snapshot available flag

**Choice**: The `todo-progress` adapter returns `{ available: true, snapshot }` only when the latest state entry has `items.length > 0`. If `items` is empty or state is missing, returns `{ available: false }` — enforcer then falls through to its existing branch parser (if `todoSource: "auto"`) or skips injection (if `todoSource: "todo-progress"` explicit).

**Rationale**: Empty items from `todo-progress` means either (a) no todos created yet, (b) auto-cleared, or (c) all done. For (a) and (b), falling back to branch parsing is safe. For (c), `all_complete` condition won't match an empty snapshot so no celebration injection fires — correct.

## Risks / Trade-offs

- **[Risk] `todo-progress` schema changes in future version** → Adapter validates `version === 1` and returns `available: false` on mismatch, falling back to branch parsing. Graceful degradation.

- **[Risk] `todo-progress` not loaded but `todoSource` set to `"todo-progress"` explicitly** → No state entries found, adapter returns `available: false`, no injection. Enforcer appears silent. Mitigation: log a warning on first detection miss.

- **[Trade-off] Auto-detection scans branch on every `agent_end`** → O(n) scan added. Negligible — branch access is already O(n) for existing snapshot logic, and we only check `customType` field.

- **[Risk] `todo-progress` clears widget but agent still has work** → Suppressed injection for one turn. Poll timer catches it after cooldown. Worst case: one cooldown delay before re-injection.

- **[Trade-off] Two extensions still both load** → Not eliminating `todo-progress`, just coordinating with it. User could still see two sets of slash commands. This is acceptable — UI commands don't conflict semantically.
