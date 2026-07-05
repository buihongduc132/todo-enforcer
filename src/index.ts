/**
 * todo-enforcer — pi extension
 *
 * Monitors the agent's todo state on each agent_end. When the agent goes idle
 * with incomplete tasks, evaluates a configurable rule set and injects a
 * message to keep the agent working. Works in both TUI and non-TUI (headless) modes.
 *
 * Inspired by oh-my-opencode's "Todo Continuation Enforcer" hook.
 *
 * Configuration (todo-enforcer.json):
 *   - ~/.todo-enforcer.json        (global)
 *   - <cwd>/.todo-enforcer.json    (project override)
 *
 * Delivery modes (config: messageDelivery.mode):
 *   - "userMessage"   (default) — pi.sendUserMessage(text, opts)
 *   - "customMessage"           — pi.sendMessage({ customType, content, display }, opts)
 *
 * Structure:
 *   todo-enforcer/
 *   ├── index.ts              ← THIS FILE (entry point)
 *   ├── config.ts             ← config loader + types + template interpolation
 *   ├── conditions.ts         ← built-in + custom condition evaluator
 *   ├── external-caller.ts    ← external command executor
 *   ├── session-state.ts      ← per-session state tracking
 *   └── todo-snapshot.ts      ← reads rpiv-todo state
 *
 * @see flow/requirements/todo-enforcer.md
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createPluginLogger } from "./lib/plugin-logger";
import { registerHook, isEnabled } from "./lib/hooks-manager";
import { evaluateCondition } from "./conditions";
import type {
	EnforcerRule,
	MessageDeliveryConfig,
	SessionContext,
	SpawnConfig,
	TodoEnforcerConfig,
	TodoSnapshot,
} from "./config";
import { DEFAULT_CONFIG, interpolateTemplate, loadConfig, loadConfigAsync } from "./config";
import { dummyExternalCall, executeExternalCall } from "./external-caller";
import {
	checkSimilarError,
	clearSessionIdentity,
	setSessionState,
	getCachedBranch,
	setCachedBranch,
	getCachedSessionId,
	getState,
	hasProgress,
	incrementBackoff,
	isCooldownElapsed,
	isUnderLimit,
	markCancelled,
	markEvaluating,
	markInFlight,
	markInjection,
	recordBranchLength,
	resetBackoff,
	resetConsecutive,
	resetErrorTracking,
	resetStagnation,
	resetState,
	setSpawnInFlight,
	trackStagnation,
} from "./session-state";
import {
	readTodoProgressState,
	detectAutoClear,
	TODO_PROGRESS_STATE_KEY,
} from "./todo-progress-adapter";
import { checkMessageStall, resetStallState } from "./message-stall";
import { spawn as spawnProcess } from "node:child_process";
import { type SessionEntry, buildSessionContext, buildTodoSnapshot } from "./todo-snapshot";
import type { TodoSource } from "./config";

/** Default timeout for spawned pi child processes (2 hours) */
const DEFAULT_SPAWN_TIMEOUT_MS = 7_200_000;

const HOOK_NAME = "todo-enforcer";
const logger = createPluginLogger(HOOK_NAME);

/** Built-in default policy text for injectTodoPolicy mode (standalone, no todo-progress). */
const DEFAULT_TODO_POLICY_TEXT = [
	"",
	"",
	"[TODO ENFORCER POLICY] For multi-step work:",
	"- Create a todo list using the todo tool for any task with 3+ steps.",
	"- Mark tasks in_progress when actively working on them.",
	"- Mark tasks completed immediately when done — never batch completions.",
	"- Do NOT stop until all tasks are completed or you hit a genuine blocker.",
	"- If you go idle with incomplete tasks, the enforcer will remind you to continue.",
].join("\n");

function safeWrap<T>(label: string, fn: () => T): T | null {
	try {
		return fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`${label}: ${message}`);
		return null;
	}
}

async function safeWrapAsync<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T | null> {
	try {
		return await fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`${label}: ${message}`);
		return null;
	}
}

// Command handlers use getCachedSessionId() — session identity is
// already captured in session_start before any command can run.

