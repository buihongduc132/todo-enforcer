// @ts-nocheck
// 
// 
// 
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLoggerOptions {
	baseDir?: string;
	filePath?: string;
	maxBytes?: number;
	mirrorToConsole?: boolean;
}

export interface PluginLogger {
	readonly name: string;
	readonly filePath: string;
	debug(message: string, details?: unknown): void;
	info(message: string, details?: unknown): void;
	warn(message: string, details?: unknown): void;
	error(message: string, details?: unknown): void;
}

const DEFAULT_BASE_DIR = resolve(homedir(), ".pi", "logs", "extensions");
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const TRIM_TARGET_RATIO = 0.8;

function sanitizeFileName(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^-+|-+$/g, "") || "plugin"
	);
}

function normalizeDetails(details: unknown): string {
	if (details === undefined) return "";
	if (details instanceof Error) {
		return JSON.stringify({
			name: details.name,
			message: details.message,
			stack: details.stack,
		});
	}
	if (typeof details === "string") return details;
	try {
		return JSON.stringify(details);
	} catch (error) {
		return String(details);
	}
}

function buildLine(
	name: string,
	level: PluginLogLevel,
	message: string,
	details?: unknown,
): string {
	const suffix = normalizeDetails(details);
	return `${new Date().toISOString()} [${name}] ${level.toUpperCase()} ${message}${suffix ? ` ${suffix}` : ""}\n`;
}

function trimFileToLimit(filePath: string, maxBytes: number): void {
	if (!existsSync(filePath)) return;
	const stats = statSync(filePath);
	if (stats.size <= maxBytes) return;
	const targetBytes = Math.max(1, Math.floor(maxBytes * TRIM_TARGET_RATIO));
	const buffer = readFileSync(filePath);
	const start = Math.max(0, buffer.length - targetBytes);
	let trimmed = buffer.subarray(start);
	const newlineIndex = trimmed.indexOf(0x0a);
	if (newlineIndex >= 0 && newlineIndex < trimmed.length - 1) {
		trimmed = trimmed.subarray(newlineIndex + 1);
	}
	writeFileSync(filePath, trimmed);
}

function appendLine(filePath: string, line: string, maxBytes: number): void {
	mkdirSync(dirname(filePath), { recursive: true });
	if (existsSync(filePath)) {
		const currentSize = statSync(filePath).size;
		const incomingSize = Buffer.byteLength(line);
		if (currentSize + incomingSize > maxBytes) {
			trimFileToLimit(filePath, Math.max(incomingSize, maxBytes));
		}
	}
	appendFileSync(filePath, line, "utf8");
	trimFileToLimit(filePath, maxBytes);
}

function mirror(level: PluginLogLevel, line: string): void {
	const text = line.trimEnd();
	if (level === "error") {
		console.error(text);
		return;
	}
	if (level === "warn") {
		console.warn(text);
		return;
	}
	console.log(text);
}

export function createPluginLogger(
	name: string,
	options: PluginLoggerOptions = {},
): PluginLogger {
	const filePath = options.filePath
		? resolve(options.filePath)
		: resolve(
				options.baseDir ?? DEFAULT_BASE_DIR,
				`${sanitizeFileName(name)}.log`,
			);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
	const mirrorToConsole = options.mirrorToConsole ?? false;

	const write = (
		level: PluginLogLevel,
		message: string,
		details?: unknown,
	): void => {
		const line = buildLine(name, level, message, details);
		try {
			appendLine(filePath, line, maxBytes);
		} catch (error) {
			const fallback = buildLine(name, "error", "log-write-failed", error);
			console.error(fallback.trimEnd());
		}
		if (mirrorToConsole) {
			mirror(level, line);
		}
	};

	return {
		name,
		filePath,
		debug: (message, details) => write("debug", message, details),
		info: (message, details) => write("info", message, details),
		warn: (message, details) => write("warn", message, details),
		error: (message, details) => write("error", message, details),
	};
}
