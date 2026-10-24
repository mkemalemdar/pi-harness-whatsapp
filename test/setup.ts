// Loaded before every test file (npm test: node --test --import ./test/setup.ts): the tests never touch the real data
// folder (log, settings, login).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phw-test-data-"));
process.env.PI_HARNESS_WHATSAPP_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
