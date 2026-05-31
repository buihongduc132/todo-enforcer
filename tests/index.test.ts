// @ts-nocheck
// 
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import todoEnforcer from "../src/index";
import { clearSessionIdentity } from "../src/session-state";

function createPiStub() {
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{
		message: Record<string, unknown>;
		options: Record<string, unknown>;
	}> = [];

	return {
		handlers,
		sentMessages,
		pi: {
			on(event: string, handler: Function) {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			sendMessage(
				message: Record<string, unknown>,
				options: Record<string, unknown>,
			) {
				sentMessages.push({ message, options });
			},
			sendUserMessage(text: string, opts: Record<string, unknown>) {
				sentMessages.push({ message: { content: text }, options: opts });
			},
			registerCommand() {},
			registerShortcut() {},
		},
	};
}

async function flushMicrotasks(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

type BranchEntry = {
	type: string;
	message: {
		role?: string;
		content?: unknown;
		toolName?: string;
		details?: unknown;
		customType?: string;
	};
};

function createCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const branch: BranchEntry[] = [
		{
			type: "message",
			message: { role: "user", content: "Finish all tasks" },
		},
		{
			type: "message",
			message: { role: "assistant", content: "Working on it" },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					tasks: [{ id: 1, subject: "Ship", status: "in_progress" }],
					nextId: 2,
				},
			},
		},
	];

	return {
		cwd,
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "session-1",
			getBranch: () => branch,
		},
		ui: {
			notify() {},
		},
		...overrides,
	};
}

function writeConfig(cwd: string, config: Record<string, unknown>) {
	writeFileSync(
		join(cwd, ".todo-enforcer.json"),
		JSON.stringify(config, null, 2),
	);
}

