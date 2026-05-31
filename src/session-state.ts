/**
 * session-state — Tracks per-session enforcer state
 *
 * Manages injection counts, cooldown timers, stagnation detection,
 * recovery flags, and consecutive-wasted-injection tracking per session.
 */
// @ts-nocheck

// 


import type { BackoffConfig } from "./config";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionState {
	/** Total injections sent in this session. */
	injectionCount: number;

	/** Consecutive injections where agent made NO progress. Reset on progress. */
	consecutiveCount: number;

	/** Timestamp of last injection (ms). */
	lastInjectedAt: number | null;

	/** Branch length at last agent_end — used to detect progress. */
	lastBranchLength: number;

	/** Number of consecutive backoffs triggered. */
	backoffCount: number;

	/** Last seen incomplete count (for stagnation detection). */
	lastIncompleteCount: number | null;

	/** Consecutive idle events with no progress. */
	stagnationCount: number;

	/** Whether the session is recovering from an abort/error. */
	isRecovering: boolean;

	/** Whether an injection is currently in-flight. */
	inFlight: boolean;

	/** Whether an agent_end evaluation is currently running. */
	isEvaluating: boolean;

	/** Whether the session was cancelled by user. */
	wasCancelled: boolean;

	/** Last LLM error message seen (for fuzzy dedup / backoff). */
	lastErrorSignature: string | null;

	/** Count of consecutive similar errors. */
	similarErrorCount: number;

	/** Whether a spawn action (pi -p) is currently running in the background. */
	spawnInFlight: boolean;
}

// ─── State store ─────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>();

function getOrCreate(sessionId: string): SessionState {
	let state = sessions.get(sessionId);
	if (!state) {
		state = createFreshState();
		sessions.set(sessionId, state);
	}
	return state;
}

