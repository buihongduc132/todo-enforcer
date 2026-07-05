/**
 * todo-snapshot — Builds a snapshot of the current todo state
 *
 * Scans ctx.sessionManager.getBranch() for todo tool results — same approach
 * rpiv-todo uses internally. No cross-package imports needed.
 *
 * Falls back gracefully if no todo entries found in session.
 */

import { createPluginLogger } from "./lib/plugin-logger";
import type { ContextFeedConfig, SessionContext, TodoSnapshot, TodoSource } from "./config";
import {
	buildSnapshotFromTodoProgress,
	detectAutoClear,
	hasTodoProgressEntries,
	readTodoProgressState,
} from "./todo-progress-adapter";

const logger = createPluginLogger("todo-enforcer");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskDetails {
	tasks: Array<{
		id: number;
		subject: string;
		status: string;
		description?: string;
		activeForm?: string;
		blockedBy?: number[];
		owner?: string;
		metadata?: Record<string, unknown>;
	}>;
	nextId: number;
}

export interface TodoSnapshotResult {
	snapshot: TodoSnapshot;
	/** Whether todo entries were found in the session. */
	available: boolean;
}

// ─── Session scanner ─────────────────────────────────────────────────────────

function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

interface SessionMessage {
	role?: string;
	toolName?: string;
	toolCallId?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
}

export interface SessionEntry {
	type: string;
	message?: SessionMessage;
}

/**
 * Scan session branch for the latest todo tool result.
 * Returns the most recent TaskDetails, or null if none found.
 *
 * Supports both direct message format:
 *   { type: "message", message: { role: "toolResult", toolName: "todo", details: {...} } }
 * And nested format:
 *   { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [...], nextId: N } } }
 */
function normalizeContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object" && "text" in item) {
					const text = (item as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

const ENFORCER_TEXT_MARKERS = [
	"You have incomplete tasks. Continue working on them.",
	"Pick up where you left off.",
];

function isEnforcerEcho(message: SessionMessage): boolean {
	if (message.customType === "todo-enforcer") return true;
	const text = normalizeContent(message.content).slice(0, 400);
	if (!text) return false;
	return ENFORCER_TEXT_MARKERS.some((marker) => text.includes(marker));
}

function scanSessionForTodos(
	getBranch: () => SessionEntry[],
): TaskDetails | null {
	const branch = getBranch();
	let latest: TaskDetails | null = null;
	let scanned = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== "todo") continue;

		// The details field may be directly on the message, or nested under details.details
		let details: unknown = msg.details;
		if (!details || typeof details !== "object") continue;

		// Handle both { tasks, nextId } directly and { details: { tasks, nextId } } nested
		const d = details as Record<string, unknown>;
		if (!Array.isArray(d.tasks) && d.details && typeof d.details === "object") {
			details = d.details;
		}

		if (!isTaskDetails(details)) continue;
		latest = details;
		scanned++;
	}

	if (scanned === 0) {
		// Debug: log branch composition for diagnosis
		const messageCount = branch.filter(
			(e) => e.type === "message" && e.message,
		).length;
		const toolResultCount = branch.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		).length;
		const todoResultCount = branch.filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "toolResult" &&
				e.message?.toolName === "todo",
		).length;
		logger.debug("scanSessionForTodos: no todo results", {
			branchLength: branch.length,
			messageCount,
			toolResultCount,
			todoResultCount,
		});
	}

	return latest;
}

// ─── Session context builder ─────────────────────────────────────────────────

