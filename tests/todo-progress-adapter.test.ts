// Tests for todo-progress-adapter.
// Pins the contract described in the spec.
// (RED phase written first by separate teammate, then GREEN implementation.)
import { describe, expect, it } from "vitest";

import {
	TODO_PROGRESS_STATE_KEY,
	buildSnapshotFromTodoProgress,
	detectAutoClear,
	hasTodoProgressEntries,
	readTodoProgressState,
} from "../src/todo-progress-adapter";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a single todo-progress-state branch entry in the "custom type" shape. */
function stateEntry(state: Record<string, unknown>) {
	return {
		type: "custom",
		customType: TODO_PROGRESS_STATE_KEY,
		data: state,
	};
}

/** A minimal valid version-1 state. */
function v1State(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		visible: true,
		items: [],
		offset: 0,
		awaitingGoalCheck: false,
		allowNextListReplacement: false,
		...overrides,
	};
}

// ─── readTodoProgressState ────────────────────────────────────────────────────

describe("readTodoProgressState", () => {
	it("finds the latest state entry from the branch", () => {
		const branch = () => [
			stateEntry(v1State({ items: [{ text: "old", status: "done" }] })),
			stateEntry(
				v1State({ items: [{ text: "new", status: "todo" }] }),
			),
		];

		const state = readTodoProgressState(branch);
		expect(state).not.toBeNull();
		expect(state?.items[0]?.text).toBe("new");
	});

	it("returns null when no todo-progress-state entries are present", () => {
		const branch = () => [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", content: "yo" } },
		];

		expect(readTodoProgressState(branch)).toBeNull();
	});

	it("returns null on empty branch", () => {
		expect(readTodoProgressState(() => [])).toBeNull();
	});

	it("returns null when version is 2 (version mismatch)", () => {
		const branch = () => [
			stateEntry({
				version: 2,
				visible: true,
				items: [],
				offset: 0,
				awaitingGoalCheck: false,
				allowNextListReplacement: false,
			}),
		];

		expect(readTodoProgressState(branch)).toBeNull();
	});

	it("skips entries with malformed data and finds a later valid one", () => {
		const branch = () => [
			stateEntry({ not: "a state" }),
			stateEntry(v1State({ items: [{ text: "good", status: "todo" }] })),
		];

		const state = readTodoProgressState(branch);
		expect(state).not.toBeNull();
		expect(state?.items[0]?.text).toBe("good");
	});

	it("parses stringified JSON data payloads", () => {
		const branch = () => [
			{
				type: "custom",
				customType: TODO_PROGRESS_STATE_KEY,
				data: JSON.stringify(
					v1State({ items: [{ text: "from-string", status: "todo" }] }),
				),
			},
		];

		const state = readTodoProgressState(branch);
		expect(state).not.toBeNull();
		expect(state?.items[0]?.text).toBe("from-string");
	});

	it("returns the latest entry when multiple are present (scans from end)", () => {
		const branch = () => [
			stateEntry(v1State({ goal: "first" })),
			stateEntry(v1State({ goal: "second" })),
			stateEntry(v1State({ goal: "third" })),
		];

		const state = readTodoProgressState(branch);
		expect(state?.goal).toBe("third");
	});
});

// ─── buildSnapshotFromTodoProgress ───────────────────────────────────────────

