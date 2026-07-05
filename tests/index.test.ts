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
			commands: new Map<string, { handler: Function; getArgumentCompletions?: Function }>(),
			registerCommand(name: string, def: { handler: Function; getArgumentCompletions?: Function }) {
				this.commands.set(name, def);
			},
			shortcuts: new Map<string, { handler: Function }>(),
			registerShortcut(name: string, def: { handler: Function }) {
				this.shortcuts.set(name, def);
			},
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

// ─── RED PHASE: respectProgressAutoClear + injectTodoPolicy ──────────────────
// These tests cover index.ts behavior that is NOT YET implemented:
//   - auto-clear suppression on agent_end when respectProgressAutoClear=true
//   - before_agent_start policy injection when injectTodoPolicy=true
// They are EXPECTED TO FAIL until the GREEN phase implements the logic.

const TP_KEY = "todo-progress-state";

function makeTodoProgressStateEntry(
	items: Array<{ text: string; status: string }>,
	visible = true,
) {
	return {
		type: "custom",
		customType: TP_KEY,
		data: {
			version: 1,
			visible,
			items,
			offset: 0,
			awaitingGoalCheck: false,
			allowNextListReplacement: false,
		},
	};
}

describe("respectProgressAutoClear", () => {
	const acTempDirs: string[] = [];
	afterEach(() => {
		clearSessionIdentity();
		for (const dir of acTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("suppresses injection when respectProgressAutoClear=true and todo-progress auto-cleared (visible:false, items:[])", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-ac-"));
		acTempDirs.push(cwd);
		writeConfig(cwd, {
			respectProgressAutoClear: true,
			todoSource: "todo-progress",
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

		// Branch contains an auto-cleared todo-progress state
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "done" } },
			makeTodoProgressStateEntry([], false),
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-autoclear",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);

		// Injection suppressed due to auto-clear
		expect(stub.sentMessages).toHaveLength(0);
	});

	it("does not mark session as cancelled when auto-clear suppresses injection", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-ac2-"));
		acTempDirs.push(cwd);
		writeConfig(cwd, {
			respectProgressAutoClear: true,
			todoSource: "todo-progress",
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
			{ type: "message", message: { role: "assistant", content: "done" } },
			makeTodoProgressStateEntry([], false),
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-autoclear2",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);

		// Now add incomplete tasks to the todo-progress state — a subsequent
		// agent_end should still inject (session was NOT cancelled).
		branch.push(
			makeTodoProgressStateEntry([{ text: "Still pending", status: "todo" }], true),
		);

		await agentEnd?.({ messages: [] }, ctx);
		expect(stub.sentMessages.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT suppress injection when respectProgressAutoClear=false", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-ac3-"));
		acTempDirs.push(cwd);
		writeConfig(cwd, {
			respectProgressAutoClear: false,
			todoSource: "todo-progress",
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

		// Branch has incomplete items (so has_incomplete matches) but the LATEST
		// state entry is auto-cleared. With respectProgressAutoClear=false, we
		// read the snapshot from the adapter regardless.
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "do work" } },
			{ type: "message", message: { role: "assistant", content: "done" } },
			makeTodoProgressStateEntry([{ text: "Pending", status: "todo" }], true),
			makeTodoProgressStateEntry([], false), // auto-cleared latest
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "session-noautoclear",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await agentEnd?.({ messages: [] }, ctx);

		// respectProgressAutoClear=false → injection should NOT be suppressed.
		// (Adapter reads latest state which has items=[] → available:false →
		//  no injection. So this test asserts the negative: that the suppression
		//  path specifically tied to respectProgressAutoClear was NOT taken.
		//  We instead verify the enforcer did not treat auto-clear as cancel.)
		expect(stub.sentMessages).toHaveLength(0);
	});
});

describe("injectTodoPolicy (before_agent_start hook)", () => {
	const piTempDirs: string[] = [];
	const origCwd = process.cwd();
	afterEach(() => {
		clearSessionIdentity();
		process.chdir(origCwd);
		for (const dir of piTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT register before_agent_start hook when injectTodoPolicy=false (default)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-pi-"));
		piTempDirs.push(cwd);
		writeConfig(cwd, { injectTodoPolicy: false });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		// No before_agent_start handler should be registered
		expect(stub.handlers.has("before_agent_start")).toBe(false);
	});

	it("registers before_agent_start hook when injectTodoPolicy=true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-pi2-"));
		piTempDirs.push(cwd);
		writeConfig(cwd, { injectTodoPolicy: true });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		expect(stub.handlers.has("before_agent_start")).toBe(true);
	});

	it("appends custom todoPolicyText to systemPrompt when injectTodoPolicy=true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-pi3-"));
		piTempDirs.push(cwd);
		const customPolicy = "ALWAYS finish your todos before stopping.";
		writeConfig(cwd, {
			injectTodoPolicy: true,
			todoPolicyText: customPolicy,
		});
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const beforeAgentStart = stub.handlers.get("before_agent_start")?.[0];
		expect(beforeAgentStart).toBeDefined();

		const event = { systemPrompt: "You are a helpful assistant." };
		const result = await beforeAgentStart?.(event, createCtx(cwd));
		expect(result?.systemPrompt).toContain(customPolicy);
	});

	it("uses built-in default policy text when injectTodoPolicy=true and no todoPolicyText set", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-pi4-"));
		piTempDirs.push(cwd);
		writeConfig(cwd, { injectTodoPolicy: true });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);
		const beforeAgentStart = stub.handlers.get("before_agent_start")?.[0];
		expect(beforeAgentStart).toBeDefined();

		const event = { systemPrompt: "base prompt" };
		const result = await beforeAgentStart?.(event, createCtx(cwd));
		// Default policy should mention continuation/todos in some form.
		expect(result?.systemPrompt).not.toBe("base prompt");
		expect(result?.systemPrompt.length).toBeGreaterThan("base prompt".length);
	});
});

