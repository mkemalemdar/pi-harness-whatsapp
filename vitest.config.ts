import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never touch the real data folder (log, settings, login).
const dataDir = mkdtempSync(join(tmpdir(), "phw-test-data-"));

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		env: { PI_HARNESS_WHATSAPP_DIR: dataDir },
	},
});
