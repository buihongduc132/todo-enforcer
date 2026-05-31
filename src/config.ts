/**
 * todo-enforcer config loader
 *
 * Loads and merges todo-enforcer configuration from:
 *   1. ~/.todo-enforcer.json        (global defaults)
 *   2. <cwd>/.todo-enforcer.json    (project overrides, higher priority)
 *
 * The project file deep-merges onto the global file.
 * Missing files are silently skipped.
 */
// @ts-nocheck

// 


import { readFileSync, writeFileSync, constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createPluginLogger } from "./lib/plugin-logger";

const logger = createPluginLogger("todo-enforcer");

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single rule that the enforcer evaluates on agent_end.
 *
 * Rules are evaluated in order. The FIRST rule whose `condition` matches
 * wins — no further rules are evaluated.
 */
export interface EnforcerRule {
	/** Human-readable name for logging. */
	name: string;

	/**
	 * Condition to match. Evaluated against the todo snapshot.
	 * Built-in conditions:
	 *   - "has_incomplete"     — any pending/in_progress tasks remain
	 *   - "all_complete"       — every non-deleted task is completed
	 *   - "has_in_progress"    — at least one task is in_progress
	 *   - "none"               — never matches (disabled rule)
	 *   - "always"             — always matches
	 *
	 * Custom conditions are registered via the `conditions` map in config.
	 */
	condition: string;

	/**
	 * How to handle the match:
	 *   - "prompt"     — inject a static prompt string into the TUI
	 *   - "external"   — call an external command/function and inject its output
	 *   - "noop"       — do nothing (useful for logging / future hooks)
	 */
	action: "prompt" | "external" | "noop" | "spawn";

	/**
	 * For action="prompt": the message to inject.
	 * Supports {{variables}}:
	 *   {{incomplete_count}}   — number of incomplete tasks
	 *   {{completed_count}}    — number of completed tasks
	 *   {{total_count}}        — total non-deleted tasks
	 *   {{incomplete_list}}    — "- [status] #id subject" per incomplete task
	 *   {{completed_list}}     — "- [completed] #id subject" per completed task
	 *   {{session_summary}}    — session file path or identifier
	 */
	prompt?: string;

	/**
	 * For action="external": command configuration.
	 */
	external?: ExternalCallConfig;

	/**
	 * For action="spawn": spawn a pi -p session to generate continuation guidance.
	 * Non-blocking — runs in background and delivers output when complete.
	 */
	spawn?: SpawnConfig;
}

export type DeliveryMode = "followUp" | "steer";
export type AssistantContextMode = "mostRecent" | "allSinceLatestUser";
export type UserContextMode = "latest";

/** How the enforcer delivers its message to the agent. */
export type MessageMode =
	| "userMessage" // pi.sendUserMessage(text, opts) — appears as user message, simplest
	| "customMessage"; // pi.sendMessage({ customType, content, display }, opts) — structured custom-type

export interface SessionContext {
	latestUserMessage: string;
	assistantMessages: string;
	allMessagesSinceLatestUser: string;
	sessionMetadata: string;
}

export interface MessageDeliveryConfig {
	/** Delivery mode: "userMessage" (default) or "customMessage". */
	mode?: MessageMode;

	/** For customMessage mode: the customType field. Default: "todo-enforcer". */
	customType?: string;

	/** For customMessage mode: whether the message is visible in TUI. Default: true. */
	display?: boolean;

	/** Whether to trigger a new agent turn when session is idle. Default: true. */
	triggerTurn?: boolean;

	/** How to deliver: "followUp" (after current turn) or "steer". Default: "followUp". */
	deliverAs?: DeliveryMode;
}

export interface ContextFeedConfig {
	userMode?: UserContextMode;
	assistantMode?: AssistantContextMode;
	includeSessionMetadata?: boolean;
	excludePreviousEnforcerMessages?: boolean;
}

export interface ExternalHttpConfig {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	silent?: boolean;
}

export type ErrorFallbackMode = "skip" | "default_prompt";

export interface ExternalCallConfig {
	/**
	 * Command to execute. Array of args.
	 * The command receives the full session context as JSON on stdin.
	 * Environment variables:
	 *   TODO_INCOMPLETE_COUNT, TODO_COMPLETED_COUNT, TODO_TOTAL_COUNT
	 */
	command?: string[];

	/** Optional HTTP endpoint to receive the session payload as JSON. */
	http?: ExternalHttpConfig;

	/** Timeout in ms. Default: 15000. */
	timeoutMs?: number;

