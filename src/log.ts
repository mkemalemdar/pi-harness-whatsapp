/**
 * File logger with simple size-based rotation. Never logs message text or
 * credentials — only what happened, when, and with whom.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { isRemoved } from "./removed.ts";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

let minLevel: Level = process.env.PI_HARNESS_WHATSAPP_DEBUG ? "debug" : "info";

function file(): string {
	return join(paths.logs(), "pi-harness-whatsapp.log");
}

function rotateIfNeeded(target: string): void {
	try {
		if (existsSync(target) && statSync(target).size > MAX_BYTES) renameSync(target, `${target}.1`);
	} catch {
		// Rotation is best-effort.
	}
}

function serialize(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, (_key, inner) => (inner instanceof Uint8Array ? `<${inner.length} bytes>` : inner));
	} catch {
		return String(value);
	}
}

function write(level: Level, scope: string, parts: unknown[]): void {
	if (LEVELS[level] < LEVELS[minLevel] || isRemoved()) return;
	try {
		mkdirSync(paths.logs(), { recursive: true });
		const target = file();
		rotateIfNeeded(target);
		const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${parts.map(serialize).join(" ")}\n`;
		appendFileSync(target, line, { mode: 0o600 });
	} catch {
		// Logging must never break the extension.
	}
}

export interface Logger {
	debug(...parts: unknown[]): void;
	info(...parts: unknown[]): void;
	warn(...parts: unknown[]): void;
	error(...parts: unknown[]): void;
}

export function createLogger(scope: string): Logger {
	return {
		debug: (...parts) => write("debug", scope, parts),
		info: (...parts) => write("info", scope, parts),
		warn: (...parts) => write("warn", scope, parts),
		error: (...parts) => write("error", scope, parts),
	};
}

export function setDebugLogging(on: boolean): void {
	minLevel = on ? "debug" : "info";
}

export function logFilePath(): string {
	return file();
}

/**
 * The logger shape Baileys expects (pino-like). Baileys is chatty, so only
 * warnings and errors reach the file unless debug logging is on.
 */
export interface BaileysLogger {
	level: string;
	child(bindings: Record<string, unknown>): BaileysLogger;
	trace(obj: unknown, msg?: string): void;
	debug(obj: unknown, msg?: string): void;
	info(obj: unknown, msg?: string): void;
	warn(obj: unknown, msg?: string): void;
	error(obj: unknown, msg?: string): void;
}

export function createBaileysLogger(scope = "baileys"): BaileysLogger {
	const log = createLogger(scope);
	const debugOn = () => minLevel === "debug";
	const parts = (obj: unknown, msg?: string) => (msg ? [msg, obj] : [obj]);
	const logger: BaileysLogger = {
		level: debugOn() ? "debug" : "warn",
		child: () => logger,
		trace: () => {},
		debug: (obj, msg) => {
			if (debugOn()) log.debug(...parts(obj, msg));
		},
		info: (obj, msg) => {
			if (debugOn()) log.info(...parts(obj, msg));
		},
		warn: (obj, msg) => log.warn(...parts(obj, msg)),
		error: (obj, msg) => log.error(...parts(obj, msg)),
	};
	return logger;
}
