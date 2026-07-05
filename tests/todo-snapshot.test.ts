// 
import { describe, expect, it } from "vitest";

import { buildSessionContext, buildTodoSnapshot } from "../src/todo-snapshot";

function buildBranch() {
	return [
		{
			type: "message",
			message: {
				role: "user",
				content: "Earlier request",
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: "Earlier assistant reply",
			},
		},
		{
			type: "message",
			message: {
				role: "user",
				content: "Actual latest request",
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: "Working step 1",
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				customType: "todo-enforcer",
				content: "Ignore this injected reminder",
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Working step 2" }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					tasks: [
						{ id: 1, subject: "Done", status: "completed" },
						{ id: 2, subject: "Remain", status: "in_progress" },
					],
					nextId: 3,
				},
			},
		},
	];
}

describe("buildTodoSnapshot", () => {
	it("builds counts and lists from latest todo state", () => {
		const result = buildTodoSnapshot("session-1", buildBranch);

		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(1);
		expect(result.snapshot.completedCount).toBe(1);
		expect(result.snapshot.incompleteList).toContain("#2 Remain");
		expect(result.snapshot.completedList).toContain("#1 Done");
	});

	it("populates inProgressCount distinguishing pending from in_progress (Bug D)", () => {
		const branch = () => [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "Done", status: "completed" },
							{ id: 2, subject: "Pending", status: "pending" },
							{ id: 3, subject: "Active", status: "in_progress" },
						],
						nextId: 4,
					},
				},
			},
		];

		const result = buildTodoSnapshot("session-d", branch);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(2); // pending + in_progress
		expect(result.snapshot.inProgressCount).toBe(1); // ONLY in_progress
	});

	it("returns inProgressCount=0 when all incomplete tasks are pending only", () => {
		const branch = () => [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "Waiting", status: "pending" },
							{ id: 2, subject: "Also waiting", status: "pending" },
						],
						nextId: 3,
					},
				},
			},
		];

		const result = buildTodoSnapshot("session-d2", branch);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(2);
		expect(result.snapshot.inProgressCount).toBe(0);
	});

	it("returns unavailable when todo tool is absent", () => {
		const result = buildTodoSnapshot("session-2", () => []);

		expect(result.available).toBe(false);
		expect(result.snapshot.incompleteList).toContain("no todo tool available");
	});
});

describe("buildSessionContext", () => {
	it("collects latest user, assistant messages since that user, and excludes enforcer messages", () => {
		const context = buildSessionContext("session-1", "/repo", buildBranch, {
			userMode: "latest",
			assistantMode: "allSinceLatestUser",
			includeSessionMetadata: true,
			excludePreviousEnforcerMessages: true,
		});

		expect(context.latestUserMessage).toBe("Actual latest request");
		expect(context.assistantMessages).toContain("Working step 1");
		expect(context.assistantMessages).toContain("Working step 2");
		expect(context.assistantMessages).not.toContain(
			"Ignore this injected reminder",
		);
		expect(context.allMessagesSinceLatestUser).toContain(
			"user: Actual latest request",
		);
		expect(context.allMessagesSinceLatestUser).toContain(
			"assistant: Working step 1",
		);
		expect(context.sessionMetadata).toContain('"cwd":"/repo"');
		expect(context.sessionMetadata).toContain('"sessionId":"session-1"');
	});

	it("returns only the most recent assistant message when configured", () => {
		const context = buildSessionContext("session-1", "/repo", buildBranch, {
			userMode: "latest",
			assistantMode: "mostRecent",
			includeSessionMetadata: false,
			excludePreviousEnforcerMessages: true,
		});

		expect(context.assistantMessages).toBe("Working step 2");
		expect(context.sessionMetadata).toBe("");
	});

	it("keeps enforcer messages when exclusion is disabled", () => {
		const context = buildSessionContext("session-1", "/repo", buildBranch, {
			userMode: "latest",
			assistantMode: "allSinceLatestUser",
			includeSessionMetadata: true,
			excludePreviousEnforcerMessages: false,
		});

		expect(context.assistantMessages).toContain(
			"Ignore this injected reminder",
		);
	});

	it("handles sessions without user messages", () => {
		const context = buildSessionContext(
			"session-3",
			"/repo",
			() => [
				{
					type: "message",
					message: {
						role: "assistant",
						content: 42,
					},
				},
			],
			{
				userMode: "latest",
				assistantMode: "allSinceLatestUser",
				includeSessionMetadata: true,
				excludePreviousEnforcerMessages: true,
			},
		);

		expect(context.latestUserMessage).toBe("");
		expect(context.assistantMessages).toBe("");
		expect(context.allMessagesSinceLatestUser).toBe("");
		expect(context.sessionMetadata).toContain('"latestUserIndex":-1');
	});

	// Regression: prevents recursive self-feed when delivery mode is "userMessage".
	// sendUserMessage creates a real user-role message; if buildSessionContext
	// picks it up as latestUserMessage, the next injection nests the prior one
	// inside {{latest_user_message}} and the prompt grows unboundedly.
	it("skips prior userMessage-mode enforcer injections when finding latestUserMessage", () => {
		const branch = () => [
			{
				type: "message",
				message: { role: "user", content: "Original user request: fix bug X" },
			},
			{
				type: "message",
				message: { role: "assistant", content: "Working on it" },
			},
			{
				type: "message",
				message: {
					role: "user",
					content:
						"You have incomplete tasks. Continue working on them.\n[Status: 1/3 completed]\nPick up where you left off.",
				},
			},
		];

		const context = buildSessionContext("session-loop", "/repo", branch, {
			userMode: "latest",
			assistantMode: "allSinceLatestUser",
			includeSessionMetadata: false,
			excludePreviousEnforcerMessages: true,
		});

		expect(context.latestUserMessage).toBe("Original user request: fix bug X");
	});

	it("skips user messages with customType=todo-enforcer when finding latestUserMessage", () => {
		const branch = () => [
			{
				type: "message",
				message: { role: "user", content: "Original task" },
			},
			{
				type: "message",
				message: {
					role: "user",
					customType: "todo-enforcer",
					content: "any content at all",
				},
			},
		];

		const context = buildSessionContext("session-loop-ct", "/repo", branch, {
			userMode: "latest",
			assistantMode: "allSinceLatestUser",
			includeSessionMetadata: false,
			excludePreviousEnforcerMessages: true,
		});

		expect(context.latestUserMessage).toBe("Original task");
	});

	it("still picks up prior enforcer injection as latest when exclusion is disabled", () => {
		const branch = () => [
			{
				type: "message",
				message: { role: "user", content: "Original task" },
			},
			{
				type: "message",
				message: {
					role: "user",
					content:
						"You have incomplete tasks. Continue working on them.\nPick up where you left off.",
				},
			},
		];

		const context = buildSessionContext("session-loop-off", "/repo", branch, {
			userMode: "latest",
			assistantMode: "allSinceLatestUser",
			includeSessionMetadata: false,
			excludePreviousEnforcerMessages: false,
		});

		expect(context.latestUserMessage).toContain("You have incomplete tasks");
	});
});

