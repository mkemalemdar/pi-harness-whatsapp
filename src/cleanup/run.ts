// Runs a program and collects its output. Never throws: a missing program comes back as code null.

import { spawn } from "node:child_process";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type Runner = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>;

export const run: Runner = (command, args, options = {}) =>
	new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...options.env },
			// npm.cmd and friends need a shell on Windows.
			shell: process.platform === "win32" && /\.cmd$/i.test(command),
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: stderr || error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});

/** The last non-empty line of a program's error output, for messages. */
export function lastLine(text: string): string {
	return text.trim().split("\n").filter(Boolean).pop()?.trim() ?? "";
}