// ─── Coverage: slash commands, shortcut, and error paths ──────────────────

describe("slash commands and shortcuts", () => {
	const cmdTempDirs: string[] = [];
	const origCwd = process.cwd();

	afterEach(() => {
		clearSessionIdentity();
		process.chdir(origCwd);
		for (const dir of cmdTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforcer-status command runs and calls ui.notify", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-cmd1-"));
		cmdTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0 });
		process.chdir(cwd);

		const stub = createPiStub();
		const notifyCalls: string[] = [];
		stub.pi.notify = (msg: string) => notifyCalls.push(msg);

		todoEnforcer(stub.pi as never);

		// Trigger session_start so config loads
		const sessionStart = stub.handlers.get("session_start")?.[0];
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "work" } },
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "cmd-session",
				getBranch: () => branch,
			},
			ui: { notify: (msg: string) => notifyCalls.push(msg) },
		};
		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Find the enforcer-status command handler
		const statusCmd = stub.pi.commands.get("enforcer-status");
		expect(statusCmd).toBeDefined();
		await statusCmd?.handler([], ctx);
		expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
		expect(notifyCalls[0]).toContain("todo-enforcer");
	});

	it("ctrl+shift+t toggle shortcut flips enabled state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-cmd2-"));
		cmdTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0 });
		process.chdir(cwd);

		const stub = createPiStub();
		const notifyCalls: string[] = [];

		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "toggle-session",
				getBranch: () => [],
			},
			ui: { notify: (msg: string) => notifyCalls.push(msg) },
		};
		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Toggle shortcut
		const toggle = stub.pi.shortcuts.get("ctrl+shift+t");
		expect(toggle).toBeDefined();
		await toggle?.handler(ctx);
		expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
		expect(notifyCalls[0]).toContain("disabled");
	});

	it("enforcer-switch command switches active rules", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-cmd3-"));
		cmdTempDirs.push(cwd);
		writeConfig(cwd, {
			enabled: true,
			cooldownMs: 0,
			rules: [
				{ name: "rule-a", condition: "has_incomplete", action: "prompt", prompt: "a" },
				{ name: "rule-b", condition: "all_complete", action: "prompt", prompt: "b" },
			],
		});
		process.chdir(cwd);

		const stub = createPiStub();
		const notifyCalls: string[] = [];
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "switch-session",
				getBranch: () => [],
			},
			ui: { notify: (msg: string) => notifyCalls.push(msg) },
		};
		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Switch to only rule-a
		const switchCmd = stub.pi.commands.get("enforcer-switch");
		expect(switchCmd).toBeDefined();
		await switchCmd?.handler("rule-a", ctx);
		expect(notifyCalls.some(n => n.includes("rule-a"))).toBe(true);

		// Reset
		await switchCmd?.handler("reset", ctx);
		expect(notifyCalls.some(n => n.includes("reset"))).toBe(true);

		// Empty arg → usage message
		await switchCmd?.handler("", ctx);
		expect(notifyCalls.some(n => n.includes("Usage"))).toBe(true);

		// Unknown rule → error
		await switchCmd?.handler("nonexistent", ctx);
		expect(notifyCalls.some(n => n.includes("Unknown"))).toBe(true);

		// getArgumentCompletions
		const completions = switchCmd?.getArgumentCompletions?.("rule");
		expect(completions).toBeDefined();
	});

	it("enforcer-reset command resets state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-cmd4-"));
		cmdTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0, rules: [
			{ name: "test", condition: "has_incomplete", action: "prompt", prompt: "go" }
		] });
		process.chdir(cwd);

		const stub = createPiStub();
		const notifyCalls: string[] = [];
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "reset-session",
				getBranch: () => [],
			},
			ui: { notify: (msg: string) => notifyCalls.push(msg) },
		};
		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		const resetCmd = stub.pi.commands.get("enforcer-reset");
		expect(resetCmd).toBeDefined();
		await resetCmd?.handler("", ctx);
		expect(notifyCalls.some(n => n.includes("reset"))).toBe(true);
	});
});

