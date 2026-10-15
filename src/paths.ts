import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the extension keeps its data. PI_HARNESS_WHATSAPP_DIR overrides it
 * (used by tests); otherwise it lives next to Pi's own agent data.
 */
export function dataDir(): string {
	if (process.env.PI_HARNESS_WHATSAPP_DIR) return process.env.PI_HARNESS_WHATSAPP_DIR;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-harness-whatsapp");
}

export const paths = {
	config: () => join(dataDir(), "config.json"),
	auth: () => join(dataDir(), "auth"),
	models: () => join(dataDir(), "models"),
	inbox: () => join(dataDir(), "inbox"),
	logs: () => join(dataDir(), "log"),
	recents: () => join(dataDir(), "recents.json"),
	lock: () => join(dataDir(), "connection.lock"),
	announceMarker: () => join(dataDir(), "announce.json"),
};

/** Everything the extension creates in its data folder (temporary and backup files included). */
const OWN_ENTRIES = [
	/^config\.json(\..+)?$/, // settings, plus .tmp and .bad-<time> copies
	/^recents\.json(\..+)?$/,
	/^(auth|models|inbox|log)$/,
	/^connection\.lock$/,
	/^announce\.json$/,
	/^setup\.json$/, // what was installed for the extension (see cleanup/setup-record.ts)
];

/**
 * Deletes the extension's files, then the data folder itself if nothing else is
 * in it. Only names the extension creates are touched, so a custom
 * PI_HARNESS_WHATSAPP_DIR pointing at a shared folder is safe. Returns what
 * couldn't be deleted, as paths.
 */
export function removeDataDir(dir = dataDir()): string[] {
	if (!existsSync(dir)) return [];
	const left: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (!OWN_ENTRIES.some((pattern) => pattern.test(name))) {
			left.push(path);
			continue;
		}
		try {
			rmSync(path, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			left.push(path);
		}
	}
	if (left.length === 0) {
		try {
			rmdirSync(dir);
		} catch {
			left.push(dir);
		}
	}
	return left;
}
