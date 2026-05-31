// @ts-nocheck
// 
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	checkMessageStall,
	resetStallState,
	resetGetTime,
	stubGetTime,
	type StallState,
} from "../src/message-stall";

describe("message-stall", () => {
	beforeEach(() => {
		resetStallState("s1");
		resetGetTime();
		vi.useRealTimers();
	});

	// ── Repeated message guard ──────────────────────────────────────────────

	describe("repeated message guard (3 identical → stall)", () => {
		it("does NOT stall the first 2 identical messages", () => {
			const msg = "You have incomplete tasks. Continue working on them.";
			expect(checkMessageStall("s1", msg).stalled).toBe(false);
			expect(checkMessageStall("s1", msg).stalled).toBe(false);
		});

		it("STALLS on the 3rd identical message", () => {
			const msg = "You have incomplete tasks. Continue working on them.";
			checkMessageStall("s1", msg); // 1st
			checkMessageStall("s1", msg); // 2nd
			const result = checkMessageStall("s1", msg); // 3rd
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe("repeated_message");
		});

		it("continues stalling identical messages after 3rd", () => {
			const msg = "You have incomplete tasks. Continue working on them.";
			checkMessageStall("s1", msg);
			checkMessageStall("s1", msg);
			checkMessageStall("s1", msg); // stalled at 3
			const result = checkMessageStall("s1", msg); // 4th, still stalled
			expect(result.stalled).toBe(true);
		});

		it("resets counter when a DIFFERENT message arrives after stall", () => {
			const msg1 = "You have incomplete tasks. Continue working on them.";
			const msg2 = "Pick up where you left off. Fix the broken scrape targets.";

			checkMessageStall("s1", msg1);
			checkMessageStall("s1", msg1);
			checkMessageStall("s1", msg1); // stalled
			expect(checkMessageStall("s1", msg1).stalled).toBe(true);

			// Different message → reset
			const result = checkMessageStall("s1", msg2);
			expect(result.stalled).toBe(false);
		});

		it("starts fresh count after reset from different message", () => {
			const msg1 = "You have incomplete tasks.";
			const msg2 = "Something completely different.";

			checkMessageStall("s1", msg1);
			checkMessageStall("s1", msg1);
			checkMessageStall("s1", msg1); // stalled

			// Reset with different message
			checkMessageStall("s1", msg2); // new, count=1
			checkMessageStall("s1", msg2); // count=2, not stalled yet

			// Now same msg2 again → 3rd → stalled
			const result = checkMessageStall("s1", msg2);
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe("repeated_message");
		});

		it("different messages between identical ones reset the counter", () => {
			const msg1 = "Message A";
			const msg2 = "Message B";

			checkMessageStall("s1", msg1); // A: count=1
			checkMessageStall("s1", msg2); // B: count=1 (reset for new msg)
			checkMessageStall("s1", msg1); // A: count=1 (reset again)

			// Even though we've called 3 times, the message keeps changing
			expect(checkMessageStall("s1", msg1).stalled).toBe(false); // A: count=2
		});
	});

	// ── Rate limit guard ────────────────────────────────────────────────────

	describe("rate limit guard (5 in 60 min → stall)", () => {
		it("does NOT stall 4 messages within 60 min", () => {
			for (let i = 0; i < 4; i++) {
				expect(checkMessageStall("s1", `message ${i}`).stalled).toBe(false);
			}
		});

		it("STALLS on the 5th message within 60 min window", () => {
			for (let i = 0; i < 4; i++) {
				checkMessageStall("s1", `message ${i}`);
			}
			const result = checkMessageStall("s1", "message 4"); // 5th
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe("rate_limit");
		});

it("resets rate limit after 60 min window passes", () => {
			let fakeNow = new Date("2026-01-01T00:00:00Z").getTime();
			resetGetTime();
			stubGetTime(() => fakeNow);

			for (let i = 0; i < 4; i++) {
				checkMessageStall("s1", `message ${i}`);
			}
			// 5th would be rate limited
			expect(checkMessageStall("s1", "message 4").stalled).toBe(true);

			// Advance past 60 min
			fakeNow += 61 * 60 * 1000;

			// New window — should be allowed again
			expect(checkMessageStall("s1", "new message").stalled).toBe(false);

			resetGetTime();
		});

		it("rate limit resets independent sessions", () => {
			for (let i = 0; i < 4; i++) {
				checkMessageStall("s1", `message ${i}`);
			}

			// Different session — independent tracking
			expect(checkMessageStall("s2", "message 0").stalled).toBe(false);
		});
	});

	// ── Combined behavior ───────────────────────────────────────────────────

	describe("combined: repeated + rate limit", () => {
		it("repeated-message stall triggers before rate-limit stall", () => {
			const msg = "Same message";
			// 3 identical → repeated stall
			checkMessageStall("s1", msg);
			checkMessageStall("s1", msg);
			const result = checkMessageStall("s1", msg);
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe("repeated_message");
		});

		it("rate limit can trigger independently even with different messages", () => {
			for (let i = 0; i < 4; i++) {
				checkMessageStall("s1", `unique message ${i}`);
			}
			const result = checkMessageStall("s1", "unique message 5");
			expect(result.stalled).toBe(true);
			expect(result.reason).toBe("rate_limit");
		});
	});

	// ── Reset behavior ──────────────────────────────────────────────────────

	describe("resetStallState", () => {
		it("clears all stall tracking for a session", () => {
			const msg = "Some message";
			checkMessageStall("s1", msg);
			checkMessageStall("s1", msg);
			checkMessageStall("s1", msg); // stalled

			resetStallState("s1");

			// Fresh start
			expect(checkMessageStall("s1", msg).stalled).toBe(false);
		});
	});

	// ── Edge cases ──────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles empty string messages", () => {
			expect(checkMessageStall("s1", "").stalled).toBe(false);
			expect(checkMessageStall("s1", "").stalled).toBe(false);
			expect(checkMessageStall("s1", "").stalled).toBe(true);
		});

		it("handles messages differing only in whitespace as different", () => {
			checkMessageStall("s1", "Hello world");
			checkMessageStall("s1", "Hello  world"); // double space
			// These are different messages, so counter should be at 1 each
			// Not stalled
			expect(checkMessageStall("s1", "Hello world").stalled).toBe(false);
		});
	});

	// Regression: defends against the death-spiral where the enforcer's prior
	// injection is fed back via {{latest_user_message}} and the new injection
	// nests the old one. Each subsequent message is longer than the last, so
	// exact-string equality never holds. The fingerprint-based check uses the
	// stable first line of the message so the repeat-stall fires regardless of
	// nested growth.
	describe("repeated message guard — fingerprint (nested growth)", () => {
		const baseLine =
			"You have incomplete tasks. Continue working on them.";
		const mkInjection = (depth: number): string => {
			const nested = Array.from({ length: depth }, (_, i) =>
				`Latest user message:\n${baseLine}\n[depth ${i}]\nPick up where you left off.`,
			).join("\n\n");
			return `${baseLine}\n\n[Status: 1/3]\n\n${nested}\n\nPick up where you left off.`;
		};

		it("stalls after 3 injections that share the same first line but grow in nested content", () => {
			expect(checkMessageStall("s1", mkInjection(0)).stalled).toBe(false);
			expect(checkMessageStall("s1", mkInjection(1)).stalled).toBe(false);
			const third = checkMessageStall("s1", mkInjection(2));
			expect(third.stalled).toBe(true);
			expect(third.reason).toBe("repeated_message");
		});

		it("does NOT stall when the first line genuinely changes (different rule fired)", () => {
			expect(checkMessageStall("s1", "You have incomplete tasks. ...").stalled).toBe(false);
			expect(checkMessageStall("s1", "All 5 tasks are complete. Great work.").stalled).toBe(false);
			// Two different first lines → repeat count never reaches 3
			expect(checkMessageStall("s1", "You have incomplete tasks. ...").stalled).toBe(false);
		});
	});
});
