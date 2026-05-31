// @ts-nocheck
// 
import { describe, expect, it, vi } from "vitest";

import {
	evaluateCondition,
	getRegisteredConditions,
	registerCondition,
} from "../src/conditions";

const snapshot = {
	incompleteCount: 1,
	inProgressCount: 1,
	completedCount: 2,
	totalCount: 3,
	incompleteList: "- [pending] #1 Task",
	completedList: "- [completed] #2 Done",
	sessionSummary: "session-1",
	latestUserMessage: "Need status",
	assistantMessages: "Working",
	allMessagesSinceLatestUser: "user: Need status\nassistant: Working",
	sessionMetadata: '{"cwd":"/repo"}',
};

describe("conditions", () => {
	it("evaluates built-in conditions", () => {
		expect(evaluateCondition("has_incomplete", snapshot)).toBe(true);
		expect(evaluateCondition("has_in_progress", snapshot)).toBe(true);
		expect(evaluateCondition("all_complete", snapshot)).toBe(false);
		expect(evaluateCondition("always", snapshot)).toBe(true);
		expect(evaluateCondition("none", snapshot)).toBe(false);
	});

	it("has_in_progress distinguishes in_progress from pending only (Bug D)", () => {
		// Snapshot with ONLY pending tasks — no in_progress
		const pendingOnly = {
			...snapshot,
			incompleteCount: 2,
			inProgressCount: 0,
		};
		expect(evaluateCondition("has_incomplete", pendingOnly)).toBe(true);
		expect(evaluateCondition("has_in_progress", pendingOnly)).toBe(false);

		// Snapshot with at least one in_progress task
		const withInProgress = {
			...snapshot,
			incompleteCount: 2,
			inProgressCount: 1,
		};
		expect(evaluateCondition("has_incomplete", withInProgress)).toBe(true);
		expect(evaluateCondition("has_in_progress", withInProgress)).toBe(true);

		// Snapshot with 0 incomplete
		const allDone = {
			...snapshot,
			incompleteCount: 0,
			inProgressCount: 0,
		};
		expect(evaluateCondition("has_incomplete", allDone)).toBe(false);
		expect(evaluateCondition("has_in_progress", allDone)).toBe(false);
	});

	it("allows custom conditions and lists them", () => {
		registerCondition("needs_attention", (s) => s.incompleteCount >= 1);

		expect(evaluateCondition("needs_attention", snapshot)).toBe(true);
		expect(getRegisteredConditions()).toContain("needs_attention");
	});

	it("handles throwing and unknown conditions", () => {
		registerCondition("broken_condition", () => {
			throw new Error("boom");
		});

		expect(evaluateCondition("broken_condition", snapshot)).toBe(false);
		expect(evaluateCondition("missing_condition", snapshot)).toBe(false);
	});
});