function getProgressBranchLength(branch: unknown[]): number {
	return branch.filter((entry) => {
		if (!entry || typeof entry !== "object") return true;
		const message = (
			entry as {
				message?: { customType?: string; role?: string; toolName?: string; content?: unknown };
			}
		).message;
		if (!message) return true;
		// Exclude enforcer's own injected custom messages from progress measurement
		if (message.customType === HOOK_NAME) return false;
		// Exclude todo tool results (status queries, not real work)
		if (message.role === "toolResult" && message.toolName === "todo") return false;
		// Exclude user messages injected by the enforcer via sendUserMessage
		if (message.role === "user" && typeof message.content === "string") {
			const text = (message.content as string).substring(0, 200);
			if (
				text.includes("You have incomplete tasks. Continue working on them.") ||
				text.includes("Pick up where you left off.")
			) return false;
		}
		return true;
	}).length;
}

function findMatchingRule(
	rules: EnforcerRule[],
	snapshot: TodoSnapshot,
): EnforcerRule | null {
	for (const rule of rules) {
		const matched = safeWrap(`condition "${rule.name}"`, () =>
			evaluateCondition(rule.condition, snapshot),
		);
		if (matched) return rule;
	}
	return null;
}

async function executeRule(
	rule: EnforcerRule,
	snapshot: TodoSnapshot,
	context: SessionContext,
	useDummyExternal: boolean,
): Promise<string | null> {
	switch (rule.action) {
		case "prompt": {
			if (!rule.prompt) {
				logger.warn(
					`Rule "${rule.name}" has action=prompt but no prompt defined`,
				);
				return null;
			}
			return interpolateTemplate(rule.prompt, snapshot);
		}

		case "external": {
			if (!rule.external) {
				logger.warn(
					`Rule "${rule.name}" has action=external but no external config`,
				);
				return null;
			}
			const caller = useDummyExternal ? dummyExternalCall : executeExternalCall;
			const result = await caller(rule.external, snapshot, context);
			if (!result.success) {
				const fallback = rule.external.errorFallback ?? "default_prompt";
				if (fallback === "skip") {
					return null;
				}
				// default_prompt: fall through — no matching fallback rule available
				return null;
			}
			return result.output;
		}

		case "noop":
			return null;

		case "spawn":
			return null;

		default: {
			const _exhaustiveCheck: never = rule.action;
			logger.warn(`Unknown action: ${String(_exhaustiveCheck)}`);
			return null;
		}
	}
}

/**
 * Deliver the enforcer message using the configured mode.
 *
 * - "userMessage" (default): uses pi.sendUserMessage() — appears as a user
 *   message in the conversation. Works in both TUI and non-TUI modes.
 * - "customMessage": uses pi.sendMessage() with a structured customType —
 *   appears as a custom message with configurable display/triggerTurn/deliverAs.
 *
 * Both modes work in TUI and non-TUI. Neither gates on hasUI.
 */
/**
 * Deliver the enforcer message using the configured mode.
 *
 * CRITICAL: When called from agent_end, the agent is already idle.
 * - userMessage mode: do NOT pass deliverAs — sendUserMessage without options
 *   triggers a new turn immediately. Passing deliverAs="followUp" causes the
 *   message to be queued for "after agent finishes" but agent already finished,
 *   so the message sits forever and no turn is triggered.
 * - customMessage mode: use triggerTurn: true + deliverAs: "steer" to ensure
 *   the idle agent picks it up and starts a new turn.
 */
function deliverMessage(
	pi: ExtensionAPI,
	delivery: MessageDeliveryConfig,
	message: string,
): void {
	const mode = delivery.mode ?? "userMessage";

	if (mode === "userMessage") {
		// No deliverAs — let sendUserMessage trigger a turn immediately.
		// This is the correct behavior when agent is idle at agent_end.
		pi.sendUserMessage(message);
	} else {
		pi.sendMessage(
			{
				customType: delivery.customType ?? HOOK_NAME,
				content: message,
				display: delivery.display ?? true,
			},
			{
				triggerTurn: true,
				deliverAs: "steer",
			},
		);
	}
}