export function buildSessionContext(
	sessionId: string,
	cwd: string,
	getBranch: () => SessionEntry[],
	config: ContextFeedConfig,
): SessionContext {
	const branch = getBranch();
	const messages = branch
		.filter((entry): entry is { type: string; message: SessionMessage } =>
			entry.type === "message" && entry.message !== undefined,
		)
		.map((entry) => entry.message);

	let latestUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		// Skip prior enforcer injections. sendUserMessage creates a real user
		// message; without this check the next injection nests the previous one
		// via {{latest_user_message}} and the prompt grows unboundedly.
		if (config.excludePreviousEnforcerMessages && isEnforcerEcho(m)) continue;
		latestUserIndex = i;
		break;
	}

	const latestUserMessage =
		latestUserIndex >= 0
			? normalizeContent(messages[latestUserIndex].content)
			: "";

	const relevantMessages =
		latestUserIndex >= 0 ? messages.slice(latestUserIndex) : messages;
	const filteredMessages = relevantMessages.filter((message) => {
		if (!config.excludePreviousEnforcerMessages) return true;
		return !isEnforcerEcho(message);
	});

	const assistantMessages = filteredMessages
		.filter((message) => message.role === "assistant")
		.map((message) => normalizeContent(message.content))
		.filter(Boolean);

	const assistantMessageText =
		config.assistantMode === "mostRecent"
			? (assistantMessages[assistantMessages.length - 1] ?? "")
			: assistantMessages.join("\n\n");

	const allMessagesSinceLatestUser = filteredMessages
		.map((message) => {
			const content = normalizeContent(message.content);
			if (!content) return "";
			return `${message.role ?? "unknown"}: ${content}`;
		})
		.filter(Boolean)
		.join("\n");

	const sessionMetadata =
		config.includeSessionMetadata === false
			? ""
			: JSON.stringify({
					sessionId,
					cwd,
					messageCount: messages.length,
					latestUserIndex,
				});

	return {
		latestUserMessage,
		assistantMessages: assistantMessageText,
		allMessagesSinceLatestUser,
		sessionMetadata,
	};
}

// ─── Snapshot builder ────────────────────────────────────────────────────────

export function buildTodoSnapshot(
	sessionSummary: string,
	getBranch: () => SessionEntry[],
	context: SessionContext = {
		latestUserMessage: "",
		assistantMessages: "",
		allMessagesSinceLatestUser: "",
		sessionMetadata: "",
	},
	todoSource: TodoSource = "auto",
): TodoSnapshotResult {
	const source: TodoSource = todoSource ?? "auto";

	// Dispatch based on todoSource config
	if (source === "todo-progress") {
		const tpState = readTodoProgressState(getBranch);
		return buildSnapshotFromTodoProgress(tpState, context);
	}

	if (source === "auto") {
		if (hasTodoProgressEntries(getBranch)) {
			const tpState = readTodoProgressState(getBranch);
			const tpResult = buildSnapshotFromTodoProgress(tpState, context);
			if (tpResult.available) return tpResult;
			// Fall through to branch parser if adapter returned unavailable
		}
	}

	// source === "branch" or auto fallback
	const details = scanSessionForTodos(getBranch);

	if (!details) {
		return {
			snapshot: {
				incompleteCount: 0,
				inProgressCount: 0,
				completedCount: 0,
				totalCount: 0,
				incompleteList: "(no todo tool available)",
				completedList: "",
				sessionSummary,
				...context,
			},
			available: false,
		};
	}

	const nonDeleted = details.tasks.filter((t) => t.status !== "deleted");
	const incomplete = nonDeleted.filter(
		(t) => t.status === "pending" || t.status === "in_progress",
	);
	const inProgress = nonDeleted.filter((t) => t.status === "in_progress");
	const completed = nonDeleted.filter((t) => t.status === "completed");

	return {
		snapshot: {
			incompleteCount: incomplete.length,
			inProgressCount: inProgress.length,
			completedCount: completed.length,
			totalCount: nonDeleted.length,
			incompleteList:
				incomplete
					.map((t) => `- [${t.status}] #${t.id} ${t.subject}`)
					.join("\n") || "(none)",
			completedList:
				completed
					.map((t) => `- [completed] #${t.id} ${t.subject}`)
					.join("\n") || "(none)",
			sessionSummary,
			...context,
		},
		available: true,
	};
}
