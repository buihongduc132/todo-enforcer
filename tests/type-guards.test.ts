// @ts-nocheck
// 
import { describe, expect, it } from "vitest";

import {
	isRecord,
	isString,
	hasMessage,
	hasRole,
	hasStopReason,
	getStringContent,
	extractRole,
	extractStopReason,
	isSessionEntryArray,
	isPartialTodoConfig,
} from "../src/type-guards";

describe("type-guards", () => {
	// ─── isRecord ──────────────────────────────────────────────────────────

	describe("isRecord", () => {
		it("returns true for plain objects", () => {
			expect(isRecord({ foo: "bar" })).toBe(true);
		});

		it("returns true for empty object", () => {
			expect(isRecord({})).toBe(true);
		});

		it("returns false for null", () => {
			expect(isRecord(null)).toBe(false);
		});

		it("returns false for undefined", () => {
			expect(isRecord(undefined)).toBe(false);
		});

		it("returns false for arrays", () => {
			expect(isRecord([1, 2, 3])).toBe(false);
		});

		it("returns false for strings", () => {
			expect(isRecord("hello")).toBe(false);
		});

		it("returns false for numbers", () => {
			expect(isRecord(42)).toBe(false);
		});
	});

	// ─── isString ──────────────────────────────────────────────────────────

	describe("isString", () => {
		it("returns true for strings", () => {
			expect(isString("hello")).toBe(true);
		});

		it("returns true for empty string", () => {
			expect(isString("")).toBe(true);
		});

		it("returns false for numbers", () => {
			expect(isString(42)).toBe(false);
		});

		it("returns false for null", () => {
			expect(isString(null)).toBe(false);
		});

		it("returns false for objects", () => {
			expect(isString({})).toBe(false);
		});
	});

	// ─── hasMessage ────────────────────────────────────────────────────────

	describe("hasMessage", () => {
		it("returns true for object with message property", () => {
			expect(hasMessage({ message: { role: "user" } })).toBe(true);
		});

		it("returns true when message is undefined", () => {
			expect(hasMessage({ message: undefined })).toBe(true);
		});

		it("returns false for null", () => {
			expect(hasMessage(null)).toBe(false);
		});

		it("returns false for string", () => {
			expect(hasMessage("not an object")).toBe(false);
		});

		it("returns false when no message key", () => {
			expect(hasMessage({ type: "message" })).toBe(false);
		});
	});

	// ─── hasRole ───────────────────────────────────────────────────────────

	describe("hasRole", () => {
		it("returns true for object with role string", () => {
			expect(hasRole({ role: "assistant" })).toBe(true);
		});

		it("returns true for object with role undefined", () => {
			expect(hasRole({ role: undefined })).toBe(true);
		});

		it("returns false for object without role", () => {
			expect(hasRole({ foo: "bar" })).toBe(false);
		});

		it("returns false for null", () => {
			expect(hasRole(null)).toBe(false);
		});
	});

	// ─── hasStopReason ─────────────────────────────────────────────────────

	describe("hasStopReason", () => {
		it("returns true for object with stopReason string", () => {
			expect(hasStopReason({ stopReason: "error" })).toBe(true);
		});

		it("returns true for object with stopReason undefined", () => {
			expect(hasStopReason({ stopReason: undefined })).toBe(true);
		});

		it("returns false for object without stopReason", () => {
			expect(hasStopReason({ foo: "bar" })).toBe(false);
		});

		it("returns false for null", () => {
			expect(hasStopReason(null)).toBe(false);
		});
	});

	// ─── getStringContent ──────────────────────────────────────────────────

	describe("getStringContent", () => {
		it("returns string when content is a string", () => {
			expect(getStringContent("hello")).toBe("hello");
		});

		it("returns empty string for non-string content", () => {
			expect(getStringContent(42)).toBe("");
		});

		it("returns empty string for null", () => {
			expect(getStringContent(null)).toBe("");
		});
	});

	// ─── extractRole ───────────────────────────────────────────────────────

	describe("extractRole", () => {
		it("extracts role from object with role", () => {
			expect(extractRole({ role: "assistant", content: "hi" })).toBe("assistant");
		});

		it("returns undefined when no role", () => {
			expect(extractRole({ content: "hi" })).toBeUndefined();
		});

		it("returns undefined for null", () => {
			expect(extractRole(null)).toBeUndefined();
		});

		it("returns undefined for non-object", () => {
			expect(extractRole("string")).toBeUndefined();
		});
	});

	// ─── extractStopReason ─────────────────────────────────────────────────

	describe("extractStopReason", () => {
		it("extracts stopReason from object", () => {
			expect(extractStopReason({ stopReason: "aborted" })).toBe("aborted");
		});

		it("returns undefined when no stopReason", () => {
			expect(extractStopReason({ role: "assistant" })).toBeUndefined();
		});

		it("returns undefined for null", () => {
			expect(extractStopReason(null)).toBeUndefined();
		});
	});

	// ─── isSessionEntryArray ───────────────────────────────────────────────

	describe("isSessionEntryArray", () => {
		it("returns true for array of session entries", () => {
			expect(
				isSessionEntryArray([
					{ type: "message", message: { role: "user" } },
				]),
			).toBe(true);
		});

		it("returns true for empty array", () => {
			expect(isSessionEntryArray([])).toBe(true);
		});

		it("returns false for non-array", () => {
			expect(isSessionEntryArray(null)).toBe(false);
		});

		it("returns false for array with non-objects", () => {
			expect(isSessionEntryArray(["not", "entries"])).toBe(false);
		});

		it("returns false for array with entries missing type", () => {
			expect(isSessionEntryArray([{ message: {} }])).toBe(false);
		});

		it("returns true for entries with type but no message", () => {
			expect(isSessionEntryArray([{ type: "custom" }])).toBe(true);
		});
	});

	// ─── isPartialTodoConfig ───────────────────────────────────────────────

	describe("isPartialTodoConfig", () => {
		it("returns true for object with rules array", () => {
			expect(isPartialTodoConfig({ rules: [] })).toBe(true);
		});

		it("returns true for empty object (all fields optional)", () => {
			expect(isPartialTodoConfig({})).toBe(true);
		});

		it("returns true for object with enabled field", () => {
			expect(isPartialTodoConfig({ enabled: true })).toBe(true);
		});

		it("returns false for null", () => {
			expect(isPartialTodoConfig(null)).toBe(false);
		});

		it("returns false for string", () => {
			expect(isPartialTodoConfig("not config")).toBe(false);
		});

		it("returns false for array", () => {
			expect(isPartialTodoConfig([1, 2, 3])).toBe(false);
		});
	});
});
