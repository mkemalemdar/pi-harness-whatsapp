/**
 * Collects what happened during one WhatsApp-started run: tool calls (and
 * whether they worked), files written or edited, and how long it took.
 */

import { isAbsolute, relative } from "node:path";

const FILE_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "apply_patch", "notebook_edit"]);

export interface ToolStep {
	id: string;
	name: string;
	/** Short description, e.g. the command or file path. */
	detail: string;
	status: "running" | "ok" | "failed";
}

function shorten(text: string, max = 48): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A one-line description of a tool call's arguments. */
export function describeArgs(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "file_path", "pattern", "query", "url", "name"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return shorten(value);
	}
	return name === "codemode" ? "script" : "";
}

function pathsFromArgs(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const found: string[] = [];
	for (const key of ["path", "file_path", "filePath"]) {
		const value = record[key];
		if (typeof value === "string" && value) found.push(value);
	}
	if (Array.isArray(record.edits)) {
		for (const edit of record.edits) found.push(...pathsFromArgs(edit));
	}
	return found;
}

export class RunReport {
	readonly startedAt: number;
	private readonly steps = new Map<string, ToolStep>();
	private readonly files = new Set<string>();

	constructor(
		private readonly cwd: string,
		now = Date.now(),
	) {
		this.startedAt = now;
	}

	toolStarted(id: string, name: string, args: unknown): ToolStep {
		const step: ToolStep = { id, name, detail: describeArgs(name, args), status: "running" };
		this.steps.set(id, step);
		if (FILE_TOOLS.has(name)) {
			for (const path of pathsFromArgs(args)) this.files.add(this.display(path));
		}
		return step;
	}

	toolEnded(id: string, isError: boolean): ToolStep | undefined {
		const step = this.steps.get(id);
		if (step) step.status = isError ? "failed" : "ok";
		return step;
	}

	get toolCount(): number {
		return this.steps.size;
	}

	get okCount(): number {
		return [...this.steps.values()].filter((step) => step.status === "ok").length;
	}

	recentSteps(limit: number): ToolStep[] {
		return [...this.steps.values()].slice(-limit);
	}

	touchedFiles(): string[] {
		return [...this.files].sort();
	}

	/** "✅ 4/6 tool calls ok · ⏱ 2m 14s" */
	summary(now = Date.now()): string {
		const total = this.toolCount;
		const ok = this.okCount;
		const icon = total === ok ? "✅" : "⚠️";
		const tools = total === 0 ? "no tool calls" : `${ok}/${total} tool call${total === 1 ? "" : "s"} ok`;
		return `${icon} ${tools} · ⏱ ${formatDuration(now - this.startedAt)}`;
	}

	private display(path: string): string {
		if (!isAbsolute(path)) return path;
		const inside = relative(this.cwd, path);
		return inside && !inside.startsWith("..") ? inside : path;
	}
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const STATUS_ICON: Record<ToolStep["status"], string> = { running: "⏳", ok: "✓", failed: "✗" };

/** The live "tool activity" message: the latest steps, newest last. */
export function formatActivity(steps: readonly ToolStep[], total: number): string {
	const lines = steps.map((step) => `🔧 ${step.name}${step.detail ? `: ${step.detail}` : ""} ${STATUS_ICON[step.status]}`);
	const hidden = total - steps.length;
	return [hidden > 0 ? `… ${hidden} earlier step${hidden === 1 ? "" : "s"}` : undefined, ...lines]
		.filter(Boolean)
		.join("\n");
}

export function formatTouchedFiles(files: readonly string[]): string | undefined {
	if (files.length === 0) return undefined;
	const shown = files.slice(0, 15).map((file) => `• ${file}`);
	if (files.length > 15) shown.push(`… and ${files.length - 15} more`);
	return `📝 Files changed:\n${shown.join("\n")}`;
}
