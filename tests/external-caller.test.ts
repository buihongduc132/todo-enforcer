// @ts-nocheck
// 
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_EXTERNAL_TIMEOUT_MS,
	dummyExternalCall,
	executeExternalCall,
	invokeCommand,
	invokeHttp,
} from "../src/external-caller";

const snapshot = {
	incompleteCount: 2,
	completedCount: 1,
	totalCount: 3,
	incompleteList: "- [pending] #1",
	completedList: "- [completed] #2",
	sessionSummary: "session-1",
	latestUserMessage: "User asked for status",
	assistantMessages: "Agent drafted summary",
	allMessagesSinceLatestUser:
		"user: User asked for status\nassistant: Agent drafted summary",
	sessionMetadata: '{"sessionId":"session-1"}',
};

const context = {
	latestUserMessage: "User asked for status",
	assistantMessages: "Agent drafted summary",
	allMessagesSinceLatestUser:
		"user: User asked for status\nassistant: Agent drafted summary",
	sessionMetadata: '{"sessionId":"session-1"}',
};

describe("invokeCommand", () => {
	it("returns an error for an empty command", async () => {
		const result = await invokeCommand([], "{}", 100, true, snapshot);

		expect(result.success).toBe(false);
		expect(result.error).toContain("non-empty array");
	});

	it("returns stdout for successful commands", async () => {
		const result = await invokeCommand(
			[process.execPath, "-e", 'process.stdout.write("ok")'],
			"{}",
			1000,
			true,
			snapshot,
		);

		expect(result).toEqual({ success: true, output: "ok" });
	});

	it("returns stderr-derived errors for failing commands", async () => {
		const result = await invokeCommand(
			[process.execPath, "-e", 'process.stderr.write("bad"); process.exit(2)'],
			"{}",
			1000,
			true,
			snapshot,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("exit code 2");
	});
});

describe("invokeHttp", () => {
	it("returns response text on success", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "dynamic reminder",
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await invokeHttp(
			"https://example.com/enforcer",
			{ method: "POST", body: "{}" },
			1000,
			true,
		);

		expect(result).toEqual({ success: true, output: "dynamic reminder" });
		vi.unstubAllGlobals();
	});

	it("returns an error for non-ok responses", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "server down",
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await invokeHttp(
			"https://example.com/enforcer",
			{ method: "POST", body: "{}" },
			1000,
			true,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("http 500: server down");
		vi.unstubAllGlobals();
	});

	it("returns an error when response body is empty", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "   ",
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await invokeHttp(
			"https://example.com/enforcer",
			{ method: "POST", body: "{}" },
			1000,
			true,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("produced no output");
		vi.unstubAllGlobals();
	});
});

describe("executeExternalCall", () => {
	it("returns an error when neither command nor http is configured", async () => {
		const result = await executeExternalCall({}, snapshot, context);

		expect(result.success).toBe(false);
		expect(result.error).toContain("requires either command or http");
	});

	it("posts session payload to http endpoints", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "dynamic reminder",
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await executeExternalCall(
			{
				http: {
					url: "https://example.com/enforcer",
					headers: { authorization: "Bearer token" },
				},
			},
			snapshot,
			context,
		);

		expect(result).toEqual({ success: true, output: "dynamic reminder" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://example.com/enforcer");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"content-type": "application/json",
			authorization: "Bearer token",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			snapshot,
			context,
		});

		vi.unstubAllGlobals();
	});
});

describe("DEFAULT_EXTERNAL_TIMEOUT_MS", () => {
	it("is 15 seconds", () => {
		expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBe(15_000);
	});
});

describe("dummyExternalCall", () => {
	it("includes latest user context in placeholder output", async () => {
		const result = await dummyExternalCall({}, snapshot, context);

		expect(result.success).toBe(true);
		expect(result.output).toContain("Latest user: User asked for status");
	});
});