describe("buildSnapshotFromTodoProgress", () => {
	it("maps todo→pending and done→completed with correct counts (spec scenario)", () => {
		const state = v1State({
			items: [
				{ text: "Write tests", status: "todo" },
				{ text: "Run tests", status: "done" },
			],
		});

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(1);
		expect(result.snapshot.completedCount).toBe(1);
		expect(result.snapshot.totalCount).toBe(2);
		expect(result.snapshot.incompleteList).toContain("Write tests");
		expect(result.snapshot.incompleteList).toContain("- [pending]");
	});

	it("maps partial status to in_progress (spec scenario)", () => {
		const state = v1State({
			items: [{ text: "Halfway task", status: "partial" }],
		});

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.available).toBe(true);
		expect(result.snapshot.inProgressCount).toBe(1);
		expect(result.snapshot.incompleteCount).toBe(1);
		expect(result.snapshot.incompleteList).toContain("in_progress");
	});

	it("builds incompleteList and completedList with the correct items", () => {
		const state = v1State({
			items: [
				{ text: "Task A", status: "todo" },
				{ text: "Task B", status: "partial" },
				{ text: "Task C", status: "done" },
				{ text: "Task D", status: "done" },
			],
		});

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(2); // todo + partial
		expect(result.snapshot.inProgressCount).toBe(1); // partial only
		expect(result.snapshot.completedCount).toBe(2);
		expect(result.snapshot.totalCount).toBe(4);
		expect(result.snapshot.incompleteList).toContain("Task A");
		expect(result.snapshot.incompleteList).toContain("Task B");
		expect(result.snapshot.incompleteList).not.toContain("Task C");
		expect(result.snapshot.completedList).toContain("Task C");
		expect(result.snapshot.completedList).toContain("Task D");
	});

	it("returns available:false when items is empty (spec scenario)", () => {
		const state = v1State({ items: [] });

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.available).toBe(false);
		expect(result.snapshot.totalCount).toBe(0);
		expect(result.snapshot.incompleteCount).toBe(0);
	});

	it("returns available:false when state is null", () => {
		const result = buildSnapshotFromTodoProgress(null);
		expect(result.available).toBe(false);
		expect(result.snapshot.incompleteCount).toBe(0);
		expect(result.snapshot.completedCount).toBe(0);
		expect(result.snapshot.totalCount).toBe(0);
	});

	it("uses goal as sessionSummary when present", () => {
		const state = v1State({
			goal: "Ship the feature",
			items: [{ text: "task", status: "todo" }],
		});

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.snapshot.sessionSummary).toBe("Ship the feature");
	});

	it("merges provided context fields into the snapshot", () => {
		const state = v1State({ items: [{ text: "x", status: "todo" }] });
		const result = buildSnapshotFromTodoProgress(state, {
			latestUserMessage: "do the thing",
		});
		expect(result.snapshot.latestUserMessage).toBe("do the thing");
	});

	it("treats unknown statuses as pending (fallback mapping)", () => {
		const state = v1State({
			items: [{ text: "Weird", status: "unknown-status" }],
		});

		const result = buildSnapshotFromTodoProgress(state);
		expect(result.available).toBe(true);
		expect(result.snapshot.incompleteCount).toBe(1);
		expect(result.snapshot.inProgressCount).toBe(0);
	});
});

// ─── detectAutoClear ──────────────────────────────────────────────────────────

describe("detectAutoClear", () => {
	it("returns true when visible:false AND items:[]", () => {
		const state = v1State({ visible: false, items: [] });
		expect(detectAutoClear(state)).toBe(true);
	});

	it("returns false when items exist (even if visible:false)", () => {
		const state = v1State({
			visible: false,
			items: [{ text: "leftover", status: "todo" }],
		});
		expect(detectAutoClear(state)).toBe(false);
	});

	it("returns false when visible:true and items empty", () => {
		const state = v1State({ visible: true, items: [] });
		expect(detectAutoClear(state)).toBe(false);
	});

	it("returns false when state is null", () => {
		expect(detectAutoClear(null)).toBe(false);
	});
});

// ─── hasTodoProgressEntries ──────────────────────────────────────────────────

describe("hasTodoProgressEntries", () => {
	it("returns true when branch has todo-progress-state entries", () => {
		const branch = () => [
			{ type: "message", message: { role: "user", content: "hi" } },
			stateEntry(v1State()),
		];
		expect(hasTodoProgressEntries(branch)).toBe(true);
	});

	it("returns false when branch has no todo-progress-state entries", () => {
		const branch = () => [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "assistant", content: "yo" } },
		];
		expect(hasTodoProgressEntries(branch)).toBe(false);
	});

	it("returns false on empty branch", () => {
		expect(hasTodoProgressEntries(() => [])).toBe(false);
	});

	it("detects nested message.customType entries", () => {
		const branch = () => [
			{
				type: "message",
				message: {
					customType: TODO_PROGRESS_STATE_KEY,
					data: v1State(),
				},
			},
		];
		expect(hasTodoProgressEntries(branch)).toBe(true);
	});
});
