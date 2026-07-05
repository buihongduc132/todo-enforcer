// 
import { describe, expect, it } from "vitest";

import {
	DEFAULT_CONFIG,
	interpolateTemplate,
	loadConfig,
	loadConfigAsync,
	mergeConfigLayers,
	tryParseJson,
} from "../src/config";

describe("tryParseJson", () => {
	it("parses valid JSON", () => {
		const result = tryParseJson('{"key": "value"}');
		expect(result).toEqual({ key: "value" });
	});

	it("returns null for invalid JSON", () => {
		const result = tryParseJson("not json at all");
		expect(result).toBeNull();
	});

	it("returns null for truncated JSON", () => {
		const result = tryParseJson('{"key":');
		expect(result).toBeNull();
	});

	it("parses empty object", () => {
		const result = tryParseJson("{}");
		expect(result).toEqual({});
	});
});

describe("mergeConfigLayers", () => {
	it("merges delivery and context config from global and project files", () => {
		const config = mergeConfigLayers(
			{
				messageDelivery: {
					customType: "todo-enforcer-global",
					triggerTurn: false,
				},
				contextFeed: {
					includeSessionMetadata: false,
					assistantMode: "mostRecent",
				},
			},
			{
				messageDelivery: {
					deliverAs: "steer",
					display: false,
				},
				contextFeed: {
					assistantMode: "allSinceLatestUser",
				},
				rules: [
					{
						name: "incomplete-tasks-remain",
						condition: "has_incomplete",
						action: "external",
						external: { command: ["echo", "hi"] },
					},
				],
			},
		);

		expect(config.messageDelivery).toMatchObject({
			customType: "todo-enforcer-global",
			deliverAs: "steer",
			display: false,
			triggerTurn: false,
		});
		expect(config.contextFeed).toEqual({
			includeSessionMetadata: false,
			assistantMode: "allSinceLatestUser",
			excludePreviousEnforcerMessages: true,
			userMode: "latest",
		});
		expect(config.rules).toEqual([
			{
				name: "incomplete-tasks-remain",
				condition: "has_incomplete",
				action: "external",
				external: { command: ["echo", "hi"] },
			},
		]);
	});

	it("falls back to defaults when rules are invalid", () => {
		const config = mergeConfigLayers({ rules: [] });

		expect(config.rules).toEqual(DEFAULT_CONFIG.rules);
	});

	it("loads defaults even when config files are missing", () => {
		const config = loadConfig(process.cwd());

		expect(config.messageDelivery).toBeDefined();
		expect(config.contextFeed).toBeDefined();
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("loads async defaults even when config files are missing", async () => {
		const config = await loadConfigAsync(process.cwd());

		expect(config.messageDelivery).toBeDefined();
		expect(config.contextFeed).toBeDefined();
		expect(config.rules.length).toBeGreaterThan(0);
	});
});

describe("interpolateTemplate", () => {
	it("renders todo and session context variables", () => {
		const rendered = interpolateTemplate(
			[
				"{{completed_count}}/{{total_count}}",
				"{{incomplete_list}}",
				"{{latest_user_message}}",
				"{{assistant_messages}}",
				"{{all_messages_since_latest_user}}",
				"{{session_metadata}}",
			].join("\n"),
			{
				incompleteCount: 1,
				completedCount: 2,
				totalCount: 3,
				incompleteList: "- [pending] #9 Ship it",
				completedList: "- [completed] #1 Done",
				sessionSummary: "session-123",
				latestUserMessage: "Please finish the feature",
				assistantMessages: "I am working on it",
				allMessagesSinceLatestUser:
					"user: Please finish\nassistant: I am working on it",
				sessionMetadata: '{"cwd":"/repo"}',
			},
		);

		expect(rendered).toContain("2/3");
		expect(rendered).toContain("Please finish the feature");
		expect(rendered).toContain("I am working on it");
		expect(rendered).toContain("user: Please finish");
		expect(rendered).toContain('{"cwd":"/repo"}');
	});
});

// ─── RED PHASE: new config fields (todoSource, respectProgressAutoClear, injectTodoPolicy, todoPolicyText) ─

describe("DEFAULT_CONFIG new todo-progress fields", () => {
	it("has todoSource='auto' by default", () => {
		expect(DEFAULT_CONFIG.todoSource).toBe("auto");
	});

	it("has respectProgressAutoClear=true by default", () => {
		expect(DEFAULT_CONFIG.respectProgressAutoClear).toBe(true);
	});

	it("has injectTodoPolicy=false by default", () => {
		expect(DEFAULT_CONFIG.injectTodoPolicy).toBe(false);
	});

	it("does not set a default todoPolicyText", () => {
		expect(DEFAULT_CONFIG.todoPolicyText).toBeUndefined();
	});
});

describe("mergeConfigLayers — new fields", () => {
	it("preserves todoSource override from project config", () => {
		const config = mergeConfigLayers(null, { todoSource: "todo-progress" });
		expect(config.todoSource).toBe("todo-progress");
	});

	it("preserves respectProgressAutoClear override from global config", () => {
		const config = mergeConfigLayers(
			{ respectProgressAutoClear: false },
			null,
		);
		expect(config.respectProgressAutoClear).toBe(false);
	});

	it("preserves injectTodoPolicy and todoPolicyText from project config", () => {
		const config = mergeConfigLayers(null, {
			injectTodoPolicy: true,
			todoPolicyText: "Custom policy",
		});
		expect(config.injectTodoPolicy).toBe(true);
		expect(config.todoPolicyText).toBe("Custom policy");
	});

	it("falls back to defaults when new fields are not provided", () => {
		const config = mergeConfigLayers(null, null);
		expect(config.todoSource).toBe("auto");
		expect(config.respectProgressAutoClear).toBe(true);
		expect(config.injectTodoPolicy).toBe(false);
	});
});

describe("TodoSource type validation", () => {
	it("accepts 'auto', 'branch', and 'todo-progress' as valid todoSource values", () => {
		for (const src of ["auto", "branch", "todo-progress"]) {
			const config = mergeConfigLayers(null, { todoSource: src });
			expect(config.todoSource).toBe(src);
		}
	});

	it("preserves an explicit todoSource='branch' override", () => {
		const config = mergeConfigLayers(
			{ todoSource: "branch" },
			{ todoSource: "todo-progress" },
		);
		// project overrides global
		expect(config.todoSource).toBe("todo-progress");
	});
});