export default function (pi: ExtensionAPI) {
	type ConfigCacheState = {
		cwd: string | null;
		value: TodoEnforcerConfig | null;
		promise: Promise<TodoEnforcerConfig> | null;
	};

	const configState: ConfigCacheState = {
		cwd: null,
		value: null,
		promise: null,
	};

	let config: TodoEnforcerConfig | null = null;

	function startConfigLoad(cwd: string): Promise<TodoEnforcerConfig> {
		if (configState.cwd === cwd && configState.value) {
			return Promise.resolve(configState.value);
		}
		if (configState.cwd === cwd && configState.promise) {
			return configState.promise;
		}

		configState.cwd = cwd;
		configState.value = null;
		const promise = loadConfigAsync(cwd)
			.then((loaded: TodoEnforcerConfig) => {
				configState.value = loaded;
				config = loaded;
				logger.info("config-loaded", {
					rules: loaded.rules.length,
					maxInjections: loaded.maxInjections,
					cooldownMs: loaded.cooldownMs,
					logFile: logger.filePath,
				});
				return loaded;
			})
			.catch((error) => {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error("config-load failed", { error: msg });
				configState.value = null;
				config = null;
				return DEFAULT_CONFIG;
			})
			.finally(() => {
				configState.promise = null;
			});
		configState.promise = promise;
		return promise;
	}

	function getConfigWhenNeeded(cwd: string): Promise<TodoEnforcerConfig> {
		if (configState.cwd === cwd && configState.value) {
			config = configState.value;
			return Promise.resolve(configState.value);
		}
		return startConfigLoad(cwd);
	}

	// ── Polling: timer-based re-evaluation after injection ────────────────
	//
	// After an injection, schedule a timer to re-check conditions once the
	// cooldown expires. This ensures the enforcer can fire even if the agent
	// goes idle without producing another agent_end event.
	//
	// Cancelled on: natural agent_end, session shutdown, all tasks done,
	// max injections reached.

	const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

	function cancelPoll(sessionId: string): void {
		const existing = pollTimers.get(sessionId);
		if (existing) {
			clearTimeout(existing);
			pollTimers.delete(sessionId);
		}
	}

	function schedulePoll(
		sessionId: string,
		cwd: string,
		overrideDelayMs?: number,
	): void {
		cancelPoll(sessionId);
		const baseDelay = config?.cooldownMs ?? 5_000;
		const delay =
			overrideDelayMs !== undefined ? overrideDelayMs : baseDelay + 1_000;
		if (delay <= 0) {
			void runPoll(sessionId, cwd);
			return;
		}
		const timer = setTimeout(() => {
			pollTimers.delete(sessionId);
			void runPoll(sessionId, cwd);
		}, delay);
		pollTimers.set(sessionId, timer);
	}

	async function runPoll(sessionId: string, cwd: string): Promise<void> {
		const state = getState(sessionId);
		if (state.spawnInFlight || state.wasCancelled || state.isEvaluating) return;

		const currentCfg = await getConfigWhenNeeded(cwd);
		if (!currentCfg.enabled) return;

		markEvaluating(sessionId, true);
		try {
			// Progress detection using cached branch
			const branch = getCachedBranch();
			const branchLength = Array.isArray(branch)
				? getProgressBranchLength(branch)
				: 0;
			if (hasProgress(sessionId, branchLength)) {
				resetConsecutive(sessionId);
				resetErrorTracking(sessionId);
				resetStagnation(sessionId);
			}
			recordBranchLength(sessionId, branchLength);

			const injected = await pollEvaluate(sessionId, currentCfg, cwd);
			if (injected) {
				schedulePoll(sessionId, cwd);
			}
		} finally {
			markEvaluating(sessionId, false);
		}
	}

	/** Shared evaluation logic for poll timers (subset of agent_end). */
	async function pollEvaluate(
		sessionId: string,
		cfg: TodoEnforcerConfig,
		cwd: string,
	): Promise<boolean> {
		const state = getState(sessionId);
		if (
			state.spawnInFlight ||
			state.isRecovering ||
			state.wasCancelled ||
			state.inFlight
		) {
			return false;
		}
		if (!isUnderLimit(sessionId, cfg.maxInjections ?? 5)) return false;
		if (!isCooldownElapsed(sessionId, cfg.cooldownMs ?? 5_000, cfg.backoff))
			return false;

		const context = safeWrap("buildSessionContext", () =>
			buildSessionContext(
				sessionId,
				cwd,
				() => getCachedBranch() as SessionEntry[],
				cfg.contextFeed ?? {},
			),
		);
		if (!context) return false;

		const snapshotResult = safeWrap("buildSnapshot", () =>
			buildTodoSnapshot(
				sessionId,
				() => getCachedBranch() as SessionEntry[],
				context,
				cfg.todoSource ?? "auto",
			),
		);
		if (!snapshotResult || !snapshotResult.available) return false;

		if (
			cfg.detectStagnation !== false &&
			snapshotResult.snapshot.incompleteCount > 0
		) {
			const stagnant = trackStagnation(
				sessionId,
				snapshotResult.snapshot.incompleteCount,
				cfg.stagnationThreshold ?? 3,
			);
			if (stagnant) return false;
		}

		let activeRules = getActiveRules(sessionId);

		// Suppress all_complete rules when completionSummary is disabled (default)
		if (!cfg.completionSummary) {
			activeRules = activeRules.filter(
				(rule) => rule.condition !== "all_complete",
			);
		}

		const rule = findMatchingRule(activeRules, snapshotResult.snapshot);
		if (!rule) return false;

		logger.info("rule-matched (poll)", {
			sessionId,
			rule: rule.name,
			action: rule.action,
		});

		// Handle spawn action
		if (rule.action === "spawn" && rule.spawn) {
			setSpawnInFlight(sessionId, true);
			markInjection(sessionId);
			resetStagnation(sessionId);
			executeSpawnAction(
				rule.spawn,
				snapshotResult.snapshot,
				context,
				sessionId,
				cfg.messageDelivery ?? {},
				cwd,
			);
			return true;
		}

		const message = await safeWrapAsync(`rule "${rule.name}"`, () =>
			executeRule(rule, snapshotResult.snapshot, context, false),
		);
		if (!message) return false;

		// ── Stall guard: repeated message + rate limit ───────────────────
		const stallPoll = checkMessageStall(sessionId, message);
		if (stallPoll.stalled) {
			logger.warn("message-stalled (poll)", {
				sessionId,
				reason: stallPoll.reason,
				rule: rule.name,
			});
			return false;
		}

		markInFlight(sessionId, true);
		try {
			deliverMessage(pi, cfg.messageDelivery ?? {}, message);
			markInjection(sessionId);
			resetStagnation(sessionId);

			if (cfg.backoff?.enabled !== false) {
				const matched = (cfg.backoff?.errorPatterns ?? []).some((p) =>
					new RegExp(p, "i").test(message),
				);
				if (matched) incrementBackoff(sessionId);
				else resetBackoff(sessionId);
			}

			logger.info("injection-delivered (poll)", {
				sessionId,
				injectionCount: getState(sessionId).injectionCount,
				rule: rule.name,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`Poll injection failed: ${msg}`, {
				sessionId,
				rule: rule.name,
			});
		} finally {
			markInFlight(sessionId, false);
		}

		return true;
	}

	// ── Spawn action: run pi -p in background ─────────────────────────────

	function executeSpawnAction(
		spawnConfig: SpawnConfig,
		snapshot: TodoSnapshot,
		_context: SessionContext,
		sessionId: string,
		delivery: MessageDeliveryConfig,
		cwd: string,
	): void {
		const prompt = interpolateTemplate(spawnConfig.template, snapshot);
		const timeout = spawnConfig.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS; // 2 hours

		logger.info("spawn-started", {
			sessionId,
			timeout,
			promptLength: prompt.length,
		});

		try {
			const child = spawnProcess("pi", ["-p", prompt], {
				cwd: spawnConfig.cwd ?? cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

		const killTimer = setTimeout(() => {
				child.kill("SIGTERM");
				logger.warn("spawn-timeout", { sessionId, timeout });
			}, timeout);

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				clearTimeout(killTimer);
				setSpawnInFlight(sessionId, false);

				if (code === 0 && stdout.trim()) {
					logger.info("spawn-completed", {
						sessionId,
						outputLength: stdout.length,
					});
					deliverMessage(pi, delivery, stdout.trim());
					schedulePoll(sessionId, cwd, 0);
				} else {
					logger.warn("spawn-failed", {
						sessionId,
						code,
						stderr: stderr.substring(0, 500),
					});
				schedulePoll(sessionId, cwd);
				}
			});

			child.on("error", (err) => {
				clearTimeout(killTimer);
				setSpawnInFlight(sessionId, false);
				logger.error("spawn-error", { sessionId, err: err.message });
				schedulePoll(sessionId, cwd);
			});
		} catch (err) {
			setSpawnInFlight(sessionId, false);
			logger.error(
				`spawn-exception: ${err instanceof Error ? err.message : String(err)}`,
				{ sessionId },
			);
		}
	}

	registerHook("todo-enforcer", "session_start", { blocking: false, source: "pi", origin: "global" });
	registerHook("todo-enforcer", "session_shutdown", { blocking: false, source: "pi", origin: "global" });
	registerHook("todo-enforcer", "agent_end", { blocking: false, source: "pi", origin: "global" });

	// ── Policy injection (before_agent_start) ─────────────────────────────
	// Only register when injectTodoPolicy is enabled in config.
	// Uses a SYNC config read at init time — must use process.cwd().
	try {
		const initCfg = loadConfig(process.cwd());
		if (initCfg.injectTodoPolicy) {
			registerHook("todo-enforcer", "before_agent_start", { blocking: false, source: "pi", origin: "global" });
			pi.on("before_agent_start", async (event, _ctx) => {
				if (!isEnabled("todo-enforcer", "before_agent_start")) return;
			const policyText = initCfg.todoPolicyText ?? DEFAULT_TODO_POLICY_TEXT;
				return { systemPrompt: event.systemPrompt + policyText };
			});
		}
	} catch (err) {
		logger.debug("policy-injection init skipped", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!isEnabled("todo-enforcer", "session_start")) return;

		// Extract cwd immediately — ctx becomes stale after session replacement.
		const sessionCwd = ctx.cwd;
		try {
			// Capture session identity while ctx is fresh — all other hooks
			// use the cached value to avoid stale-ctx crashes.
			const sm = ctx.sessionManager;
			setSessionState(sm.getSessionFile(), sm.getBranch());
			const sessionId = getCachedSessionId();
			resetState(sessionId);
			resetStallState(sessionId);
			void startConfigLoad(sessionCwd);
			logger.info("session-start", { sessionId, cwd: sessionCwd });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("session_start error", { error: msg });
		}
	});

	pi.on("session_shutdown", () => {
		if (!isEnabled("todo-enforcer", "session_shutdown")) return;

		try {
			const sessionId = getCachedSessionId();
			cancelPoll(sessionId);
			clearSessionIdentity();
			sessionActiveRules.delete(sessionId);
			// Individual state is cleaned on next session_start.
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("session_shutdown error", { error: msg });
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isEnabled("todo-enforcer", "agent_end")) return;

		// Extract cwd immediately — ctx becomes stale after session replacement.
		const sessionCwd = ctx.cwd;
		const sm = ctx.sessionManager;
		setCachedBranch(sm.getBranch());
		const sessionId = getCachedSessionId();
		const cfg = await getConfigWhenNeeded(sessionCwd);

		if (!cfg.enabled) return;

		const state = getState(sessionId);
		if (state.isEvaluating) {
			logger.debug("skipped", { sessionId, reason: "evaluation-in-flight" });
			return;
		}
		markEvaluating(sessionId, true);

		try {
			// Detect user-initiated abort (Esc key) — suppress all future injections
			if (
				event.messages &&
				Array.isArray(event.messages) &&
				event.messages.length > 0
			) {
				const lastAssistant = [...event.messages]
					.reverse()
					.find(
						(m): m is Extract<typeof m, { role: "assistant" }> =>
							"role" in m && (m as { role?: string }).role === "assistant",
					);
				if (
					lastAssistant &&
					"stopReason" in lastAssistant &&
					(lastAssistant as { stopReason?: string }).stopReason === "aborted"
				) {
					markCancelled(sessionId);
					logger.info("agent-aborted", { sessionId, reason: "user-esc" });
					return;
				}
			}

			// ── Detect LLM errors (red line / quota) → fuzzy compare → backoff ──
			if (
				event.messages &&
				Array.isArray(event.messages) &&
				event.messages.length > 0
			) {
				const lastErr = [...event.messages]
					.reverse()
					.find(
						(
							m,
						): m is Extract<
							typeof m,
							{ role: "assistant"; stopReason: string; errorMessage?: string }
						> =>
							"role" in m &&
							(m as { role?: string }).role === "assistant" &&
							"stopReason" in m &&
							((m as { stopReason?: string }).stopReason === "error" ||
								(m as { stopReason?: string }).stopReason === "aborted"),
					);
				if (lastErr?.errorMessage) {
					const { isSimilar, similarCount } = checkSimilarError(
						sessionId,
						lastErr.errorMessage,
					);
					if (isSimilar) {
						incrementBackoff(sessionId);
						logger.warn("similar-llm-error", {
							sessionId,
							similarCount,
							backoffCount: getState(sessionId).backoffCount,
						});
					}
				}
			}

			// ── Progress detection: reset consecutive count if meaningful branch grew ──
			const branch = getCachedBranch();
			const branchLength = Array.isArray(branch)
				? getProgressBranchLength(branch)
				: 0;
			if (hasProgress(sessionId, branchLength)) {
				logger.debug("progress-detected", { sessionId, branchLength });
				resetConsecutive(sessionId);
				resetErrorTracking(sessionId);
				resetStagnation(sessionId);
			}
			recordBranchLength(sessionId, branchLength);

			if (state.isRecovering) {
				logger.debug("skipped", { sessionId, reason: "recovering" });
				return;
			}
			if (state.wasCancelled) {
				logger.debug("skipped", { sessionId, reason: "cancelled" });
				return;
			}
			if (state.inFlight) {
				logger.debug("skipped", { sessionId, reason: "in-flight" });
				return;
			}

			if (!isUnderLimit(sessionId, cfg.maxInjections ?? 5)) {
				logger.info("skipped", {
					sessionId,
					reason: "max-consecutive-injections",
					consecutiveCount: state.consecutiveCount,
					maxInjections: cfg.maxInjections ?? 5,
					injectionCount: state.injectionCount,
				});
				return;
			}

			if (
				!isCooldownElapsed(sessionId, cfg.cooldownMs ?? 60_000, cfg.backoff)
			) {
				const s = getState(sessionId);
				const delay = Math.min(
					(cfg.cooldownMs ?? 60_000) *
						(cfg.backoff?.factor ?? 2) ** s.backoffCount,
					cfg.backoff?.maxDelayMs ?? 3_600_000,
				);
				const remaining = Math.ceil(
					(delay - (Date.now() - (s.lastInjectedAt ?? 0))) / 1000,
				);
				logger.debug("skipped", {
					sessionId,
					reason: "cooldown-active",
					remainingSeconds: remaining,
					backoffCount: s.backoffCount,
				});
				return;
			}

			const context = safeWrap("buildSessionContext", () =>
				buildSessionContext(
					sessionId,
					sessionCwd,
					() => getCachedBranch() as SessionEntry[],
					cfg.contextFeed ?? {},
				),
			);
			if (!context) return;

			const snapshotResult = safeWrap("buildSnapshot", () =>
				buildTodoSnapshot(
					sessionId,
					() => getCachedBranch() as SessionEntry[],
					context,
					cfg.todoSource ?? "auto",
				),
			);
			if (!snapshotResult || !snapshotResult.available) {
				return;
			}

			// ── Auto-clear suppression ───────────────────────────────────────
			// When todo-progress auto-clears its widget (visible:false, items:[]),
			// suppress injection for this cycle — but do NOT mark as cancelled.
			// Poll timer will re-evaluate after cooldown.
			if (cfg.respectProgressAutoClear !== false) {
				const tpState = readTodoProgressState(
					() => getCachedBranch() as SessionEntry[],
				);
				if (detectAutoClear(tpState)) {
					logger.debug("auto-clear-suppressed", { sessionId });
					return;
				}
			}

			if (
				cfg.detectStagnation !== false &&
				snapshotResult.snapshot.incompleteCount > 0
			) {
				const threshold = cfg.stagnationThreshold ?? 3;
				const stagnant = trackStagnation(
					sessionId,
					snapshotResult.snapshot.incompleteCount,
					threshold,
				);
				if (stagnant) {
					logger.info("stagnation-detected", {
						sessionId,
						incompleteCount: snapshotResult.snapshot.incompleteCount,
						threshold: cfg.stagnationThreshold ?? 3,
					});
					return;
				}
			}

			let activeRules = getActiveRules(sessionId);

			// Suppress all_complete rules when completionSummary is disabled (default)
			if (!cfg.completionSummary) {
				activeRules = activeRules.filter(
					(rule) => rule.condition !== "all_complete",
				);
			}

			const rule = findMatchingRule(activeRules, snapshotResult.snapshot);
			if (!rule) {
				logger.debug("skipped", { sessionId, reason: "no-matching-rule" });
				return;
			}

			logger.info("rule-matched", {
				sessionId,
				rule: rule.name,
				condition: rule.condition,
				action: rule.action,
			});

			const message = await safeWrapAsync(`rule "${rule.name}"`, () =>
				executeRule(rule, snapshotResult.snapshot, context, false),
			);
			if (!message) return;

			// ── Stall guard: repeated message + rate limit ───────────────────
			const stallAgent = checkMessageStall(sessionId, message);
			if (stallAgent.stalled) {
				logger.warn("message-stalled", {
					sessionId,
					reason: stallAgent.reason,
					rule: rule.name,
				});
				return;
			}

			markInFlight(sessionId, true);
			try {
				deliverMessage(pi, cfg.messageDelivery ?? {}, message);

				markInjection(sessionId);
				resetStagnation(sessionId);

				if (cfg.backoff?.enabled !== false) {
					const patterns = cfg.backoff?.errorPatterns ?? [];
					const matched = patterns.some((pattern) =>
						new RegExp(pattern, "i").test(message),
					);
					if (matched) {
						incrementBackoff(sessionId);
						logger.warn("output-error-pattern-matched", {
							sessionId,
							backoffCount: getState(sessionId).backoffCount,
						});
					} else {
						resetBackoff(sessionId);
					}
				}

				// Schedule poll for re-evaluation after cooldown
				schedulePoll(sessionId, sessionCwd);

				logger.info("injection-delivered", {
					sessionId,
					injectionCount: state.injectionCount,
					rule: rule.name,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error(`Injection failed: ${msg}`, {
					sessionId,
					rule: rule.name,
				});
			} finally {
				markInFlight(sessionId, false);
			}
		} finally {
			markEvaluating(sessionId, false);
		}
	});

	// No context hook needed — delivery is direct via sendUserMessage/sendMessage.
	// Both APIs work in TUI and non-TUI modes.

	const sessionActiveRules: Map<string, Set<string> | null> = new Map();

	function getActiveRules(sessionId: string): EnforcerRule[] {
		const override = sessionActiveRules.get(sessionId);
		if (override === null) return config?.rules ?? [];
		if (override === undefined) return config?.rules ?? [];
		return (config?.rules ?? []).filter((rule) => override.has(rule.name));
	}

	pi.registerCommand("enforcer-status", {
		description:
			"Show todo-enforcer state and loaded rules for current session",
		handler: async (_args, ctx) => {
			const cfg = await getConfigWhenNeeded(ctx.cwd);
			const sessionId = getCachedSessionId();
			const state = getState(sessionId);
			const active = getActiveRules(sessionId);
			const allRules = cfg.rules ?? [];
			const delivery = cfg.messageDelivery ?? {};

			const baseCooldown = cfg.cooldownMs ?? 60_000;
			const currentDelay = Math.min(
				baseCooldown * (cfg.backoff?.factor ?? 2) ** state.backoffCount,
				cfg.backoff?.maxDelayMs ?? 3_600_000,
			);

			const lines: string[] = [
				`todo-enforcer: ${cfg.enabled ? "enabled" : "disabled"}`,
				`  Injections: ${state.injectionCount}/${cfg.maxInjections ?? "?"}`,
				`  Stagnation: ${state.stagnationCount}/${cfg.stagnationThreshold ?? "?"}`,
				`  Backoff: ${state.backoffCount} (delay: ${currentDelay / 1000}s, base: ${baseCooldown / 1000}s)`,
				`  In-flight: ${state.inFlight}`,
				`  Spawn in-flight: ${state.spawnInFlight}`,
				`  Poll pending: ${pollTimers.has(sessionId)}`,
				`  Cancelled: ${state.wasCancelled}`,
				`  Rules: ${active.length}/${allRules.length} active`,
				`  Delivery: mode=${delivery.mode ?? "userMessage"} display=${delivery.display ?? true} deliverAs=${delivery.deliverAs ?? "followUp"}`,
			];

			for (let i = 0; i < allRules.length; i++) {
				const rule = allRules[i];
				const isActive = active.some(
					(activeRule) => activeRule.name === rule.name,
				);
				const marker = isActive ? "●" : "○";
				const idx = String(i + 1).padStart(2, " ");
				lines.push(
					`  ${marker} ${idx}. ${rule.name}  [${rule.condition}] → ${rule.action}`,
				);
			}

			const override = sessionActiveRules.get(sessionId);
			if (override !== undefined && override !== null) {
				lines.push(
					`  (session override active — resets on /enforcer-switch reset)`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("enforcer-switch", {
		description:
			"Switch active rules for this session: /enforcer-switch <rule1,rule2,...> or /enforcer-switch reset",
		getArgumentCompletions: (prefix) => {
			const allRules = config?.rules ?? [];
			const items = allRules
				.filter((rule) => rule.name.startsWith(prefix))
				.map((rule) => ({
					value: rule.name,
					label: `${rule.name} (${rule.condition} → ${rule.action})`,
				}));
			if ("reset".startsWith(prefix)) {
				items.push({ value: "reset", label: "reset — restore all rules" });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const cfg = await getConfigWhenNeeded(ctx.cwd);
			const sessionId = getCachedSessionId();
			const trimmed = args.trim().toLowerCase();

			if (trimmed === "reset") {
				sessionActiveRules.set(sessionId, null);
				ctx.ui.notify("Rules reset to config defaults", "info");
				return;
			}

			if (!trimmed) {
				ctx.ui.notify(
					"Usage: /enforcer-switch <rule1,rule2,...> or /enforcer-switch reset",
					"warning",
				);
				return;
			}

			const allRules = cfg.rules ?? [];
			const allNames = new Set(allRules.map((rule) => rule.name.toLowerCase()));
			const requested = trimmed.split(/[\s,]+/).filter(Boolean);

			const unknown = requested.filter((name) => !allNames.has(name));
			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown rules: ${unknown.join(", ")}`, "error");
				return;
			}

			const exactNames = new Set<string>();
			for (const name of requested) {
				const found = allRules.find((rule) => rule.name.toLowerCase() === name);
				if (found) {
					exactNames.add(found.name);
				}
			}
			sessionActiveRules.set(sessionId, exactNames);
			ctx.ui.notify(
				`Active rules: ${Array.from(exactNames).join(", ")}`,
				"info",
			);
		},
	});

	pi.registerCommand("enforcer-reset", {
		description: "Reset todo-enforcer state for current session",
		handler: async (_args, ctx) => {
			const sessionId = getCachedSessionId();
			resetState(sessionId);
			sessionActiveRules.delete(sessionId);
			ctx.ui.notify("todo-enforcer state + rule override reset", "info");
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle todo-enforcer enabled/disabled",
		handler: async (ctx) => {
			const cfg = await getConfigWhenNeeded(ctx.cwd);
			config = { ...cfg, enabled: !cfg.enabled };
			ctx.ui.notify(
				`todo-enforcer: ${config.enabled ? "enabled" : "disabled"}`,
				config.enabled ? "info" : "warning",
			);
		},
	});
}
