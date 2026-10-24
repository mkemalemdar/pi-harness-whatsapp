// npm keeps a copy of every package it downloads in its cache (~/.npm/_cacache),
// even after the package is uninstalled. This removes the copies of this
// extension and of the packages it brought with it, and nothing else.

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run, type Runner } from "./run.ts";

export interface InstalledPackage {
	name: string;
	version: string;
}

const KEY_PREFIX = "make-fetch-happen:request-cache:";

/** The package in `packageDir` and everything it depends on, as installed (found the way Node finds them). */
export function installedTree(packageDir: string): InstalledPackage[] {
	const seen = new Map<string, InstalledPackage>();
	const visit = (dir: string) => {
		if (seen.has(dir)) return;
		let manifest: { name?: unknown; version?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
		try {
			manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		} catch {
			return;
		}
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
		seen.set(dir, { name: manifest.name, version: manifest.version });
		for (const name of Object.keys({ ...manifest.optionalDependencies, ...manifest.dependencies })) {
			const found = findPackage(dir, name);
			if (found) visit(found);
		}
	};
	visit(packageDir);
	return [...seen.values()];
}

function findPackage(from: string, name: string): string | undefined {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The cache entries that belong to `packages`: each one's metadata and its
 * tarball (every version for the first package, this extension itself).
 */
export function cacheKeysFor(keys: readonly string[], packages: readonly InstalledPackage[]): string[] {
	const [self] = packages;
	// Installs from a local file or folder are cached under the path ("pacote:tarball:file:…/pi-harness-whatsapp-0.1.1.tgz").
	const localCopy = self ? new RegExp(`[/:]${self.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|/|@|-\\d)`) : undefined;
	const metadata = new Set(packages.map((pkg) => `/${pkg.name.replace("/", "%2f")}`.toLowerCase()));
	const tarballs = new Set(packages.map((pkg) => `/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`));
	return keys.filter((key) => {
		if (!key.startsWith(KEY_PREFIX)) return key.startsWith("pacote:") && !!localCopy?.test(key);
		let path: string;
		try {
			path = new URL(key.slice(KEY_PREFIX.length)).pathname;
		} catch {
			return false;
		}
		const lower = path.toLowerCase();
		if ([...metadata].some((suffix) => lower.endsWith(suffix))) return true;
		if ([...tarballs].some((suffix) => path.endsWith(suffix))) return true;
		const base = self?.name.split("/").pop();
		return !!self && path.endsWith(".tgz") && path.includes(`/${self.name}/-/${base}-`);
	});
}

/** npm's own command-line script next to the Node that runs Pi, or `npm` from the PATH. */
export function npmCommand(): { command: string; args: string[] } {
	const bin = dirname(process.execPath);
	for (const cli of [join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "node_modules", "npm", "bin", "npm-cli.js")]) {
		if (existsSync(cli)) return { command: process.execPath, args: [cli] };
	}
	return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

/** Where npm keeps its cache: npm's own setting, else its default folder. */
async function npmCacheDir(runner: Runner): Promise<string> {
	const npm = npmCommand();
	const configured = (await runner(npm.command, [...npm.args, "config", "get", "cache"], { timeoutMs: 60_000 })).stdout.trim();
	if (configured && existsSync(configured)) return configured;
	return process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? homedir(), "npm-cache") : join(homedir(), ".npm");
}

/**
 * Removes this extension's packages from npm's cache. The cache's own files
 * are read and edited directly: `npm cache ls` hides parts of paths that look
 * like secrets, and `npm cache clean` leaves the names of deleted entries
 * behind. An entry's content is only deleted when no other entry uses it.
 * Returns how many entries were removed.
 */
export async function cleanNpmCache(packageDir: string, runner: Runner = run, cacheDir?: string): Promise<number> {
	const packages = installedTree(packageDir);
	if (packages.length === 0) return 0;
	const cache = join(cacheDir ?? (await npmCacheDir(runner)), "_cacache");
	const index = join(cache, "index-v5");
	if (!existsSync(index)) return 0;

	// Every index file, with its entries. The last entry for a key is the current one.
	const files = new Map<string, Array<{ key: string; integrity: string | null }>>();
	for (const file of filesUnder(index)) {
		const entries: Array<{ key: string; integrity: string | null }> = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const json = line.slice(line.indexOf("\t") + 1);
			if (!line.trim() || !json) continue;
			try {
				const entry = JSON.parse(json) as { key?: unknown; integrity?: unknown };
				if (typeof entry.key === "string") entries.push({ key: entry.key, integrity: typeof entry.integrity === "string" ? entry.integrity : null });
			} catch {
				// A half-written line: not ours to judge.
			}
		}
		files.set(file, entries);
	}
	const current = new Map<string, string | null>();
	for (const entries of files.values()) for (const entry of entries) current.set(entry.key, entry.integrity);
	const ours = new Set(cacheKeysFor([...current.keys()], packages));
	if (ours.size === 0) return 0;

	// Content still used by an entry that isn't ours stays.
	const usedByOthers = new Set<string>();
	for (const [key, integrity] of current) if (!ours.has(key) && integrity) for (const hash of integrity.split(/\s+/)) usedByOthers.add(hash);
	for (const key of ours) {
		for (const hash of (current.get(key) ?? "").split(/\s+/).filter(Boolean)) {
			if (usedByOthers.has(hash)) continue;
			const path = contentPath(cache, hash);
			if (path) removeFile(path, cache);
		}
	}
	// Index files that only hold our entries go entirely (npm would keep the names).
	for (const [file, entries] of files) {
		if (entries.length > 0 && entries.every((entry) => ours.has(entry.key))) removeFile(file, cache);
	}
	return ours.size;
}

/** "sha512-<base64>" → content-v2/sha512/ab/cd/ef… */
function contentPath(cache: string, hash: string): string | undefined {
	const match = /^(sha\d+)-([A-Za-z0-9+/=]+)$/.exec(hash);
	if (!match) return undefined;
	const hex = Buffer.from(match[2]!, "base64").toString("hex");
	return join(cache, "content-v2", match[1]!, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function filesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(path));
		else if (entry.isFile()) found.push(path);
	}
	return found;
}

/** Deletes a file and the folders above it that become empty (up to the cache folder). */
function removeFile(path: string, stopAt: string): void {
	try {
		rmSync(path, { force: true });
		for (let dir = dirname(path); dir.startsWith(stopAt) && dir !== stopAt; dir = dirname(dir)) {
			if (readdirSync(dir).length > 0) break;
			rmdirSync(dir);
		}
	} catch {
		// Gone already, or busy: leave it.
	}
}