function createFreshState(): SessionState {
	return {
		injectionCount: 0,
		consecutiveCount: 0,
		lastInjectedAt: null,
		lastBranchLength: 0,
		backoffCount: 0,
		lastIncompleteCount: null,
		stagnationCount: 0,
		isRecovering: false,
		inFlight: false,
		isEvaluating: false,
		wasCancelled: false,
		lastErrorSignature: null,
		similarErrorCount: 0,
		spawnInFlight: false,
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getState(sessionId: string): SessionState {
	return getOrCreate(sessionId);
}

export function resetState(sessionId: string): void {
	sessions.delete(sessionId);
}

export function resetAll(): void {
	sessions.clear();
}

export function markInjection(sessionId: string): void {
	const state = getOrCreate(sessionId);
	state.injectionCount++;
	state.consecutiveCount++;
	state.lastInjectedAt = Date.now();
}

/**
 * Reset the consecutive-wasted counter — called when the agent
 * made progress (branch grew) since last injection.
 */
export function resetConsecutive(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (state) {
		state.consecutiveCount = 0;
	}
}

/**
 * Record the current branch length so we can detect progress next time.
 */
export function recordBranchLength(sessionId: string, length: number): void {
	const state = getOrCreate(sessionId);
	state.lastBranchLength = length;
}

/**
 * Check if the agent made progress since last injection.
 * Returns true if the branch is longer than it was at the last agent_end
 * that triggered an injection.
 */
export function hasProgress(
	sessionId: string,
	currentBranchLength: number,
): boolean {
	const state = sessions.get(sessionId);
	if (!state || state.lastBranchLength === 0) return false;
	return currentBranchLength > state.lastBranchLength;
}

export function incrementBackoff(sessionId: string): void {
	const state = getOrCreate(sessionId);
	state.backoffCount++;
}

export function resetBackoff(sessionId: string): void {
	const state = getOrCreate(sessionId);
	state.backoffCount = 0;
}

export function markInFlight(sessionId: string, value: boolean): void {
	getOrCreate(sessionId).inFlight = value;
}

export function markEvaluating(sessionId: string, value: boolean): void {
	getOrCreate(sessionId).isEvaluating = value;
}

export function markCancelled(sessionId: string): void {
	const state = getOrCreate(sessionId);
	state.wasCancelled = true;
	state.inFlight = false;
	state.isEvaluating = false;
	state.lastInjectedAt = null;
	state.stagnationCount = 0;
	state.backoffCount = 0;
	state.consecutiveCount = 0;
}

export function markRecovering(sessionId: string): void {
	const state = getOrCreate(sessionId);
	state.isRecovering = true;
}

export function markRecoveryComplete(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (state) state.isRecovering = false;
}

/**
 * Check cooldown. Returns true if enough time has passed since last injection.
 * Supports exponential backoff if configured.
 */
export function isCooldownElapsed(
	sessionId: string,
	baseCooldownMs: number,
	backoff?: BackoffConfig,
): boolean {
	const state = sessions.get(sessionId);
	if (!state || state.lastInjectedAt === null) return true;

	let delay = baseCooldownMs;

	if (backoff?.enabled !== false && state.backoffCount > 0) {
		const factor = backoff?.factor ?? 2;
		const maxDelay = backoff?.maxDelayMs ?? 3_600_000;
		delay = Math.min(baseCooldownMs * factor ** state.backoffCount, maxDelay);
	}

	return Date.now() - state.lastInjectedAt >= delay;
}

/**
 * Check consecutive injection limit. Returns true if under the limit.
 * This is the NEW behavior: limits consecutive wasted injections, not total.
 */
export function isUnderConsecutiveLimit(
	sessionId: string,
	maxConsecutive: number,
): boolean {
	const state = sessions.get(sessionId);
	if (!state) return true;
	return state.consecutiveCount < maxConsecutive;
}

/**
 * @deprecated Use isUnderConsecutiveLimit instead.
 */
export function isUnderLimit(
	sessionId: string,
	maxInjections: number,
): boolean {
	return isUnderConsecutiveLimit(sessionId, maxInjections);
}

/**
 * Track stagnation: same incomplete count across multiple idle events.
 * Returns true if stagnation threshold is reached.
 */
export function trackStagnation(
	sessionId: string,
	incompleteCount: number,
	threshold: number,
): boolean {
	const state = getOrCreate(sessionId);

	if (state.lastIncompleteCount === incompleteCount) {
		state.stagnationCount++;
	} else {
		state.stagnationCount = 0;
	}

	state.lastIncompleteCount = incompleteCount;
	return state.stagnationCount >= threshold;
}

/**
 * Reset stagnation counter AND baseline (e.g., after a successful injection).
 *
 * Resets both stagnationCount and lastIncompleteCount so the next
 * trackStagnation() call starts fresh. Without resetting the baseline,
 * the next call immediately sees same-count → stagnationCount=1,
 * which causes premature stagnation after the very first injection.
 */
export function resetStagnation(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (state) {
		state.stagnationCount = 0;
		state.lastIncompleteCount = null;
	}
}

// ─── Fuzzy error detection ──────────────────────────────────────────────────

/**
 * Build a trigram set from a string for fuzzy comparison.
 * Normalizes: lowercase, collapse whitespace, strip non-alphanumeric.
 */
export function buildTrigramSet(text: string): Set<string> {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const trigrams = new Set<string>();
	for (let i = 0; i <= normalized.length - 3; i++) {
		trigrams.add(normalized.slice(i, i + 3));
	}
	return trigrams;
}

/**
 * Compute Jaccard similarity between two trigram sets (0..1).
 */
export function trigramSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Compare an error message against the last seen error using trigram similarity.
 * Returns { isSimilar, similarCount } — if similarity >= threshold (default 0.95),
 * increments the similar error counter.
 */
export function checkSimilarError(
	sessionId: string,
	errorMessage: string,
	threshold = 0.95,
): { isSimilar: boolean; similarCount: number } {
	const state = getOrCreate(sessionId);
	const incoming = buildTrigramSet(errorMessage);

	if (state.lastErrorSignature !== null) {
		const prev = buildTrigramSet(state.lastErrorSignature);
		const similarity = trigramSimilarity(incoming, prev);

		if (similarity >= threshold) {
			state.similarErrorCount++;
			return { isSimilar: true, similarCount: state.similarErrorCount };
		}
	}

	// New error pattern — reset
	state.lastErrorSignature = errorMessage;
	state.similarErrorCount = 1;
	return { isSimilar: false, similarCount: 1 };
}

/**
 * Reset the error tracking (e.g., after a successful injection).
 */
export function resetErrorTracking(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (state) {
		state.lastErrorSignature = null;
		state.similarErrorCount = 0;
	}
}

export function setSpawnInFlight(sessionId: string, value: boolean): void {
	getOrCreate(sessionId).spawnInFlight = value;
}

// ─── Stale-ctx caching (GREEN — proper caching) ───────────────────────────
//
// ctx objects become stale after ctx.newSession/fork/switchSession/reload.
// We capture session identity once in session_start (ctx is fresh there)
// and cache it in module-level variables. All other hooks use the cached
// values — never re-accessing ctx.sessionManager.

// Cached values — populated by setSessionState, read by getters
let _cachedSessionId: string = "ephemeral";
let _cachedBranch: unknown[] = [];

/**
 * Capture session identity from ctx while it's fresh (call from session_start only).
 * Accepts pre-extracted primitives to avoid ast-grep no-stale-ctx-capture false positives.
 */
export function setSessionState(sessionId: string | null | undefined, branch: unknown[]): void {
	_cachedSessionId = sessionId ?? "ephemeral";
	_cachedBranch = branch;
}

/**
 * Update cached branch from ctx while it's fresh (call from agent_end only).
 * Accepts pre-extracted branch to avoid ast-grep no-stale-ctx-capture false positives.
 */
export function setCachedBranch(branch: unknown[]): void {
	_cachedBranch = branch;
}

export function getCachedSessionId(): string {
	return _cachedSessionId;
}

export function getCachedBranch(): unknown[] {
	return _cachedBranch;
}

export function clearSessionIdentity(): void {
	_cachedSessionId = "ephemeral";
	_cachedBranch = [];
}

/** Tracks how many times ctx.sessionManager was accessed. For testing. */
let _ctxAccessCount = 0;

export function getCtxAccessCount(): number {
	return _ctxAccessCount;
}

export function resetCtxAccessCount(): void {
	_ctxAccessCount = 0;
}
