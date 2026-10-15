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

/**
 * When a process started (ms since epoch), on Linux. After a reboot or crash the
 * lock's pid can belong to an unrelated new process; one that started after the
 * lock was written can't be the holder.
 */
export function processStartedAt(pid: number): number | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 22 (start time, in clock ticks after boot) comes after the ")" that ends the name.
		const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
		const bootLine = readFileSync("/proc/stat", "utf8").split("\n").find((line) => line.startsWith("btime "));
		const boot = Number(bootLine?.split(" ")[1]);
		// Linux reports these in 1/100 s on every common setup.
		return Number.isFinite(ticks) && Number.isFinite(boot) ? (boot + ticks / 100) * 1000 : undefined;
	} catch {
		return undefined;
	}
}

function holds(holder: LockHolder): boolean {
	if (!isAlive(holder.pid)) return false;
	const started = processStartedAt(holder.pid);
	// A few seconds of slack for rounding.
	return started === undefined || holder.since === 0 || started <= holder.since + 5_000;
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
			if (holder && (holder.host !== me.host || holds(holder))) return { ok: false, holder };
			rmSync(this.file, { force: true });
		}
		const holder = readHolder(this.file);
		return holder ? { ok: false, holder } : { ok: false, holder: { pid: -1, host: "?", since: 0 } };
	}

	/** The live Pi process (not this one) that holds the lock, if any. */
	otherHolder(): LockHolder | undefined {
		const holder = readHolder(this.file);
		if (!holder || (holder.pid === this.pid && holder.host === hostname())) return undefined;
		return holder.host !== hostname() || holds(holder) ? holder : undefined;
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