	/** If true, errors from the external call are silently ignored. Default: true. */
	silent?: boolean;

	/**
	 * What to do when the external call fails.
	 * - "skip": do nothing.
	 * - "default_prompt": fall back to the configured default prompt rule.
	 */
	errorFallback?: ErrorFallbackMode;
}

export interface SpawnConfig {
	/** Template for the pi -p prompt. Supports {{variable}} interpolation. */
	template: string;
	/** Timeout in ms. Default: 7200000 (2 hours). */
	timeoutMs?: number;
	/** Working directory for the pi process. Default: ctx.cwd. */
	cwd?: string;
}

export interface BackoffConfig {
	/** Master enable/disable for backoff. Default: true. */
	enabled?: boolean;

	/** Multiplier for cooldown (e.g., 2 = double each time). Default: 2. */
	factor?: number;

	/** Maximum cooldown in ms. Default: 3600000 (1 hour). */
	maxDelayMs?: number;

	/**
	 * Regex patterns to detect errors in the injected message content.
	 * If a pattern matches, backoff is triggered/incremented.
	 */
	errorPatterns?: string[];
}

export interface TodoEnforcerConfig {
	/** Master enable/disable. Default: true. */
	enabled?: boolean;

	/** Maximum injections per session before giving up. Default: 5. */
	maxInjections?: number;

	/** Cooldown between injections in ms. Default: 60000 (1 min). */
	cooldownMs?: number;

	/** Exponential backoff settings. */
	backoff?: BackoffConfig;

	/**
	 * Ordered list of rules. First match wins.
	 * If no rule matches, nothing is injected.
	 */
	rules: EnforcerRule[];

	/**
	 * Custom condition functions (key = condition name, value = description).
	 * The actual condition logic lives in the extension — this map just
	 * declares which custom conditions exist for validation/logging.
	 */
	conditions?: Record<string, string>;

	/**
	 * Whether to track and report stagnation (same incomplete count across
	 * multiple agent_end events). Default: true.
	 */
	detectStagnation?: boolean;

	/** Stagnation threshold: N consecutive idle events with no progress. Default: 3. */
	stagnationThreshold?: number;

	/** Message delivery configuration for injected reminders. */
	messageDelivery?: MessageDeliveryConfig;

	/** Controls what session context is fed into prompts and external calls. */
	contextFeed?: ContextFeedConfig;

	/**
	 * Whether to deliver the completion summary when all tasks are done.
	 * When false (default), the all-complete rule is suppressed — no message
	 * is sent after every task finishes. Set to true to re-enable the summary.
	 */
	completionSummary?: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: TodoEnforcerConfig = {
	enabled: true,
	maxInjections: 5,
	cooldownMs: 5_000,
	backoff: {
		enabled: true,
		factor: 2,
		maxDelayMs: 3_600_000,
		errorPatterns: [
			"429",
			"rate limit",
			"No deployments available",
			"Try again in",
			"Retry failed after",
		],
	},
	detectStagnation: true,
	stagnationThreshold: 3,
	messageDelivery: {
		mode: "userMessage",
		customType: "todo-enforcer",
		display: true,
		triggerTurn: true,
		deliverAs: "followUp",
	},
	completionSummary: false,
	contextFeed: {
		userMode: "latest",
		assistantMode: "allSinceLatestUser",
		includeSessionMetadata: true,
		excludePreviousEnforcerMessages: true,
	},
	rules: [
		{
			name: "incomplete-tasks-remain",
			condition: "has_incomplete",
			action: "prompt",
			prompt: `You have incomplete tasks. Continue working on them.

[Status: {{completed_count}}/{{total_count}} completed, {{incomplete_count}} remaining]

Remaining tasks:
{{incomplete_list}}

Latest user message:
{{latest_user_message}}

Recent assistant messages:
{{assistant_messages}}

Pick up where you left off. Do NOT stop until all tasks are completed or explicitly blocked.`,
		},
		{
			name: "all-complete-celebration",
			condition: "all_complete",
			action: "prompt",
			prompt: `All {{total_count}} tasks are complete. Great work.

Completed tasks:
{{completed_list}}

You may now summarize the results or ask the user for next steps.`,
		},
	],
};

// ─── Deep merge ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
	const result = { ...base };
	for (const key of Object.keys(override)) {
		const baseVal = base[key];
		const overVal = override[key];
		if (
			baseVal &&
			overVal &&
			typeof baseVal === "object" &&
			typeof overVal === "object" &&
			!Array.isArray(baseVal) &&
			!Array.isArray(overVal)
		) {
			result[key] = deepMerge(baseVal, overVal);
		} else {
			result[key] = overVal;
		}
	}
	return result;
}

