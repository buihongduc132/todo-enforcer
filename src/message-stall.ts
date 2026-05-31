/**
 * message-stall — Reusable stall guard for todo-enforcer
 *
 * Prevents the enforcer from flooding the session with repeated or
 * high-frequency messages. Two stall conditions:
 *
 * 1. **Repeated message guard**: If the same exact message is about to
 *    be sent for the 3rd consecutive time, stall it.
 *    - Reset when a DIFFERENT message arrives (new problem → fresh start).
 *
 * 2. **Rate limit**: If 5 messages have been sent within a 60-minute window,
 *    stall additional messages until the window expires.
 *
 * Usage:
 *   const { stalled, reason } = checkMessageStall(sessionId, message);
 *   if (stalled) { log("stalled", reason); return; }
 *   // ... proceed to deliver message ...
 *
 * Call resetStallState(sessionId) on session_start to clear tracking.
 */
// @ts-nocheck

// 


// ─── Types ───────────────────────────────────────────────────────────────────

export interface StallState {
	/** Last message content that was checked (not stalled). */
	lastMessage: string | null;

	/** How many consecutive times the same message has been seen. */
	repeatCount: number;

	/** Timestamps of all delivered (non-stalled) messages for rate-limit tracking. */
	messageTimestamps: number[];
}

export interface StallResult {
	/** Whether the message should be stalled (not sent). */
	stalled: boolean;

	/** Reason for stalling: "repeated_message" | "rate_limit" | null. */
	reason: "repeated_message" | "rate_limit" | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Consecutive identical messages before stalling. */
const REPEAT_THRESHOLD = 3;

/** Stall when this many messages have been delivered in the window. */
const RATE_LIMIT_STALL_AT = 5;

/** Rate-limit window duration in ms (60 minutes). */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ─── State store ─────────────────────────────────────────────────────────────

const stallStates = new Map<string, StallState>();

function getOrCreate(sessionId: string): StallState {
	let state = stallStates.get(sessionId);
	if (!state) {
		state = {
			lastMessage: null,
			repeatCount: 0,
			messageTimestamps: [],
		};
		stallStates.set(sessionId, state);
	}
	return state;
}

// ─── Time abstraction (testable) ─────────────────────────────────────────────

let _getTime: () => number = () => Date.now();

/**
 * Override time source for testing. Returns the previous getter.
 * Production code should NOT call this.
 */
export function stubGetTime(fn: () => number): () => number {
	const prev = _getTime;
	_getTime = fn;
	return prev;
}

/** Reset time source to default. */
export function resetGetTime(): void {
	_getTime = () => Date.now();
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Prune timestamps outside the rate-limit window.
 * Returns the pruned array (mutates in place).
 */
function pruneOldTimestamps(timestamps: number[], now: number): void {
	const cutoff = now - RATE_LIMIT_WINDOW_MS;
	while (timestamps.length > 0 && timestamps[0] < cutoff) {
		timestamps.shift();
	}
}

/**
 * Fingerprint a message by its first non-empty line.
 *
 * Defense against the death-spiral: if {{latest_user_message}} in the prompt
 * template echoes the previous injection, every successive message is longer
 * than the last and exact-string equality never holds. The first line is the
 * stable rule-determined prefix (e.g. "You have incomplete tasks. ..."), so
 * fingerprinting on it lets the repeat-stall fire regardless of nested growth.
 */
function fingerprint(message: string): string {
	for (const line of message.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a message should be stalled.
 *
 * Call this BEFORE delivering the message. If stalled=true, do NOT send.
 *
 * If not stalled, this function records the message for future tracking.
 */
export function checkMessageStall(
	sessionId: string,
	message: string,
): StallResult {
	const state = getOrCreate(sessionId);
	const now = _getTime();

	// ── Check 1: Repeated message ─────────────────────────────────────
	// Compare by first-line fingerprint so growing nested content (the
	// enforcer's own injection echoed back via {{latest_user_message}}) is
	// still caught as a repeat.
	const fp = fingerprint(message);
	const lastFp = state.lastMessage === null ? null : fingerprint(state.lastMessage);
	if (lastFp !== null && lastFp === fp) {
		state.repeatCount++;
		// Keep lastMessage in sync with the most recent content so callers
		// inspecting state see the actual last seen message.
		state.lastMessage = message;
		if (state.repeatCount >= REPEAT_THRESHOLD) {
			return { stalled: true, reason: "repeated_message" };
		}
	} else {
		// Different fingerprint → reset repeat counter
		state.lastMessage = message;
		state.repeatCount = 1;
	}

	// ── Check 2: Rate limit ───────────────────────────────────────────
	pruneOldTimestamps(state.messageTimestamps, now);
	// If we've already recorded RATE_LIMIT_MAX-1 messages, the next one is the Nth and should be stalled.
	// (We record AFTER passing this check, so at the time of check, timestamps.length is the count of prior sends.)
	if (state.messageTimestamps.length >= RATE_LIMIT_STALL_AT - 1) {
		return { stalled: true, reason: "rate_limit" };
	}

	// ── Not stalled → record this message ─────────────────────────────
	state.messageTimestamps.push(now);

	return { stalled: false, reason: null };
}

/**
 * Reset all stall state for a session.
 * Call on session_start or manual reset.
 */
export function resetStallState(sessionId: string): void {
	stallStates.delete(sessionId);
}

/**
 * Reset all stall state for all sessions.
 * Useful for testing.
 */
export function resetAllStallState(): void {
	stallStates.clear();
}
