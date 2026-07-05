/**
 * todo-progress-adapter — Reads todo-progress's persisted widget state
 *
 * todo-progress (@firstpick/pi-extension-todo-progress) persists its widget
 * state via pi.appendEntry("todo-progress-state", snapshot) where each entry
 * is a PersistedTodoState with version: 1, items[], visible, goal, etc.
 *
 * This adapter reads those entries from the session branch and maps them
 * to todo-enforcer's TodoSnapshot format.
 *
 * No code dependency on todo-progress — reads branch JSON directly.
 */

import { createPluginLogger } from "./lib/plugin-logger";
import type { TodoSnapshot } from "./config";
import type { SessionEntry } from "./todo-snapshot";
import { isTodoProgressState } from "./type-guards";

const logger = createPluginLogger("todo-enforcer");

/** The customType todo-progress uses for its persisted state entries. */
export const TODO_PROGRESS_STATE_KEY = "todo-progress-state";

/** todo-progress's PersistedTodoState shape (version 1). */
export interface TodoProgressState {
	version: 1;
	visible: boolean;
	items: Array<{ text: string; status: string }>;
	offset: number;
	goal?: string;
	awaitingGoalCheck: boolean;
	allowNextListReplacement: boolean;
}

/** Status mapping: todo-progress → todo-enforcer. */
const STATUS_MAP: Record<string, string> = {
	todo: "pending",
	partial: "in_progress",
	done: "completed",
};

/**
 * Scan the session branch for the latest todo-progress-state entry.
 * Returns the parsed state, or null if none found or invalid.
 */
export function readTodoProgressState(
	getBranch: () => SessionEntry[],
): TodoProgressState | null {
	const branch = getBranch();

	// Scan from end (latest first) for the most recent valid state entry
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || typeof entry !== "object") continue;

		// todo-progress appends entries with type "custom" and customType STATE_KEY
		// The data may be on entry.data, entry.message, or entry itself
		const entryRecord = entry as unknown as Record<string, unknown>;
		const customType =
			entryRecord.customType ?? entryRecord.type ??
			(entryRecord.message as Record<string, unknown> | undefined)?.customType;

		// Check both type === "custom" with customType, and entries where
		// customType is directly on the entry
		const isStateEntry =
			entryRecord.customType === TODO_PROGRESS_STATE_KEY ||
			(entryRecord.type === "custom" &&
				(entryRecord as { customType?: string }).customType === TODO_PROGRESS_STATE_KEY) ||
			(entryRecord.message &&
				(entryRecord.message as { customType?: string }).customType === TODO_PROGRESS_STATE_KEY);

		if (!isStateEntry) continue;

		// Extract data payload — could be entry.data, entry.message.data, or entry.message
		let data: unknown =
			entryRecord.data ??
			(entryRecord.message as Record<string, unknown> | undefined)?.data ??
			entryRecord.message ??
			entryRecord;

		// If data is a string, try parsing
		if (typeof data === "string") {
			try {
				data = JSON.parse(data);
			} catch {
				continue;
			}
		}

		if (isTodoProgressState(data)) {
			return data as TodoProgressState;
		}
	}

	return null;
}

/**
 * Build a TodoSnapshot from todo-progress state.
 * Returns { available: false } when:
 *   - state is null (no entries)
 *   - items is empty
 *   - version mismatch (handled by isTodoProgressState guard)
 */
export function buildSnapshotFromTodoProgress(
	state: TodoProgressState | null,
	context: Partial<TodoSnapshot> = {},
): { available: boolean; snapshot: TodoSnapshot } {
	if (!state || !state.items || state.items.length === 0) {
		return {
			available: false,
			snapshot: {
				incompleteCount: 0,
				inProgressCount: 0,
				completedCount: 0,
				totalCount: 0,
				incompleteList: "(no items)",
				completedList: "",
				sessionSummary: "",
				latestUserMessage: "",
				assistantMessages: "",
				allMessagesSinceLatestUser: "",
				sessionMetadata: "",
				...context,
			} as TodoSnapshot,
		};
	}

	const mapped = state.items.map((item) => ({
		text: item.text,
		status: STATUS_MAP[item.status] ?? "pending",
	}));

	const incomplete = mapped.filter(
		(m) => m.status === "pending" || m.status === "in_progress",
	);
	const inProgress = mapped.filter((m) => m.status === "in_progress");
	const completed = mapped.filter((m) => m.status === "completed");

	return {
		available: true,
		snapshot: {
			incompleteCount: incomplete.length,
			inProgressCount: inProgress.length,
			completedCount: completed.length,
			totalCount: mapped.length,
			incompleteList:
				incomplete.map((m) => `- [${m.status}] ${m.text}`).join("\n") ||
				"(none)",
			completedList:
				completed.map((m) => `- [completed] ${m.text}`).join("\n") || "(none)",
			sessionSummary: state.goal ?? "",
			latestUserMessage: "",
			assistantMessages: "",
			allMessagesSinceLatestUser: "",
			sessionMetadata: "",
			...context,
		} as TodoSnapshot,
	};
}

/**
 * Detect whether todo-progress has auto-cleared its widget.
 * Returns true when visible: false AND items: [] — the signature
 * of shouldAutoClearOnAgentEnd having fired.
 */
export function detectAutoClear(state: TodoProgressState | null): boolean {
	if (!state) return false;
	return state.visible === false &&
		(!state.items || state.items.length === 0);
}

/**
 * Check whether todo-progress state entries exist in the branch at all.
 * Used for auto-detection in "auto" mode.
 */
export function hasTodoProgressEntries(
	getBranch: () => SessionEntry[],
): boolean {
	const branch = getBranch();
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const entryRecord = entry as unknown as Record<string, unknown>;
		if (entryRecord.customType === TODO_PROGRESS_STATE_KEY) return true;
		if (entryRecord.type === "custom" &&
			(entryRecord as { customType?: string }).customType === TODO_PROGRESS_STATE_KEY) return true;
		if (entryRecord.message &&
			(entryRecord.message as { customType?: string }).customType === TODO_PROGRESS_STATE_KEY) return true;
	}
	return false;
}