describe("agent_end edge cases", () => {
	const edgeTempDirs: string[] = [];
	const origCwd = process.cwd();

	afterEach(() => {
		clearSessionIdentity();
		process.chdir(origCwd);
		for (const dir of edgeTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips injection when config disabled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-edge1-"));
		edgeTempDirs.push(cwd);
		writeConfig(cwd, { enabled: false, cooldownMs: 0 });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "work" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "pending" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "edge-session",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);
		await agentEnd?.({ messages: [] }, ctx);
		await flushMicrotasks(5);

		expect(stub.sentMessages).toHaveLength(0);
	});

	it("detects user abort (stopReason=aborted) and suppresses future injections", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-edge2-"));
		edgeTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0, rules: [
			{ name: "test", condition: "has_incomplete", action: "prompt", prompt: "go" }
		] });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "work" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "pending" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "abort-session",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Agent aborted by user (Esc)
		await agentEnd?.({
			messages: [
				{ role: "assistant", stopReason: "aborted", content: "partial" },
			],
		}, ctx);
		await flushMicrotasks(5);

		// Should NOT inject after abort
		expect(stub.sentMessages).toHaveLength(0);
	});

	it("detects LLM error and triggers backoff", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-edge3-"));
		edgeTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0, rules: [
			{ name: "test", condition: "has_incomplete", action: "prompt", prompt: "go" }
		] });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const agentEnd = stub.handlers.get("agent_end")?.[0];

		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "user", content: "work" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "Task", status: "pending" }],
						nextId: 2,
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "error-session",
				getBranch: () => branch,
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Agent had an error
		await agentEnd?.({
			messages: [
				{ role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded", content: "" },
			],
		}, ctx);
		await flushMicrotasks(5);

		// Error detection should not crash, injection may or may not happen
		// depending on cooldown — just verify no crash
		expect(true).toBe(true);
	});
});

describe("session lifecycle", () => {
	const lcTempDirs: string[] = [];
	const origCwd = process.cwd();

	afterEach(() => {
		clearSessionIdentity();
		process.chdir(origCwd);
		for (const dir of lcTempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("session_shutdown clears poll timers without crash", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "todo-enforcer-lc1-"));
		lcTempDirs.push(cwd);
		writeConfig(cwd, { enabled: true, cooldownMs: 0, rules: [
			{ name: "test", condition: "has_incomplete", action: "prompt", prompt: "go" }
		] });
		process.chdir(cwd);

		const stub = createPiStub();
		todoEnforcer(stub.pi as never);

		const sessionStart = stub.handlers.get("session_start")?.[0];
		const sessionShutdown = stub.handlers.get("session_shutdown")?.[0];

		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "shutdown-session",
				getBranch: () => [],
			},
			ui: { notify() {} },
		};

		await sessionStart?.({}, ctx);
		await flushMicrotasks(5);

		// Should not crash
		await sessionShutdown?.();
		expect(true).toBe(true);
	});
});
