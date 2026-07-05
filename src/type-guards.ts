/**
 * type-guards — Runtime type guards for todo-enforcer
 *
 * Replaces `as X` type assertions with safe runtime checks.
 * Each guard narrows `unknown` to a specific type.
 */

// ─── Primitive guards ────────────────────────────────────────────────────────

/**
 * Check if a value is a plain object (not null, not array).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Check if a value is a string.
 */
export function isString(v: unknown): v is string {
	return typeof v === "string";
}

// ─── Session entry guards ─────────────────────────────────────────────────────

/**
 * Check if a value has a `message` property (session entry shape).
 */
export function hasMessage(
	v: unknown,
): v is { message?: { customType?: string; role?: string; toolName?: string; content?: unknown } } {
	if (!isRecord(v)) return false;
	return "message" in v;
}

/**
 * Check if a value has a `role` property (session message shape).
 */
export function hasRole(v: unknown): v is { role?: string; [key: string]: unknown } {
	return isRecord(v) && "role" in v;
}

/**
 * Check if a value has a `stopReason` property.
 */
export function hasStopReason(v: unknown): v is { stopReason?: string; [key: string]: unknown } {
	return isRecord(v) && "stopReason" in v;
}

// ─── Safe extractors ──────────────────────────────────────────────────────────

/**
 * Safely extract string content from unknown value.
 * Returns the string if it's a string, empty string otherwise.
 */
export function getStringContent(content: unknown): string {
	return isString(content) ? content : "";
}

/**
 * Safely extract `role` from an unknown value.
 * Returns the role string if present, undefined otherwise.
 */
export function extractRole(m: unknown): string | undefined {
	if (!hasRole(m)) return undefined;
	return typeof m.role === "string" ? m.role : undefined;
}

/**
 * Safely extract `stopReason` from an unknown value.
 * Returns the stopReason string if present, undefined otherwise.
 */
export function extractStopReason(m: unknown): string | undefined {
	if (!hasStopReason(m)) return undefined;
	return typeof m.stopReason === "string" ? m.stopReason : undefined;
}

// ─── Array guards ─────────────────────────────────────────────────────────────

/**
 * Check if a value is an array of session entries.
 * Each entry must be an object with a `type` property (string).
 */
export function isSessionEntryArray(v: unknown): v is Array<{ type: string; message?: unknown }> {
	if (!Array.isArray(v)) return false;
	return v.every(
		(entry) => isRecord(entry) && typeof entry.type === "string",
	);
}

// ─── Config guards ────────────────────────────────────────────────────────────

/**
 * Check if a value looks like a partial TodoEnforcerConfig.
 * At minimum it must be a non-null plain object.
 */
export function isPartialTodoConfig(
	v: unknown,
): v is Partial<import("./config").TodoEnforcerConfig> {
	return isRecord(v);
}

/**
 * Check if a value is a valid TodoSource string.
 */
export function isTodoSource(v: unknown): v is import("./config").TodoSource {
	return v === "auto" || v === "branch" || v === "todo-progress";
}

/**
 * Check if a value is a valid todo-progress persisted item.
 */
export function isTodoProgressItem(
	v: unknown,
): v is { text: string; status: string } {
	if (!isRecord(v)) return false;
	return (
		typeof v.text === "string" &&
		typeof v.status === "string" &&
		(v.status === "todo" || v.status === "partial" || v.status === "done")
	);
}

/**
 * Check if a value is a valid todo-progress persisted state (version 1).
 */
export function isTodoProgressState(v: unknown): v is {
	version: 1;
	visible: boolean;
	items: Array<{ text: string; status: string }>;
	offset: number;
	goal?: string;
	awaitingGoalCheck: boolean;
	allowNextListReplacement: boolean;
} {
	if (!isRecord(v)) return false;
	if (v.version !== 1) return false;
	if (typeof v.visible !== "boolean") return false;
	if (!Array.isArray(v.items)) return false;
	if (!v.items.every((item) => isTodoProgressItem(item))) return false;
	if (typeof v.offset !== "number") return false;
	if (typeof v.awaitingGoalCheck !== "boolean") return false;
	if (typeof v.allowNextListReplacement !== "boolean") return false;
	return true;
}
