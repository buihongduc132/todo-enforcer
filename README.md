# todo-enforcer

> Todo continuation enforcer for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — monitors todo state and injects prompts to keep agents working until all tasks complete.

[![npm version](https://img.shields.io/npm/v/todo-enforcer?style=flat-square)](https://www.npmjs.com/package/todo-enforcer)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-blue?style=flat-square)](https://www.npmjs.com/search?q=pi-package)

## Features

- **Automatic task continuation** — injects prompts when the agent goes idle with incomplete tasks
- **Configurable rule engine** — first-match-wins rule evaluation with built-in and custom conditions
- **Multiple delivery modes** — `userMessage` (default) or `customMessage` via pi's messaging API
- **External command support** — call external scripts/HTTP endpoints for dynamic continuation logic
- **Spawn action** — run `pi -p` in background to generate continuation guidance
- **Stagnation detection** — stops injecting when the agent is stuck on the same incomplete count
- **Exponential backoff** — rate-limits retries on LLM errors (429, rate limits, etc.)
- **Message stall guard** — prevents infinite loops from repeated identical messages
- **Polling timer** — re-evaluates after cooldown even without agent_end events
- **Completion summary control** — configurable `completionSummary` to suppress or enable the "all done" message (default: suppressed)
- **`todo-progress` compatibility** — auto-detects `@firstpick/pi-extension-todo-progress` widget state and reads from it as canonical source; suppresses double policy injection; respects auto-clear

## `todo-progress` Compatibility

When `@firstpick/pi-extension-todo-progress` (bundled in `pi-package-webui`) is active alongside todo-enforcer, both extensions would otherwise conflict: double policy injection, double checklist parsing, and auto-clear masking stalls.

todo-enforcer solves this with four config options (all default to safe values):

| Config | Default | Effect |
|--------|---------|--------|
| `todoSource` | `"auto"` | `"auto"`: detect todo-progress state in branch, use it if present, fall back to branch parser. `"branch"`: always use branch parser. `"todo-progress"`: only use todo-progress state. |
| `respectProgressAutoClear` | `true` | When todo-progress clears its widget on a normal agent_end, suppress injection for that cycle (but don't cancel — poll timer re-evaluates after cooldown). |
| `injectTodoPolicy` | `false` | When `false`, no system-prompt policy injection (todo-progress handles it). Set `true` only when running enforcer standalone without todo-progress. |
| `todoPolicyText` | (built-in default) | Custom policy text when `injectTodoPolicy: true`. |

## Installation

### For Humans

```bash
npm install -g todo-enforcer
```

### For AI Agents (pi / OpenCode / Claude Code / Codex)

Add to your `settings.json`:

```jsonc
{
  "packages": ["todo-enforcer"]
}
```

Or tell your agent:

```
Install and configure todo-enforcer by following:
https://raw.githubusercontent.com/buihongduc132/todo-enforcer/refs/heads/main/README.md
```

### For pi (git-sourced)

In `settings.json`:

```jsonc
{
  "packages": ["https://github.com/buihongduc132/todo-enforcer"]
}
```

### For pi (local path)

In `settings.json`:

```jsonc
{
  "packages": ["/path/to/todo-enforcer"]
}
```

## Usage

todo-enforcer auto-activates via pi's `agent_end` lifecycle hook. No manual invocation needed.

### How It Works

1. On each `agent_end` event, the enforcer reads the current todo state
2. It evaluates rules in order — the first matching rule wins
3. If a rule matches, it generates a prompt and delivers it to the agent
4. A polling timer re-checks after the cooldown expires

### Default Rules

| Rule | Condition | Action |
|------|-----------|--------|
| `incomplete-tasks-remain` | Any pending/in_progress tasks | Inject continuation prompt |
| `all-complete-celebration` | All tasks completed | Inject summary (disabled by default) |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/enforcer-status` | Show current enforcer state, rules, and injection count |
| `/enforcer-switch <rule1,rule2,...>` | Switch active rules for this session |
| `/enforcer-switch reset` | Reset to config defaults |
| `/enforcer-reset` | Reset all enforcer state for this session |

### Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+T` | Toggle enforcer enabled/disabled |

## Configuration

Create `~/.todo-enforcer.json` (global) or `.todo-enforcer.json` (project-level):

```jsonc
{
  "enabled": true,
  "maxInjections": 5,          // Max injections per session
  "cooldownMs": 5000,          // Cooldown between injections (ms)
  "completionSummary": false,  // Suppress "all done" message (default)
  "todoSource": "auto",       // "auto" | "branch" | "todo-progress"
  "respectProgressAutoClear": true,  // Respect todo-progress widget clear
  "injectTodoPolicy": false,   // Inject policy text (false = let todo-progress handle)
  "detectStagnation": true,    // Stop injecting when stuck
  "stagnationThreshold": 3,    // Consecutive idle events before stagnation
  "backoff": {
    "enabled": true,
    "factor": 2,
    "maxDelayMs": 3600000,
    "errorPatterns": ["429", "rate limit", "No deployments available"]
  },
  "messageDelivery": {
    "mode": "userMessage",     // "userMessage" or "customMessage"
    "display": true,
    "triggerTurn": true
  },
  "rules": [
    {
      "name": "incomplete-tasks-remain",
      "condition": "has_incomplete",
      "action": "prompt",
      "prompt": "You have incomplete tasks. Continue working on them.\n\n[Status: {{completed_count}}/{{total_count}} completed, {{incomplete_count}} remaining]\n\nRemaining tasks:\n{{incomplete_list}}\n\nPick up where you left off."
    },
    {
      "name": "all-complete-celebration",
      "condition": "all_complete",
      "action": "prompt",
      "prompt": "All {{total_count}} tasks are complete. Great work.\n\nCompleted tasks:\n{{completed_list}}\n\nYou may now summarize the results or ask the user for next steps."
    }
  ]
}
```

### Built-in Conditions

| Condition | Description |
|-----------|-------------|
| `has_incomplete` | Any pending/in_progress tasks remain |
| `all_complete` | Every non-deleted task is completed |
| `has_in_progress` | At least one task is in_progress |
| `none` | Never matches (disabled rule) |
| `always` | Always matches |

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{incomplete_count}}` | Number of incomplete tasks |
| `{{completed_count}}` | Number of completed tasks |
| `{{total_count}}` | Total non-deleted tasks |
| `{{incomplete_list}}` | Formatted list of incomplete tasks |
| `{{completed_list}}` | Formatted list of completed tasks |
| `{{latest_user_message}}` | Latest user message content |
| `{{assistant_messages}}` | Recent assistant messages |

### Actions

| Action | Description |
|--------|-------------|
| `prompt` | Inject a static template string |
| `external` | Call an external command or HTTP endpoint |
| `spawn` | Run `pi -p` in background with a template |
| `noop` | Do nothing (for logging/future use) |

## Architecture

```
todo-enforcer/
├── src/
│   ├── index.ts              ← Entry point — hooks, commands, shortcuts
│   ├── config.ts             ← Config loader + types + template interpolation
│   ├── conditions.ts         ← Built-in + custom condition evaluator
│   ├── external-caller.ts    ← External command/HTTP executor
│   ├── session-state.ts      ← Per-session state tracking
│   ├── todo-snapshot.ts      ← Reads todo state from session branch
│   ├── message-stall.ts      ← Repeated message + rate limit guard
│   ├── type-guards.ts        ← Runtime type guards
│   └── lib/
│       ├── plugin-logger.ts  ← File-based structured logger
│       ├── hooks-manager.ts  ← Hook registration and state
│       └── types.ts          ← Shared types
├── tests/                    ← Test suite (134 tests)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:ci

# Type check
npm run typecheck
```

## License

MIT

## Repository

**GitHub**: [buihongduc132/todo-enforcer](https://github.com/buihongduc132/todo-enforcer)