// ─── Config loader ───────────────────────────────────────────────────────────

export function tryParseJson(raw: string): Record<string, unknown> | null {
	const stripped = raw.trim().replace(/^\s*\/\/.*$/gm, "");
	try {
		const parsed = JSON.parse(stripped);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("JSON parse failed", { error: error.message });
		return null;
	}
}

function loadJsonFile(filePath: string): Record<string, unknown> | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		return tryParseJson(raw);
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		if ("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		logger.error("Failed to read config file", { filePath, error: error.message });
		return null;
	}
}

async function loadJsonFileAsync(
	filePath: string,
): Promise<Record<string, unknown> | null> {
	try {
		const raw = await readFile(filePath, "utf-8");
		return tryParseJson(raw);
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		if ("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		logger.error("Failed to read config file", { filePath, error: error.message });
		return null;
	}
}

export function mergeConfigLayers(
	globalCfg?: Partial<TodoEnforcerConfig> | null,
	projectCfg?: Partial<TodoEnforcerConfig> | null,
): TodoEnforcerConfig {
	let merged = { ...DEFAULT_CONFIG } as TodoEnforcerConfig;

	if (globalCfg) {
		merged = deepMerge(merged, globalCfg as TodoEnforcerConfig);
	}

	if (projectCfg) {
		merged = deepMerge(merged, projectCfg as TodoEnforcerConfig);
	}

	if (!Array.isArray(merged.rules) || merged.rules.length === 0) {
		logger.warn("No rules defined — using defaults");
		merged.rules = DEFAULT_CONFIG.rules;
	}

	merged.messageDelivery = deepMerge(
		DEFAULT_CONFIG.messageDelivery,
		merged.messageDelivery ?? {},
	);
	merged.contextFeed = deepMerge(
		DEFAULT_CONFIG.contextFeed,
		merged.contextFeed ?? {},
	);

	return merged;
}

// ─── First-launch initialization ────────────────────────────────────────────

/**
 * Sync version of ensureGlobalConfig — used only by the sync loadConfig() path.
 * If the global config file (~/.todo-enforcer.json) does not exist,
 * create it with all default values so the user can see and edit them.
 * Only writes if the file is missing — never overwrites.
 */
function ensureGlobalConfigSync(globalPath: string): void {
	try {
		readFileSync(globalPath, "utf-8");
		return; // file exists
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		if ("code" in error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.error("Failed to check config existence (sync)", { globalPath, error: error.message });
			return;
		}
		// file doesn't exist — proceed to create
	}
	try {
		const defaults = DEFAULT_CONFIG;
		const output: Record<string, unknown> = {
			"// delivery mode":
				"userMessage = pi.sendUserMessage() (default, simplest) | customMessage = pi.sendMessage() with customType",
			enabled: defaults.enabled,
			maxInjections: defaults.maxInjections,
			cooldownMs: defaults.cooldownMs,
			completionSummary: defaults.completionSummary ?? false,
			backoff: defaults.backoff,
			detectStagnation: defaults.detectStagnation,
			stagnationThreshold: defaults.stagnationThreshold,
			messageDelivery: {
				mode: defaults.messageDelivery?.mode ?? "userMessage",
				customType: defaults.messageDelivery?.customType ?? "todo-enforcer",
				display: defaults.messageDelivery?.display ?? true,
				triggerTurn: defaults.messageDelivery?.triggerTurn ?? true,
				deliverAs: defaults.messageDelivery?.deliverAs ?? "followUp",
			},
			contextFeed: defaults.contextFeed,
			rules: defaults.rules?.map((r) => ({
				name: r.name,
				condition: r.condition,
				action: r.action,
				...(r.prompt ? { prompt: r.prompt } : {}),
				...(r.external ? { external: r.external } : {}),
			})),
		};
		writeFileSync(
			globalPath,
			JSON.stringify(output, null, "\t") + "\n",
			"utf-8",
		);
		logger.info("Created default config (sync)", { globalPath });
	} catch (err) {
		// Non-blocking — config will use in-memory defaults.
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Failed to write default config (sync)", { globalPath, error: error.message });
	}
}

/**
 * If the global config file (~/.todo-enforcer.json) does not exist,
 * create it with all default values so the user can see and edit them.
 * Only writes if the file is missing — never overwrites.
 */
async function ensureGlobalConfig(globalPath: string): Promise<void> {
	try {
		await access(globalPath, constants.F_OK);
		return; // file exists
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		if ("code" in error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.error("Failed to check config existence", { globalPath, error: error.message });
			return;
		}
		// file doesn't exist — proceed to create
	}
	try {
		const defaults = DEFAULT_CONFIG;
		const output: Record<string, unknown> = {
			"// delivery mode":
				"userMessage = pi.sendUserMessage() (default, simplest) | customMessage = pi.sendMessage() with customType",
			enabled: defaults.enabled,
			maxInjections: defaults.maxInjections,
			cooldownMs: defaults.cooldownMs,
			completionSummary: defaults.completionSummary ?? false,
			backoff: defaults.backoff,
			detectStagnation: defaults.detectStagnation,
			stagnationThreshold: defaults.stagnationThreshold,
			messageDelivery: {
				mode: defaults.messageDelivery?.mode ?? "userMessage",
				customType: defaults.messageDelivery?.customType ?? "todo-enforcer",
				display: defaults.messageDelivery?.display ?? true,
				triggerTurn: defaults.messageDelivery?.triggerTurn ?? true,
				deliverAs: defaults.messageDelivery?.deliverAs ?? "followUp",
			},
			contextFeed: defaults.contextFeed,
			rules: defaults.rules?.map((r) => ({
				name: r.name,
				condition: r.condition,
				action: r.action,
				...(r.prompt ? { prompt: r.prompt } : {}),
				...(r.external ? { external: r.external } : {}),
			})),
		};
		await writeFile(
			globalPath,
			JSON.stringify(output, null, "\t") + "\n",
			"utf-8",
		);
		logger.info("Created default config", { globalPath });
	} catch (err) {
		// Non-blocking — config will use in-memory defaults.
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Failed to write default config", { globalPath, error: error.message });
	}
}

export async function loadConfigAsync(
	cwd: string,
): Promise<TodoEnforcerConfig> {
	const globalPath = resolve(homedir(), ".todo-enforcer.json");

	// Ensure global config exists on first launch
	await ensureGlobalConfig(globalPath);

	const projectPath = resolve(cwd, ".todo-enforcer.json");

	const [globalCfg, projectCfg] = await Promise.all([
		loadJsonFileAsync(
			globalPath,
		) as Promise<Partial<TodoEnforcerConfig> | null>,
		loadJsonFileAsync(
			projectPath,
		) as Promise<Partial<TodoEnforcerConfig> | null>,
	]);

	return mergeConfigLayers(globalCfg, projectCfg);
}

export function loadConfig(cwd: string): TodoEnforcerConfig {
	const globalPath = resolve(homedir(), ".todo-enforcer.json");

	// Ensure global config exists on first launch
	ensureGlobalConfigSync(globalPath);

	const projectPath = resolve(cwd, ".todo-enforcer.json");

	const globalCfg = loadJsonFile(
		globalPath,
	) as Partial<TodoEnforcerConfig> | null;
	const projectCfg = loadJsonFile(
		projectPath,
	) as Partial<TodoEnforcerConfig> | null;

	return mergeConfigLayers(globalCfg, projectCfg);
}

// ─── Template interpolation ──────────────────────────────────────────────────

export interface TodoSnapshot extends SessionContext {
	incompleteCount: number;
	inProgressCount: number;
	completedCount: number;
	totalCount: number;
	incompleteList: string;
	completedList: string;
	sessionSummary: string;
}

export function interpolateTemplate(
	template: string,
	snapshot: TodoSnapshot,
): string {
	return template
		.replace(/\{\{incomplete_count\}\}/g, String(snapshot.incompleteCount))
		.replace(/\{\{completed_count\}\}/g, String(snapshot.completedCount))
		.replace(/\{\{total_count\}\}/g, String(snapshot.totalCount))
		.replace(/\{\{incomplete_list\}\}/g, snapshot.incompleteList)
		.replace(/\{\{completed_list\}\}/g, snapshot.completedList)
		.replace(/\{\{session_summary\}\}/g, snapshot.sessionSummary)
		.replace(/\{\{latest_user_message\}\}/g, snapshot.latestUserMessage)
		.replace(/\{\{assistant_messages\}\}/g, snapshot.assistantMessages)
		.replace(
			/\{\{all_messages_since_latest_user\}\}/g,
			snapshot.allMessagesSinceLatestUser,
		)
		.replace(/\{\{session_metadata\}\}/g, snapshot.sessionMetadata);
}
