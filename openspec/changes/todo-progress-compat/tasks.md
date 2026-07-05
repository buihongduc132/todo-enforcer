## 1. Config layer

- [x] 1.1 Add `todoSource`, `respectProgressAutoClear`, `injectTodoPolicy`, `todoPolicyText` fields to `TodoEnforcerConfig` type in `src/config.ts`
- [x] 1.2 Set defaults in `DEFAULT_CONFIG`: `todoSource: "auto"`, `respectProgressAutoClear: true`, `injectTodoPolicy: false`
- [x] 1.3 Add type guards / validation for new fields in `src/type-guards.ts`
- [x] 1.4 Update `todo-enforcer.example.json` with new fields + comments

## 2. Todo-progress adapter

- [x] 2.1 Create `src/todo-progress-adapter.ts` — parse `todo-progress-state` entries from branch, validate `version === 1`, map `todo`/`partial`/`done` → `pending`/`in_progress`/`completed`
- [x] 2.2 Implement `readTodoProgressState(branch)` — scan entries for `customType === "todo-progress-state"`, return latest valid state or `null`
- [x] 2.3 Implement `buildSnapshotFromTodoProgress(state)` — return `{ available: boolean, snapshot: TodoSnapshot }` with correct `available: false` on empty items / version mismatch
- [x] 2.4 Implement `detectAutoClear(state)` — return `true` when `visible: false` AND `items: []`

## 3. Snapshot dispatch

- [x] 3.1 Update `buildTodoSnapshot` in `src/todo-snapshot.ts` to accept `todoSource` config and dispatch: `"auto"` → try adapter then fallback, `"branch"` → existing parser, `"todo-progress"` → adapter only
- [x] 3.2 Thread `todoSource` config through to `buildTodoSnapshot` calls in `src/index.ts` (agent_end + pollEvaluate)

## 4. Auto-clear handling

- [x] 4.1 In `agent_end` handler, after snapshot result, check `detectAutoClear` when `respectProgressAutoClear` is enabled — suppress injection for this cycle (early return after recording branch length)
- [x] 4.2 Add session-state tracking: `autoClearSuppressedCount` per session (for logging/diagnostics)
- [x] 4.3 Ensure polling timer still fires after auto-clear suppression — re-evaluates normally

## 5. Policy injection

- [x] 5.1 Register `before_agent_start` hook in `src/index.ts` when `injectTodoPolicy` is enabled
- [x] 5.2 Implement hook handler: return `{ systemPrompt: event.systemPrompt + policyText }` using `todoPolicyText` or built-in default
- [x] 5.3 Register hook via `registerHook("todo-enforcer", "before_agent_start", ...)`
- [x] 5.4 Add built-in default policy text constant focused on task continuation

## 6. Tests

- [x] 6.1 Create `tests/todo-progress-adapter.test.ts` — version validation, status mapping, empty items, missing state
- [x] 6.2 Add auto-detection tests to `tests/todo-snapshot.test.ts` — `todoSource: "auto"` with and without `todo-progress-state` entries
- [x] 6.3 Add auto-clear suppression tests to `tests/index.test.ts` — `respectProgressAutoClear: true/false`, `wasCancelled` stays false
- [x] 6.4 Add policy injection tests — `injectTodoPolicy: false` (no hook), `true` with custom text, `true` with default text
- [x] 6.5 Add config validation tests to `tests/config.test.ts` — new fields, defaults, invalid values

## 7. Docs

- [x] 7.1 Update `README.md` — new config fields table, `todo-progress` compatibility section
- [x] 7.2 Update `todo-enforcer.example.json` — all new fields with inline comments
- [x] 7.3 Run `npm test` + `npm run typecheck` — all green
