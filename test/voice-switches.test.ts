// Own file: it points the extension's data folder at a temporary one.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "phw-voice-switch-"));
const previous = process.env.PI_HARNESS_WHATSAPP_DIR;
beforeAll(() => {
	process.env.PI_HARNESS_WHATSAPP_DIR = dir;
});
afterAll(() => {
	process.env.PI_HARNESS_WHATSAPP_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});

const installed = (name: string) => {
	mkdirSync(join(dir, "models", name), { recursive: true });
	writeFileSync(join(dir, "models", name, ".complete"), "x");
};
const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: "/work",
	sessionManager: { getBranch: () => [] },
	ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, select: async () => undefined },
};
const pi = { getFlag: () => false, appendEntry: () => {}, getActiveTools: () => [], setActiveTools: () => {} };

describe("starting after an update", () => {
	it("keeps the voice parts whose files are on disk, and deletes leftovers from older versions", async () => {
		const { Controller } = await import("../src/controller.ts");
		writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, voiceMode: "off", languages: ["en", "tr"] }));
		installed("openvino-runtime");
		installed("whisper-large-v3-turbo-int8-ov");
		installed("vits-piper-tr_TR-dfki-medium");
		installed("sherpa-onnx-whisper-base");
		mkdirSync(join(dir, "models", ".sherpa-onnx-whisper-small.downloading"));
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		expect(controller.settings.get().voice).toEqual({ understand: true, reply: false });
		expect(controller.settings.get().voiceMode).toBe("off");
		expect(readdirSync(join(dir, "models")).sort()).toEqual(["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]);
		expect(controller.voice.neededModels().map((spec) => spec.name)).toEqual(["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]);
		await controller.onSessionShutdown();
	});

	it("leaves voice off for a new install", async () => {
		const { Controller } = await import("../src/controller.ts");
		rmSync(join(dir, "config.json"), { force: true });
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		expect(controller.settings.get().voice).toEqual({ understand: false, reply: false });
		expect(controller.voice.neededModels()).toEqual([]);
		expect(controller.voice.statusLine()).toBe("Voice: off");
		// Nothing was written just by starting.
		expect(existsSync(join(dir, "config.json"))).toBe(false);
		await controller.onSessionShutdown();
	});

	it.runIf(process.platform !== "win32")("makes the data folder and the login private, also for older installs", async () => {
		const { Controller } = await import("../src/controller.ts");
		mkdirSync(join(dir, "auth"), { recursive: true });
		writeFileSync(join(dir, "auth", "creds.json"), "{}");
		chmodSync(dir, 0o755);
		chmodSync(join(dir, "auth"), 0o755);
		chmodSync(join(dir, "auth", "creds.json"), 0o644);
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		const mode = (path: string) => statSync(path).mode & 0o777;
		expect([mode(dir), mode(join(dir, "auth")), mode(join(dir, "auth", "creds.json"))]).toEqual([0o700, 0o700, 0o600]);
		await controller.onSessionShutdown();
		// Folders created later are private from the start.
		const fresh = join(dir, "..", `${dir.split("/").pop()}-fresh`);
		const { SettingsStore } = await import("../src/settings.ts");
		const store = new SettingsStore(join(fresh, "config.json"));
		store.load();
		store.update((draft) => {
			draft.voiceSpeed = 1.1;
		});
		expect(mode(fresh)).toBe(0o700);
		rmSync(fresh, { recursive: true, force: true });
	});

	it("deletes a switched-off part's files, keeping the engine the other part needs", async () => {
		const { Controller } = await import("../src/controller.ts");
		installed("supertonic-3");
		const controller = new Controller(pi as never);
		controller.settings.load();
		controller.settings.update((draft) => {
			draft.voice = { understand: false, reply: true };
		});
		await controller.removeSpeechFiles(["whisper-large-v3-turbo-int8-ov"]);
		expect(readdirSync(join(dir, "models")).sort()).toEqual(["openvino-runtime", "supertonic-3"]);
	});
});
