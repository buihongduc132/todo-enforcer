## ADDED Requirements

### Requirement: Todo source auto-detection

The system SHALL support a `todoSource` config field with values `"auto"`, `"branch"`, or `"todo-progress"` (default: `"auto"`). In `"auto"` mode, the system SHALL scan the session branch for entries with `customType === "todo-progress-state"` and use the `todo-progress` adapter when found, falling back to branch parsing otherwise.

#### Scenario: Auto-detects todo-progress when present

- **WHEN** `todoSource` is `"auto"` and the session branch contains at least one entry with `customType === "todo-progress-state"`
- **THEN** the system SHALL read the latest `todo-progress-state` entry and build the snapshot from its `items[]` array

#### Scenario: Falls back to branch parsing when todo-progress absent

- **WHEN** `todoSource` is `"auto"` and no `todo-progress-state` entries exist in the branch
- **THEN** the system SHALL use the existing branch parser (parse `- [ ]`/`- [x]`/`[-]` markers from messages)

#### Scenario: Explicit branch source

- **WHEN** `todoSource` is `"branch"`
- **THEN** the system SHALL always use the branch parser regardless of `todo-progress` presence

#### Scenario: Explicit todo-progress source with no state

- **WHEN** `todoSource` is `"todo-progress"` and no `todo-progress-state` entries exist in the branch
- **THEN** the system SHALL log a warning and skip injection for that evaluation cycle

### Requirement: Todo-progress state adapter

The system SHALL parse `todo-progress`'s persisted `PersistedTodoState` entries from the session branch and map item statuses: `todo` → `pending`, `partial` → `in_progress`, `done` → `completed`. The adapter SHALL validate `version === 1` and return `available: false` on schema mismatch or missing state.

#### Scenario: Maps todo-progress items to enforcer snapshot

- **WHEN** the latest `todo-progress-state` entry has `version: 1` and `items: [{ text: "Write tests", status: "todo" }, { text: "Run tests", status: "done" }]`
- **THEN** the adapter SHALL return a snapshot with `incompleteCount: 1`, `completedCount: 1`, `totalCount: 2`, and the incomplete item "Write tests" with status `pending`

#### Scenario: Maps partial status correctly

- **WHEN** a `todo-progress` item has `status: "partial"`
- **THEN** the adapter SHALL map it to enforcer status `in_progress`

#### Scenario: Rejects unsupported version

- **WHEN** the latest `todo-progress-state` entry has `version: 2`
- **THEN** the adapter SHALL return `{ available: false }` and log a warning

#### Scenario: Empty items returns unavailable

- **WHEN** the latest `todo-progress-state` entry has `items: []`
- **THEN** the adapter SHALL return `{ available: false }`

### Requirement: Respect todo-progress auto-clear

The system SHALL support a `respectProgressAutoClear` config field (default: `true`). When enabled and the latest `todo-progress-state` entry shows `visible: false` AND `items: []`, the system SHALL suppress injection for the current evaluation cycle without marking the session as cancelled. Progress detection, stagnation tracking, and polling timers SHALL continue to operate normally for subsequent cycles.

#### Scenario: Suppresses injection after auto-clear

- **WHEN** `respectProgressAutoClear` is `true` and the latest `todo-progress-state` entry has `visible: false` and `items: []`
- **THEN** the system SHALL skip injection for the current `agent_end` cycle

#### Scenario: Re-evaluates on next cycle after auto-clear

- **WHEN** injection was suppressed due to auto-clear and the polling timer fires after cooldown
- **THEN** the system SHALL re-read `todo-progress` state and evaluate rules normally — if incomplete tasks are present, injection SHALL proceed

#### Scenario: Does not mark session as cancelled

- **WHEN** injection is suppressed due to auto-clear
- **THEN** the `wasCancelled` session state flag SHALL remain `false` (only user-initiated Esc/abort sets it)

#### Scenario: Can be disabled

- **WHEN** `respectProgressAutoClear` is `false`
- **THEN** the system SHALL ignore `todo-progress` auto-clear state and evaluate rules based on whatever todo source is configured

### Requirement: Policy injection control

The system SHALL support `injectTodoPolicy` (default: `false`) and optional `todoPolicyText` config fields. When `injectTodoPolicy` is `true`, the system SHALL register a `before_agent_start` hook that appends `todoPolicyText` (or a built-in default) to the system prompt. When `false`, the system SHALL NOT inject any todo policy text via system prompt.

#### Scenario: No policy injection by default

- **WHEN** `injectTodoPolicy` is `false` (default)
- **THEN** the system SHALL NOT modify the system prompt on `before_agent_start`

#### Scenario: Custom policy injection

- **WHEN** `injectTodoPolicy` is `true` and `todoPolicyText` is set to a custom string
- **THEN** the system SHALL append the custom text to `event.systemPrompt` on `before_agent_start`

#### Scenario: Default policy when text omitted

- **WHEN** `injectTodoPolicy` is `true` and `todoPolicyText` is not set
- **THEN** the system SHALL use a built-in default policy text focused on task continuation
