// setup.json, in the data folder: programs installed on this computer just for
// this extension (ffmpeg, tmux…), written by whoever set it up (see
// AGENT_INSTALL.md). "Remove everything" offers to remove exactly those
// packages again, and never anything installed later that needs them.
//
//   { "version": 1, "installed": [ { "what": "ffmpeg", "manager": "apt",
//     "packages": ["ffmpeg", "libavcodec61", …], "at": "2026-10-15", "by": "Claude Code" } ] }
//
// Only known package managers and plain package names are accepted, so the
// file can't be used to run other commands.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lastLine, run, type Runner } from "./run.ts";

export const SETUP_FILE = "setup.json";
export const MANAGERS = ["apt", "dnf", "pacman", "zypper", "apk", "brew", "winget"] as const;
export type Manager = (typeof MANAGERS)[number];

export interface SetupItem {
	what: string;
	manager: Manager;
	packages: string[];
	at?: string;
	by?: string;
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._@-]*(:[a-z0-9_-]+)?$/;
const APT_ARCHIVES = "/var/cache/apt/archives";

const shortText = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() && value.length <= 80 ? value.replace(/[^\p{L}\p{N} .,:()+_/-]/gu, "").trim() || undefined : undefined;

/** The valid entries of setup.json in `dir`; anything malformed is skipped. */
export function readSetupRecord(dir: string): SetupItem[] {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(dir, SETUP_FILE), "utf8"));
	} catch {
		return [];
	}
	const entries = (raw as { installed?: unknown })?.installed;
	if (!Array.isArray(entries)) return [];
	const items: SetupItem[] = [];
	for (const entry of entries as Array<Record<string, unknown>>) {
		const what = shortText(entry?.what);
		const manager = MANAGERS.find((name) => name === entry?.manager);
		const packages = Array.isArray(entry?.packages) ? entry.packages : [];
		if (!what || !manager || packages.length === 0 || packages.length > 1000) continue;
		if (!packages.every((name): name is string => typeof name === "string" && PACKAGE_NAME.test(name))) continue;
		const at = shortText(entry.at);
		const by = shortText(entry.by);
		items.push({ what, manager, packages: [...new Set(packages)], ...(at ? { at } : {}), ...(by ? { by } : {}) });
	}
	return items;
}

/** "ffmpeg (98 packages, with apt, on 2026-10-15 by Claude Code)" */
export function describeItem(item: SetupItem): string {
	const count = item.packages.length === 1 ? "1 package" : `${item.packages.length} packages`;
	return `${item.what} (${count}, with ${item.manager}${item.at ? `, on ${item.at}` : ""}${item.by ? ` by ${item.by}` : ""})`;
}

/** The command a person would run to remove the item. */
export function manualCommand(item: SetupItem): string {
	const list = item.packages.join(" ");
	switch (item.manager) {
		case "apt":
			return `sudo apt-get remove --purge ${list}`;
		case "dnf":
			return `sudo dnf remove ${list}`;
		case "pacman":
			return `sudo pacman -Rn ${list}`;
		case "zypper":
			return `sudo zypper remove ${list}`;
		case "apk":
			return `sudo apk del ${list}`;
		case "brew":
			return `brew uninstall ${list} && brew cleanup ${list}`;
		case "winget":
			return item.packages.map((id) => `winget uninstall --id ${id}`).join(" ; ");
	}
}

export interface RemovalResult {
	ok: boolean;
	message: string;
	/** What to run by hand when it couldn't be done here. */
	command?: string;
}

const stripArch = (name: string) => name.replace(/:[a-z0-9_-]+$/, "");

/**
 * Removes the item's packages. Done here for apt (checked with a dry run
 * first) and Homebrew (which refuses on its own when something else needs
 * them); for other package managers, the command to run is returned.
 */
export async function removeItem(item: SetupItem, runner: Runner = run, isRoot = process.getuid?.() === 0): Promise<RemovalResult> {
	const command = manualCommand(item);
	if (item.manager === "apt") return removeApt(item, runner, isRoot, command);
	if (item.manager === "brew") {
		if (isRoot) return { ok: false, message: "Homebrew can't run as root", command };
		const removed = await runner("brew", ["uninstall", ...item.packages], { timeoutMs: 600_000 });
		if (removed.code !== 0) return { ok: false, message: lastLine(removed.stderr) || "brew uninstall failed", command };
		await runner("brew", ["cleanup", ...item.packages], { timeoutMs: 600_000 });
		return { ok: true, message: `removed ${item.what}` };
	}
	return { ok: false, message: `remove it with ${item.manager}`, command };
}

async function removeApt(item: SetupItem, runner: Runner, isRoot: boolean, command: string): Promise<RemovalResult> {
	const installed = await aptInstalled(item.packages, runner);
	if (installed.length === 0) return { ok: true, message: `${item.what} was already removed` };
	const sudo = isRoot ? false : (await runner("sudo", ["-n", "true"])).code === 0 ? true : null;
	if (sudo === null) return { ok: false, message: "needs your password", command };

	// Dry run: never remove anything that isn't on the list (e.g. a program installed later that needs these).
	const dryRun = await runner("apt-get", ["-s", "remove", "--purge", ...installed], { timeoutMs: 120_000 });
	if (dryRun.code !== 0) return { ok: false, message: lastLine(dryRun.stderr) || "apt couldn't plan the removal", command };
	const listed = new Set(item.packages.map(stripArch));
	const wouldRemove = [...dryRun.stdout.matchAll(/^(?:Remv|Purg) (\S+)/gm)].map((match) => stripArch(match[1]!));
	const others = [...new Set(wouldRemove.filter((name) => !listed.has(name)))];
	if (others.length > 0) {
		return { ok: false, message: `kept: removing it would also remove ${others.slice(0, 5).join(", ")}${others.length > 5 ? "…" : ""}, installed later`, command };
	}

	const apt = ["apt-get", "remove", "--purge", "-y", ...installed];
	const removed = sudo
		? await runner("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", ...apt], { timeoutMs: 600_000 })
		: await runner(apt[0]!, apt.slice(1), { env: { DEBIAN_FRONTEND: "noninteractive" }, timeoutMs: 600_000 });
	if (removed.code !== 0) return { ok: false, message: lastLine(removed.stderr) || "apt-get failed", command };

	// apt keeps the downloaded .deb files; delete the ones of these packages.
	const debs = existsSync(APT_ARCHIVES)
		? readdirSync(APT_ARCHIVES)
				.filter((file) => file.endsWith(".deb") && [...listed].some((name) => file.startsWith(`${name}_`)))
				.map((file) => join(APT_ARCHIVES, file))
		: [];
	if (debs.length > 0) {
		if (sudo) await runner("sudo", ["-n", "rm", "-f", ...debs]);
		else for (const file of debs) rmSync(file, { force: true });
	}
	const left = await aptInstalled(installed, runner);
	if (left.length > 0) return { ok: false, message: `still installed: ${left.slice(0, 5).join(", ")}`, command };
	return { ok: true, message: `removed ${item.what} (${installed.length} package${installed.length === 1 ? "" : "s"})` };
}

/** Which of `packages` dpkg reports as installed. */
async function aptInstalled(packages: readonly string[], runner: Runner): Promise<string[]> {
	const result = await runner("dpkg-query", ["-W", "-f=${Package}\t${Status}\n", ...packages]);
	const installed = new Set(
		result.stdout
			.split("\n")
			.filter((line) => line.endsWith("install ok installed"))
			.map((line) => line.split("\t")[0]!),
	);
	return packages.filter((name) => installed.has(stripArch(name)));
}
