// Own file: it points the extension's data folder at a temporary one.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "phw-voice-switch-"));
const previous = process.env.PI_HARNESS_WHATSAPP_DIR;
before(() => {
	process.env.PI_HARNESS_WHATSAPP_DIR = dir;
});
after(() => {
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
		assert.deepEqual(controller.settings.get().voice, { understand: true, reply: false });
		assert.equal(controller.settings.get().voiceMode, "off");
		assert.deepEqual(readdirSync(join(dir, "models")).sort(), ["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]);
		assert.deepEqual(controller.voice.neededModels().map((spec) => spec.name), ["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]);
		await controller.onSessionShutdown();
	});

	it("leaves voice off for a new install", async () => {
		const { Controller } = await import("../src/controller.ts");
		rmSync(join(dir, "config.json"), { force: true });
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		assert.deepEqual(controller.settings.get().voice, { understand: false, reply: false });
		assert.equal(controller.voice.neededModels().length, 0);
		assert.equal(controller.voice.statusLine(), "Voice: off");
		// Nothing was written just by starting.
		assert.equal(existsSync(join(dir, "config.json")), false);
		await controller.onSessionShutdown();
	});

	it("makes the data folder and the login private, also for older installs", { skip: process.platform === "win32" && "file modes don't apply on Windows" }, async () => {
		const { Controller } = await import("../src/controller.ts");
		mkdirSync(join(dir, "auth"), { recursive: true });
		writeFileSync(join(dir, "auth", "creds.json"), "{}");
		chmodSync(dir, 0o755);
		chmodSync(join(dir, "auth"), 0o755);
		chmodSync(join(dir, "auth", "creds.json"), 0o644);
		const controller = new Controller(pi as never);
		await controller.onSessionStart({ type: "session_start", reason: "startup" } as never, ctx as never);
		const mode = (path: string) => statSync(path).mode & 0o777;
		assert.deepEqual([mode(dir), mode(join(dir, "auth")), mode(join(dir, "auth", "creds.json"))], [0o700, 0o700, 0o600]);
		await controller.onSessionShutdown();
		// Folders created later are private from the start.
		const fresh = join(dir, "..", `${dir.split("/").pop()}-fresh`);
		const { SettingsStore } = await import("../src/settings.ts");
		const store = new SettingsStore(join(fresh, "config.json"));
		store.load();
		store.update((draft) => {
			draft.voiceSpeed = 1.1;
		});
		assert.equal(mode(fresh), 0o700);
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
		assert.deepEqual(readdirSync(join(dir, "models")).sort(), ["openvino-runtime", "supertonic-3"]);
	});
});
