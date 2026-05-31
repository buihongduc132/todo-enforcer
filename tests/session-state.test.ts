// @ts-nocheck
// 
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildTrigramSet,
	setSessionState,
	checkSimilarError,
	clearSessionIdentity,
	getCachedBranch,
	getCachedSessionId,
	getCtxAccessCount,
	getState,
	hasProgress,
	incrementBackoff,
	isCooldownElapsed,
	isUnderConsecutiveLimit,
	markCancelled,
	markInFlight,
	markInjection,
	markRecovering,
	markRecoveryComplete,
	recordBranchLength,
	resetAll,
	resetBackoff,
	resetConsecutive,
	resetCtxAccessCount,
	resetStagnation,
	resetState,
	trackStagnation,
	trigramSimilarity,
} from "../src/session-state";

describe("session-state", () => {
	beforeEach(() => {
		resetAll();
		clearSessionIdentity();
		vi.useRealTimers();
	});

	it("creates default state lazily and can reset per session", () => {
		const state = getState("s1");
		expect(state.injectionCount).toBe(0);
		expect(state.consecutiveCount).toBe(0);
		expect(state.wasCancelled).toBe(false);

		markInFlight("s1", true);
		expect(getState("s1").inFlight).toBe(true);

		resetState("s1");
		expect(getState("s1").inFlight).toBe(false);
	});

	it("tracks injections, limits, cancellation, and recovery flags", () => {
		expect(isUnderConsecutiveLimit("s1", 1)).toBe(true);
		markInjection("s1");
		expect(getState("s1").injectionCount).toBe(1);
		expect(getState("s1").consecutiveCount).toBe(1);
		expect(isUnderConsecutiveLimit("s1", 1)).toBe(false);

		markRecovering("s1");
		expect(getState("s1").isRecovering).toBe(true);
		markRecoveryComplete("s1");
		expect(getState("s1").isRecovering).toBe(false);

		markCancelled("s1");
		expect(getState("s1").wasCancelled).toBe(true);
		expect(getState("s1").inFlight).toBe(false);
		expect(getState("s1").consecutiveCount).toBe(0);
	});

	it("applies cooldown and backoff timing", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		expect(isCooldownElapsed("s1", 1000)).toBe(true);
		markInjection("s1");
		expect(isCooldownElapsed("s1", 1000)).toBe(false);

		incrementBackoff("s1");
		vi.advanceTimersByTime(1500);
		expect(
			isCooldownElapsed("s1", 1000, {
				enabled: true,
				factor: 2,
				maxDelayMs: 5000,
			}),
		).toBe(false);

		vi.advanceTimersByTime(600);
		expect(
			isCooldownElapsed("s1", 1000, {
				enabled: true,
				factor: 2,
				maxDelayMs: 5000,
			}),
		).toBe(true);

		resetBackoff("s1");
		expect(getState("s1").backoffCount).toBe(0);
	});

	it("tracks stagnation and can reset it", () => {
		expect(trackStagnation("s1", 3, 2)).toBe(false);
		expect(trackStagnation("s1", 3, 2)).toBe(false);
		expect(trackStagnation("s1", 3, 2)).toBe(true);

		resetStagnation("s1");
		expect(getState("s1").stagnationCount).toBe(0);
		expect(trackStagnation("s1", 2, 1)).toBe(false);
	});

	it("resetStagnation resets baseline so same-count starts fresh", () => {
		// Fill up stagnation with count=3
		expect(trackStagnation("s1", 3, 3)).toBe(false); // 0→null→0, save 3
		expect(trackStagnation("s1", 3, 3)).toBe(false); // 1
		expect(trackStagnation("s1", 3, 3)).toBe(false); // 2
		expect(trackStagnation("s1", 3, 3)).toBe(true); // 3 ≥ 3

		// Reset (e.g. after injection)
		resetStagnation("s1");

		// Same count=3 should NOT immediately stagnate — baseline was cleared
		expect(trackStagnation("s1", 3, 3)).toBe(false); // fresh start
		expect(trackStagnation("s1", 3, 3)).toBe(false); // 1
		expect(trackStagnation("s1", 3, 3)).toBe(false); // 2
		expect(trackStagnation("s1", 3, 3)).toBe(true); // 3
	});

	// ── Consecutive injection tracking ──────────────────────────────────────

	describe("consecutive injection count", () => {
		it("increments on injection and resets on resetConsecutive", () => {
			markInjection("s1");
			markInjection("s1");
			expect(getState("s1").consecutiveCount).toBe(2);

			resetConsecutive("s1");
			expect(getState("s1").consecutiveCount).toBe(0);
			expect(getState("s1").injectionCount).toBe(2); // total unchanged
		});

		it("resets consecutive on cancellation", () => {
			markInjection("s1");
			markInjection("s1");
			expect(getState("s1").consecutiveCount).toBe(2);

			markCancelled("s1");
			expect(getState("s1").consecutiveCount).toBe(0);
		});

		it("isUnderConsecutiveLimit gates on consecutive, not total", () => {
			markInjection("s1");
			markInjection("s1");
			markInjection("s1");
			expect(getState("s1").injectionCount).toBe(3);
			expect(getState("s1").consecutiveCount).toBe(3);
			expect(isUnderConsecutiveLimit("s1", 3)).toBe(false);

			resetConsecutive("s1");
			expect(isUnderConsecutiveLimit("s1", 3)).toBe(true);
			// Even though total is 3, consecutive is 0
		});
	});

	// ── Branch length / progress detection ──────────────────────────────────

	describe("branch progress detection", () => {
		it("detects no progress when branch is same length", () => {
			recordBranchLength("s1", 10);
			expect(hasProgress("s1", 10)).toBe(false);
			expect(hasProgress("s1", 9)).toBe(false);
		});

		it("detects progress when branch grew", () => {
			recordBranchLength("s1", 10);
			expect(hasProgress("s1", 12)).toBe(true);
			expect(hasProgress("s1", 11)).toBe(true);
		});

		it("returns false when no branch length recorded yet", () => {
			expect(hasProgress("s1", 100)).toBe(false);
		});
	});

	// ── Fuzzy error detection ───────────────────────────────────────────────

	describe("trigram fuzzy error matching", () => {
		it("builds trigrams correctly", () => {
			const set = buildTrigramSet("abc");
			expect(set).toContain("abc");
		});

		it("computes similarity between identical strings as 1", () => {
			const a = buildTrigramSet(
				"Error: rate limit exceeded for model claude-opus",
			);
			const b = buildTrigramSet(
				"Error: rate limit exceeded for model claude-opus",
			);
			expect(trigramSimilarity(a, b)).toBe(1);
		});

		it("detects 95%+ similar errors as similar", () => {
			// Long messages that differ only in a tiny suffix
			const err1 =
				"Error: Rate limit exceeded for model claude-opus-4-20250514. Your organization has exceeded the allowed quota. Please retry after 60 seconds.";
			const err2 =
				"Error: Rate limit exceeded for model claude-opus-4-20250514. Your organization has exceeded the allowed quota. Please retry after 90 seconds.";

			const result1 = checkSimilarError("s1", err1);
			expect(result1.isSimilar).toBe(false);

			const result2 = checkSimilarError("s1", err2);
			expect(result2.isSimilar).toBe(true);
			expect(result2.similarCount).toBe(2);
		});

		it("treats different errors as new pattern", () => {
			checkSimilarError("s1", "Error: Rate limit exceeded");
			const result = checkSimilarError(
				"s1",
				"Error: Connection timeout to database host",
			);
			expect(result.isSimilar).toBe(false);
			expect(result.similarCount).toBe(1);
		});

		it("resets similar count on new error pattern", () => {
			const err1 =
				"Error: 429 rate limit exceeded for model claude-opus on request 1";
			const err2 =
				"Error: 429 rate limit exceeded for model claude-opus on request 2";
			checkSimilarError("s1", err1);
			checkSimilarError("s1", err2);
			expect(getState("s1").similarErrorCount).toBe(2);

			const result = checkSimilarError(
				"s1",
				"Something completely different happened",
			);
			expect(result.isSimilar).toBe(false);
			expect(result.similarCount).toBe(1);
		});
	});

	// ── Stale-ctx caching (RED phase) ────────────────────────────────────────────

	describe("stale-ctx session identity caching", () => {
		function createMockCtx(overrides?: {
			sessionFile?: string | null | undefined;
			branch?: unknown[];
		}) {
			let accessCount = 0;
			const ctx = {
				sessionManager: {
					getSessionFile: () => {
						accessCount++;
						if (overrides && "sessionFile" in overrides) {
							return overrides.sessionFile as
								| string
								| null
								| undefined;
						}
						return "ses_abc123";
					},
					getBranch: () => {
						accessCount++;
						return overrides?.branch ?? [];
					},
				},
				get accessCount() {
					return accessCount;
				},
			};
			return ctx;
		}

		it("returns 'ephemeral' before any capture", () => {
			expect(getCachedSessionId()).toBe("ephemeral");
		});

		it("returns empty branch before any capture", () => {
			expect(getCachedBranch()).toEqual([]);
		});

		it("caches sessionId from ctx and does NOT re-access ctx.sessionManager", () => {
			const ctx = createMockCtx({ sessionFile: "ses_test456" });
			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());

			// Record access count after capture
			resetCtxAccessCount();

			// getCachedSessionId should return cached value WITHOUT calling ctx again
			const sessionId = getCachedSessionId();
			expect(sessionId).toBe("ses_test456");

			// THIS IS THE KEY TEST FOR RED:
			// The current broken implementation re-reads ctx.sessionManager,
			// so accessCount > 0. The fix will cache, making accessCount === 0.
			// For RED, we expect this to FAIL (accessCount will be > 0).
			expect(getCtxAccessCount()).toBe(0);
		});

		it("caches branch from ctx and does NOT re-access ctx.sessionManager", () => {
			const branch = [
				{ type: "message", message: { role: "user" } },
				{ type: "message", message: { role: "assistant" } },
			];
			const ctx = createMockCtx({
				sessionFile: "ses_branch_test",
				branch,
			});
			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());

			resetCtxAccessCount();

			// getCachedBranch should return cached branch WITHOUT calling ctx again
			const cached = getCachedBranch();
			expect(cached).toEqual(branch);

			// RED: current impl re-reads ctx, so accessCount > 0
			expect(getCtxAccessCount()).toBe(0);
		});

		it("clearSessionIdentity resets to safe defaults", () => {
			const ctx = createMockCtx({
				sessionFile: "ses_to_clear",
				branch: [{ type: "message" }],
			});
			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());

			clearSessionIdentity();

			expect(getCachedSessionId()).toBe("ephemeral");
			expect(getCachedBranch()).toEqual([]);
		});

		it("still returns correct values after capture even if ctx is destroyed", () => {
			let _destroyed = false;
			const ctx = createMockCtx({ sessionFile: "ses_survive" });

			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());
			resetCtxAccessCount();

			// Simulate ctx going stale (e.g., session replacement)
			_destroyed = true;

			// The cached value must survive without re-accessing ctx
			const sessionId = getCachedSessionId();
			expect(sessionId).toBe("ses_survive");

			// RED: broken impl would need to re-access ctx, which is stale
			expect(getCtxAccessCount()).toBe(0);
		});

		it("handles null getSessionFile gracefully", () => {
			const ctx = createMockCtx({ sessionFile: null as unknown as string });
			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());

			resetCtxAccessCount();

			const sessionId = getCachedSessionId();
			expect(sessionId).toBe("ephemeral");
			expect(getCtxAccessCount()).toBe(0);
		});

		it("handles undefined getSessionFile gracefully", () => {
			const ctx = createMockCtx({
				sessionFile: undefined as unknown as string,
			});
			setSessionState(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch());

			resetCtxAccessCount();

			const sessionId = getCachedSessionId();
			expect(sessionId).toBe("ephemeral");
			expect(getCtxAccessCount()).toBe(0);
		});
	});
});