// ─── RED PHASE: todoSource dispatch (buildTodoSnapshot 4th param) ─────────────
// These tests rely on the NEW optional 4th `todoSource` parameter to
// buildTodoSnapshot, which is NOT YET implemented in src/todo-snapshot.ts.
// They are EXPECTED TO FAIL until the GREEN phase wires the dispatch.
import {
	readTodoProgressState,
} from "../src/todo-progress-adapter";

const TP_KEY = "todo-progress-state";

function todoProgressEntry(items: Array<{ text: string; status: string }>, extra: Record<string, unknown> = {}) {
	return {
		type: "custom",
		customType: TP_KEY,
		data: {
			version: 1,
			visible: true,
			items,
			offset: 0,
			awaitingGoalCheck: false,
			allowNextListReplacement: false,
			...extra,
		},
	};
}

function branchTodoTool() {
	return [
		{ type: "message", message: { role: "user", content: "do work" } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					tasks: [
						{ id: 1, subject: "Branch task", status: "in_progress" },
					],
					nextId: 2,
				},
			},
		},
	];
}

describe("buildTodoSnapshot — todoSource dispatch", () => {
	it("todoSource='auto' WITH todo-progress entries → uses adapter", () => {
		const branch = () => [
			...branchTodoTool(),
			todoProgressEntry([
				{ text: "TP task", status: "todo" },
				{ text: "TP done", status: "done" },
			]),
		];
		const result = buildTodoSnapshot("s", branch, undefined, "auto");
		expect(result.available).toBe(true);
		// Adapter output uses bare "- [pending] TP task" (no #id) vs branch "- [in_progress] #1 Branch task"
		expect(result.snapshot.incompleteList).toContain("TP task");
		expect(result.snapshot.incompleteList).not.toContain("Branch task");
	});

	it("todoSource='auto' WITHOUT todo-progress entries → falls back to branch parser", () => {
		const branch = () => branchTodoTool();
		const result = buildTodoSnapshot("s", branch, undefined, "auto");
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteList).toContain("Branch task");
	});

	it("todoSource='branch' → always branch parser even if todo-progress entries exist", () => {
		const branch = () => [
			...branchTodoTool(),
			todoProgressEntry([{ text: "TP task", status: "todo" }]),
		];
		const result = buildTodoSnapshot("s", branch, undefined, "branch");
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteList).toContain("Branch task");
		expect(result.snapshot.incompleteList).not.toContain("TP task");
	});

	it("todoSource='todo-progress' with entries → uses adapter", () => {
		const branch = () => [
			...branchTodoTool(),
			todoProgressEntry([{ text: "TP only", status: "todo" }]),
		];
		const result = buildTodoSnapshot("s", branch, undefined, "todo-progress");
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteList).toContain("TP only");
		expect(result.snapshot.incompleteList).not.toContain("Branch task");
	});

	it("todoSource='todo-progress' without entries → available:false", () => {
		const branch = () => branchTodoTool();
		const result = buildTodoSnapshot("s", branch, undefined, "todo-progress");
		expect(result.available).toBe(false);
	});

	it("default (no todoSource param) → 'auto' behavior (fallback to branch parser when no entries)", () => {
		const branch = () => branchTodoTool();
		const result = buildTodoSnapshot("s", branch);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteList).toContain("Branch task");
	});
});
