// Own file: "Remove everything" sets a process-wide flag that stops all file writes.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(mkdtempSync(join(tmpdir(), "phw-remove-")), "pi-harness-whatsapp");
const previous = process.env.PI_HARNESS_WHATSAPP_DIR;

beforeAll(() => {
	process.env.PI_HARNESS_WHATSAPP_DIR = dir;
});
afterAll(() => {
	process.env.PI_HARNESS_WHATSAPP_DIR = previous;
	rmSync(join(dir, ".."), { recursive: true, force: true });
});

/** A data folder like a real install leaves behind. */
function fillDataDir(): void {
	for (const sub of ["auth", "models/supertonic-3/onnx", "models/.whisper.downloading", "inbox", "log"]) mkdirSync(join(dir, sub), { recursive: true });
	for (const file of [
		"config.json",
		"config.json.bad-1700000000000",
		"config.json.123.tmp",
		"recents.json",
		"connection.lock",
		"announce.json",
		"auth/creds.json",
		"models/supertonic-3/onnx/vocoder.onnx",
		"inbox/report.pdf",
		"log/pi-harness-whatsapp.log",
		"log/pi-harness-whatsapp.log.1",
	]) {
		writeFileSync(join(dir, file), "x");
	}
}

describe("removeDataDir", () => {
	it("deletes only the extension's own files, and the folder once it's empty", async () => {
		const { removeDataDir } = await import("../src/paths.ts");
		fillDataDir();
		writeFileSync(join(dir, "someone-elses-notes.txt"), "keep me");
		expect(removeDataDir(dir)).toEqual([join(dir, "someone-elses-notes.txt")]);
		expect(readdirSync(dir)).toEqual(["someone-elses-notes.txt"]);
		rmSync(join(dir, "someone-elses-notes.txt"));
		expect(removeDataDir(dir)).toEqual([]);
		expect(existsSync(dir)).toBe(false);
	});
});

describe("a Pi that never turns WhatsApp on", () => {
	it("writes no files at all", async () => {
		const { Controller } = await import("../src/controller.ts");
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/work",
			sessionManager: { getBranch: () => [] },
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, select: async () => undefined },
		};
		const pi = { getFlag: () => false, appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} };
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		await controller.onSessionShutdown();
		expect(existsSync(dir)).toBe(false);
	});
});

describe("Remove everything", () => {
	it("deletes every file, and nothing writes files again afterwards", async () => {
		const { Controller } = await import("../src/controller.ts");
		const { createLogger } = await import("../src/log.ts");
		fillDataDir();
		const notices: string[] = [];
		const statuses: Array<string | undefined> = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: "/work",
			sessionManager: { getBranch: () => [] },
			ui: {
				confirm: async (_title: string) => true,
				notify: (text: string) => notices.push(text),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				setWidget: () => {},
			},
		};
		const pi = { getFlag: () => false, appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} };
		const controller = new Controller(pi as never);
		const cleaned: string[] = [];
		controller.cleanup.npmCache = async (packageDir) => {
			cleaned.push(packageDir);
			return 12;
		};
		controller.cleanup.removeItem = async (item) => {
			cleaned.push(item.what);
			return { ok: true, message: `removed ${item.what} (2 packages)` };
		};
		writeFileSync(
			join(dir, "setup.json"),
			JSON.stringify({ version: 1, installed: [{ what: "ffmpeg", manager: "apt", packages: ["ffmpeg", "libavcodec61"] }, { what: "tmux", manager: "apt", packages: ["tmux"] }] }),
		);
		const asked: string[] = [];
		ctx.ui.confirm = async (title: string) => {
			asked.push(title);
			return title !== "Also remove tmux?";
		};
		controller.settings.load();
		await controller.removeEverything(ctx as never);
		expect(asked).toEqual(["Remove everything?", "Also remove ffmpeg?", "Also remove tmux?"]);
		expect(cleaned).toEqual([join(import.meta.dirname, ".."), "ffmpeg"]);
		expect(notices.at(-1)).toContain("✓ Removed 12 cached downloads from npm's cache.");
		expect(notices.at(-1)).toContain("✓ Removed ffmpeg (2 packages).");
		expect(notices.at(-1)).toContain("• Kept tmux.");

		expect(existsSync(dir)).toBe(false);
		expect(notices.at(-1)).toContain("✓ No WhatsApp login was linked.");
		expect(notices.at(-1)).toContain(`✓ Deleted ${dir}.`);
		expect(notices.at(-1)).toContain("pi uninstall npm:pi-harness-whatsapp");

		// Everything that used to write stays quiet now.
		controller.settings.update((draft) => {
			draft.voiceSpeed = 1.2;
		});
		controller.recents.see({ jid: "905551234567@s.whatsapp.net", at: Date.now() });
		controller.recents.flush();
		createLogger("test").error("this must not be written");
		await expect(controller.voice.models.ensure((await import("../src/voice/models.ts")).WHISPER_SPEC)).rejects.toThrow(/removed/);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		await controller.onSessionShutdown();
		expect(existsSync(dir)).toBe(false);
		expect(statuses.at(-1)).toMatch(/^WA: removed/);
	});
});
