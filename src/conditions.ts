/**
 * conditions — Built-in and extensible condition evaluator
 *
 * Evaluates rule conditions against a TodoSnapshot.
 * Custom conditions can be registered via registerCondition().
 */
// @ts-nocheck

// 


import { createPluginLogger } from "./lib/plugin-logger";
import type { TodoSnapshot } from "./config";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConditionFn = (snapshot: TodoSnapshot) => boolean;

// ─── Built-in conditions ────────────────────────────────────────────────────

const logger = createPluginLogger("todo-enforcer");

const builtinConditions: Record<string, ConditionFn> = {
	has_incomplete: (s) => s.incompleteCount > 0,
	all_complete: (s) => s.totalCount > 0 && s.incompleteCount === 0,
	has_in_progress: (s) => s.inProgressCount > 0,
	none: () => false,
	always: () => true,
};

// ─── Registry ────────────────────────────────────────────────────────────────

const customConditions: Map<string, ConditionFn> = new Map();

/**
 * Register a custom condition function.
 * Custom conditions override built-in conditions of the same name.
 */
export function registerCondition(name: string, fn: ConditionFn): void {
	customConditions.set(name, fn);
}

/**
 * Evaluate a condition against a todo snapshot.
 * Returns true if the condition matches.
 */
export function evaluateCondition(
	conditionName: string,
	snapshot: TodoSnapshot,
): boolean {
	// Custom conditions take priority
	const custom = customConditions.get(conditionName);
	if (custom) {
		try {
			return custom(snapshot);
		} catch (err) {
			logger.error(`Custom condition "${conditionName}" threw`, err);
			return false;
		}
	}

	const builtin = builtinConditions[conditionName];
	if (builtin) {
		return builtin(snapshot);
	}

	logger.warn(`Unknown condition: "${conditionName}" — treating as no-match`);
	return false;
}

/**
 * Get all registered condition names (built-in + custom).
 */
export function getRegisteredConditions(): string[] {
	return [
		...Object.keys(builtinConditions),
		...Array.from(customConditions.keys()),
	];
}
