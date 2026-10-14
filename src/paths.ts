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
	tmp: () => join(dataDir(), "tmp"),
	inbox: () => join(dataDir(), "inbox"),
	logs: () => join(dataDir(), "log"),
	recents: () => join(dataDir(), "recents.json"),
	lock: () => join(dataDir(), "connection.lock"),
	announceMarker: () => join(dataDir(), "announce.json"),
};
