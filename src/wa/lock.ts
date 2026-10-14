/**
 * Single-instance lock: only one Pi process may hold the WhatsApp login at a
 * time, otherwise the two connections keep kicking each other off.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockHolder {
	pid: number;
	host: string;
	since: number;
}

export type LockResult = { ok: true } | { ok: false; holder: LockHolder };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readHolder(file: string): LockHolder | undefined {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as Partial<LockHolder>;
		if (typeof data.pid === "number" && typeof data.host === "string") {
			return { pid: data.pid, host: data.host, since: typeof data.since === "number" ? data.since : 0 };
		}
	} catch {
		// Missing or unreadable lock: treated as free.
	}
	return undefined;
}

export class ConnectionLock {
	private held = false;

	constructor(
		private readonly file: string,
		private readonly pid = process.pid,
	) {}

	/** Takes the lock unless another live process on this machine holds it. */
	acquire(): LockResult {
		mkdirSync(dirname(this.file), { recursive: true });
		const me: LockHolder = { pid: this.pid, host: hostname(), since: Date.now() };
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				writeFileSync(this.file, JSON.stringify(me), { flag: "wx", mode: 0o600 });
				this.held = true;
				return { ok: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const holder = readHolder(this.file);
			if (holder && holder.pid === this.pid && holder.host === me.host) {
				this.held = true;
				return { ok: true };
			}
			// A lock from another machine (shared home dir) or a live process is respected.
			if (holder && (holder.host !== me.host || isAlive(holder.pid))) return { ok: false, holder };
			rmSync(this.file, { force: true });
		}
		const holder = readHolder(this.file);
		return holder ? { ok: false, holder } : { ok: false, holder: { pid: -1, host: "?", since: 0 } };
	}

	release(): void {
		if (!this.held) return;
		this.held = false;
		const holder = readHolder(this.file);
		if (holder && holder.pid === this.pid && holder.host === hostname()) rmSync(this.file, { force: true });
	}

	isHeld(): boolean {
		return this.held;
	}
}
