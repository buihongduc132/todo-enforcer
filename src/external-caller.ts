/**
 * external-caller — Execute external commands for action="external" rules
 *
 * Runs an external command with session context on stdin.
 * Returns stdout as the injection message.
 */
// @ts-nocheck

// 


import { spawn } from "node:child_process";

import { createPluginLogger } from "./lib/plugin-logger";
import type {
	ExternalCallConfig,
	SessionContext,
	TodoSnapshot,
} from "./config";

const logger = createPluginLogger("todo-enforcer");

/** Default timeout for external calls (15 seconds). */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;

export interface ExternalCallResult {
	success: boolean;
	output: string;
	error?: string;
}

/**
 * Execute a child-process command with the session payload on stdin.
 */
export async function invokeCommand(
	command: string[],
	stdinPayload: string,
	timeoutMs: number,
	silent: boolean,
	snapshot: TodoSnapshot,
): Promise<ExternalCallResult> {
	if (!Array.isArray(command) || command.length === 0) {
		const error = "external.command must be a non-empty array";
		if (!silent) logger.error(error);
		return { success: false, output: "", error };
	}

	const [cmd, ...args] = command;
	const env = {
		...process.env,
		TODO_INCOMPLETE_COUNT: String(snapshot.incompleteCount),
		TODO_COMPLETED_COUNT: String(snapshot.completedCount),
		TODO_TOTAL_COUNT: String(snapshot.totalCount),
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string }>(
			(resolve, reject) => {
				const child = spawn(cmd, args, {
					env,
					stdio: ["pipe", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGKILL");
					reject(new Error("timeout"));
				}, timeoutMs);

				child.stdout.on("data", (d: Buffer) => {
					stdout += d.toString();
				});
				child.stderr.on("data", (d: Buffer) => {
					stderr += d.toString();
				});
				child.on("error", (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					reject(error);
				});
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					if (code !== 0) {
						reject(new Error(`exit code ${code}: ${stderr.trim()}`));
					} else {
						resolve({ stdout, stderr });
					}
				});
				child.stdin.write(stdinPayload);
				child.stdin.end();
			},
		);

		const output = result.stdout.trim();
		if (!output) {
			return {
				success: false,
				output: "",
				error: "external command produced no output",
			};
		}

		return { success: true, output };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!silent) {
			logger.error(`External call failed: ${message}`);
		}
		return { success: false, output: "", error: message };
	}
}

export async function invokeHttp(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	silent: boolean,
): Promise<ExternalCallResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			...init,
			signal: controller.signal,
		});
		const output = (await response.text()).trim();
		if (!response.ok) {
			return {
				success: false,
				output: "",
				error: `http ${response.status}: ${output}`,
			};
		}
		if (!output) {
			return {
				success: false,
				output: "",
				error: "external http call produced no output",
			};
		}
		return { success: true, output };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!silent) {
			logger.error(`External call failed: ${message}`);
		}
		return { success: false, output: "", error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Execute an external command or HTTP request with session context.
 */
export async function executeExternalCall(
	config: ExternalCallConfig,
	snapshot: TodoSnapshot,
	context: SessionContext,
): Promise<ExternalCallResult> {
	const timeoutMs = config.timeoutMs ?? config.http?.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
	const silent = config.silent ?? config.http?.silent ?? true;
	const stdinPayload = JSON.stringify({ snapshot, context }, null, 2);

	if (config.command) {
		return await invokeCommand(
			config.command,
			stdinPayload,
			timeoutMs,
			silent,
			snapshot,
		);
	}

	if (config.http) {
		return await invokeHttp(
			config.http.url,
			{
				method: config.http.method ?? "POST",
				headers: {
					"content-type": "application/json",
					...(config.http.headers ?? {}),
				},
				body: stdinPayload,
			},
			config.http.timeoutMs ?? timeoutMs,
			silent,
		);
	}

	const error = "external config requires either command or http";
	if (!silent) logger.error(error);
	return { success: false, output: "", error };
}

/**
 * Dummy external call function for testing.
 * Returns a fixed message with the snapshot info.
 * Synchronous — returns a pre-resolved Promise for API compatibility.
 */
export function dummyExternalCall(
	_config: ExternalCallConfig,
	snapshot: TodoSnapshot,
	context: SessionContext,
): Promise<ExternalCallResult> {
	return Promise.resolve({
		success: true,
		output:
			`[DUMMY CALL] Session has ${snapshot.incompleteCount} incomplete tasks and ` +
			`${snapshot.completedCount} completed. Latest user: ${context.latestUserMessage}`,
	});
}