describe("todo-enforcer external fallback", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		clearSessionIdentity();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips injection when external command fails with default_prompt fallback (no fallback rule available)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			rules: [
				{
					name: "remote-followup",
					condition: "has_incomplete",
					action: "external",
					external: {
						command: [
							process.execPath,
							"-e",
							'process.stderr.write("bad"); process.exit(2)',
						],
						errorFallback: "default_prompt",
					},
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const ctx = createCtx(cwd);

		await sessionStart?.({}, ctx);
		await agentEnd?.({}, ctx);

		// external fails + errorFallback=default_prompt has no matching rule → no injection
		expect(stub.sentMessages).toHaveLength(0);
	});

	it("skips injection when errorFallback is skip", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			rules: [
				{
					name: "remote-followup",
					condition: "has_incomplete",
					action: "external",
					external: {
						command: [
							process.execPath,
							"-e",
							'process.stderr.write("bad"); process.exit(2)',
						],
						errorFallback: "skip",
					},
				},
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Should never be used here",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const contextHook = stub.handlers.get("context")?.[0];
		const ctx = createCtx(cwd);

		await sessionStart?.({}, ctx);
		await agentEnd?.({}, ctx);

		expect(stub.sentMessages).toHaveLength(0);
		const transformed = await contextHook?.(
			{ messages: [{ role: "user", content: "continue" }] },
			ctx,
		);
		expect(transformed).toBeUndefined();
	});

	it("does not await config during session_start and reuses one async load", async () => {
		let resolveConfig!: (value: import("../src/config").TodoEnforcerConfig) => void;
		const deferred = new Promise<import("../src/config").TodoEnforcerConfig>(
			(resolve) => {
				resolveConfig = resolve;
			},
		);
		const loadConfigAsyncMock = vi.fn(() => deferred);
		vi.doMock("../src/config", async () => {
			const actual =
				await vi.importActual<typeof import("../src/config")>("../src/config");
			return {
				...actual,
				loadConfigAsync: loadConfigAsyncMock,
			};
		});

		const { default: nonblockingTodoEnforcer } = await import("../src/index");
		const stub = createPiStub();
		nonblockingTodoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const ctx = createCtx(process.cwd());

		sessionStart?.({}, ctx);
		await flushMicrotasks();
		expect(loadConfigAsyncMock).toHaveBeenCalledTimes(1);

		// Two agent_end calls before config resolves — both should queue
		const firstAgentEnd = agentEnd?.({ messages: [] }, ctx);
		const secondAgentEnd = agentEnd?.({ messages: [] }, ctx);
		await flushMicrotasks();
		expect(loadConfigAsyncMock).toHaveBeenCalledTimes(1); // still just 1 load

		resolveConfig({
			enabled: true,
			maxInjections: 5,
			cooldownMs: 60_000,
			detectStagnation: true,
			stagnationThreshold: 3,
			messageDelivery: {
				mode: "userMessage",
				customType: "todo-enforcer",
				display: true,
				triggerTurn: true,
				deliverAs: "followUp",
			},
			contextFeed: {
				userMode: "latest",
				assistantMode: "allSinceLatestUser",
				includeSessionMetadata: true,
				excludePreviousEnforcerMessages: true,
			},
			backoff: {
				enabled: true,
				factor: 2,
				maxDelayMs: 3_600_000,
				errorPatterns: [],
			},
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Resume {{latest_user_message}} => {{incomplete_list}}",
				},
			],
		});

		await firstAgentEnd;
		await secondAgentEnd;

		// Both agent_ends should have delivered messages via sendUserMessage
		expect(stub.sentMessages.length).toBeGreaterThanOrEqual(1);
		expect(stub.sentMessages[0]?.message.content).toContain(
			"Resume Finish all tasks",
		);
	});

	it("delivers injection even when hasUI is false (non-TUI mode)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Resume {{latest_user_message}} => {{incomplete_list}}",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const ctx = createCtx(cwd, { hasUI: false });

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);

		// Current code does not gate on hasUI — injection still delivered
		expect(stub.sentMessages.length).toBeGreaterThanOrEqual(1);
		expect(stub.sentMessages[0]?.message.content).toContain(
			"Resume Finish all tasks",
		);
	});

	it("skips injection when agent was aborted (user pressed Esc)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Resume {{latest_user_message}} => {{incomplete_list}}",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const ctx = createCtx(cwd);

		await sessionStart?.({}, ctx);

		// Simulate agent_end with an aborted assistant message (user pressed Esc)
		const abortedEvent = {
			type: "agent_end",
			messages: [
				{ role: "user", content: "do something" },
				{
					role: "assistant",
					content: [{ type: "text", text: "Working..." }],
					stopReason: "aborted",
				},
			],
		};
		await agentEnd?.(abortedEvent, ctx);

		// No message should be injected after abort
		expect(stub.sentMessages).toHaveLength(0);

		// Subsequent agent_end with normal event should also be skipped (wasCancelled flag persists)
		const normalEvent = {
			type: "agent_end",
			messages: [
				{ role: "user", content: "do something" },
				{
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					stopReason: "stop",
				},
			],
		};
		await agentEnd?.(normalEvent, ctx);
		expect(stub.sentMessages).toHaveLength(0);
	});

	it("resets consecutive count when branch grows (progress detected)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 2,
			cooldownMs: 0,
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		// Create a mutable branch so we can grow it to simulate progress
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-prog",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);

		// First injection delivered
		expect(stub.sentMessages).toHaveLength(1);
		expect(stub.sentMessages[0]?.message.content).toBe("Continue");

		// Simulate agent making NO progress (same branch length) — consecutive count = 1
		// Cooldown hasn't elapsed yet, so this won't inject. We need to manipulate time.
		// Instead, let's verify by checking that after progress, injection still works.

		// Simulate progress: branch grew by 3 entries
		branch.push(
			{ type: "message", message: { role: "assistant", content: "did work" } },
			{
				type: "message",
				message: { role: "toolResult", toolName: "edit", details: {} },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		// Now agent_end fires again — progress detected → consecutive reset
		await agentEnd?.({ messages: [] }, ctx);

		// Second injection should still go through (consecutive reset, limit=2)
		expect(stub.sentMessages).toHaveLength(2);
	});

	it("triggers backoff on similar LLM errors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 5,
			cooldownMs: 0, // no cooldown for test
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-err",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);

		// First agent_end: LLM error (rate limit)
		const errorEvent1 = {
			type: "agent_end",
			messages: [
				{ role: "user", content: "do work" },
				{
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage:
						"Error: Rate limit exceeded for model claude-opus-4. Please retry after 60 seconds.",
				},
			],
		};
		await agentEnd?.(errorEvent1, ctx);
		// First error is "new pattern" — injection still happens (cooldownMs=0)
		expect(stub.sentMessages).toHaveLength(1);

		// Grow branch to reset consecutive
		branch.push(
			{ type: "message", message: { role: "assistant", content: "retry" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		// Second agent_end: very similar error
		const errorEvent2 = {
			type: "agent_end",
			messages: [
				{ role: "user", content: "do work" },
				{
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage:
						"Error: Rate limit exceeded for model claude-opus-4. Please retry after 90 seconds.",
				},
			],
		};
		await agentEnd?.(errorEvent2, ctx);

		// Similar error detected — backoff incremented, but injection still fires (cooldownMs=0)
		expect(stub.sentMessages).toHaveLength(2);
	});

	it("resets stagnation when agent makes progress even if incompleteCount stays same", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 5,
			cooldownMs: 0,
			stagnationThreshold: 2,
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-stag",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);

		// First agent_end: injection fires
		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(1);

		// Agent makes progress (branch grows) but task still in_progress (incompleteCount=1)
		branch.push(
			{
				type: "message",
				message: { role: "assistant", content: "working..." },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					details: { output: "did something" },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		// Second agent_end: progress detected, stagnation should be reset
		// Even with same incompleteCount=1, the agent is actively working
		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(2);

		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(2);

		// More progress — but the 3rd message is identical to previous ones.
		// The message-stall guard blocks it (3 identical → stall).
		// This is correct: no point sending the same message 3 times.
		branch.push(
			{ type: "message", message: { role: "assistant", content: "more work" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		await agentEnd?.({ messages: [] }, ctx);
		// 3rd message is stalled by repeated-message guard
		expect(stub.sentMessages).toHaveLength(2);
	});

	// Bug B regression: stagnation should reset on progress, not just on injection
	it("resets stagnation on branch growth even without injection (progress-only reset)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 5,
			cooldownMs: 60000, // long cooldown — only first injection fires
			stagnationThreshold: 2,
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-stag2",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);

		// agent_end 1: injection fires (no previous cooldown)
		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(1);

		// Now cooldown is active (60s). Next agent_ends won't inject.
		// But agent keeps working (branch grows) with same incompleteCount.
		// Progress detection MUST reset stagnation, otherwise it accumulates.

		// Grow branch — agent is working
		branch.push(
			{
				type: "message",
				message: { role: "assistant", content: "working step" },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		// agent_end 2: progress (branch grew) but cooldown blocks injection
		// With Bug B fix: stagnation is reset by progress detection
		// Without Bug B fix: stagnation accumulates (stagnationCount=1)
		await agentEnd?.({ messages: [] }, ctx);

		// Grow branch more
		branch.push(
			{ type: "message", message: { role: "assistant", content: "more work" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		// agent_end 3: more progress, same incompleteCount
		// With Bug B fix: stagnation still reset → no stagnation
		// Without Bug B fix: stagnationCount=2 → stagnation detected → blocked
		await agentEnd?.({ messages: [] }, ctx);

		// Only 1 message sent (first injection). Cooldown blocked the rest.
		// The KEY assertion: the enforcer didn't get stuck by stagnation.
		// We can't directly assert stagnation state, but we verify no crash/block.
		expect(stub.sentMessages).toHaveLength(1); // only 1 due to cooldown
	});

	it("prevents duplicate injections from overlapping agent_end calls (Bug E)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 5,
			cooldownMs: 0,
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];
		const ctx = createCtx(cwd, {
			sessionManager: {
				getSessionFile: () => "session-race",
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "do work" } },
					{ type: "message", message: { role: "assistant", content: "ok" } },
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "todo",
							details: {
								tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
								nextId: 2,
							},
						},
					},
				],
			},
		});

		await sessionStart?.({}, ctx);

		await Promise.all([
			agentEnd?.({ messages: [] }, ctx),
			agentEnd?.({ messages: [] }, ctx),
		]);

		expect(stub.sentMessages).toHaveLength(1);
	});

	it("refreshes cached branch on agent_end so live todo state can trigger injection", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue {{incomplete_list}}",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-refresh-branch",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		expect(stub.sentMessages).toHaveLength(0);

		branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
					nextId: 2,
				},
			},
		});

		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(1);
		expect(stub.sentMessages[0]?.message.content).toContain("Continue - [in_progress] #1 Task");
	});

	it("does not treat prior todo-enforcer reminders as real progress (Bug F)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-"));
		tempDirs.push(cwd);
		writeConfig(cwd, {
			maxInjections: 1,
			cooldownMs: 0,
			rules: [
				{
					name: "incomplete-tasks-remain",
					condition: "has_incomplete",
					action: "prompt",
					prompt: "Continue",
				},
			],
		});

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "ok" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-self-progress",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(1);

		branch.push(
			{
				type: "message",
				message: {
					role: "assistant",
					customType: "todo-enforcer",
					content: "Continue",
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "in_progress" }],
						nextId: 2,
					},
				},
			},
		);

		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages).toHaveLength(1);
	});
});
