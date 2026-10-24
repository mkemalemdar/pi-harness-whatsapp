import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type PanelHost, showPanel } from "../src/panel.ts";
import { SettingsStore } from "../src/settings.ts";

// A plain-text theme: colours and bold are dropped, greyed text is wrapped in ░ so tests can see it.
const theme = { fg: (color: string, text: string) => (color === "dim" ? `░${text}░` : text), bold: (text: string) => text };
type Panel = { render(width: number): string[]; handleInput(data: string): void };

describe("the /whatsapp panel", () => {
	let dir: string;
	let settings: SettingsStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-render-"));
		settings = new SettingsStore(join(dir, "config.json"));
		settings.load();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function open(): Panel {
		let panel: Panel | undefined;
		const host = {
			settings,
			isEnabled: () => true,
			setEnabled: async () => {},
			connectionLabel: () => "connected as +905550000000 · 1 chat",
			isShowingQr: () => false,
			logFile: () => "/home/alex/.pi/agent/pi-harness-whatsapp/log/pi-harness-whatsapp.log",
			connectionCommand: async () => {},
			speechInfo: () => ({ installed: new Set<string>(), downloading: new Set<string>(), sizesMB: {} }),
			isInstalled: () => false,
			downloadMissing: () => {},
			removeSpeechFiles: async () => {},
			sendVoiceSample: async () => {},
		} as unknown as PanelHost;
		const ctx = {
			ui: {
				custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Panel) => {
					panel = factory({ requestRender() {} }, theme, {}, () => {});
					return new Promise(() => {});
				},
			},
		};
		void showPanel(ctx as never, host);
		return panel!;
	}
	const screen = (panel: Panel) => panel.render(100).map((line) => line.trimEnd()).join("\n");

	it("shows VOICE greyed out while voice is off, and DANGER with the log file at the bottom", () => {
		const text = screen(open());
		assert.match(text, /\[VOICE\][\s\S]*Voice notes\s+░off░[\s\S]*░\s*Reply type░\s+░text░[\s\S]*░\s*Voice per language░[\s\S]*░\s*Voice reply speed░/);
		assert.match(text, /\[DANGER\][\s\S]*Remove everything \(before uninstalling\)…[\s\S]*Log file: \/home\/alex/);
		assert.ok(!text.includes("TECHNICAL"));
		assert.ok(!text.includes("Speech files"));
	});

	it("explains a greyed-out row when it's selected", () => {
		const panel = open();
		for (let i = 0; i < 14; i++) panel.handleInput("\x1b[B"); // down to "Reply type"
		assert.ok(screen(panel).includes("Voice replies are off. Open “Voice notes” and tick “Reply with voice notes” to use this."));
		panel.handleInput("\r");
		assert.ok(screen(panel).includes("tick “Reply with voice notes” in Voice notes first"));
	});

	it("opens the Voice notes menu with both parts, their sizes and the delete button", () => {
		const panel = open();
		for (let i = 0; i < 13; i++) panel.handleInput("\x1b[B"); // down to "Voice notes"
		panel.handleInput("\r");
		const text = screen(panel);
		assert.match(text, /\[ \] Understand voice notes\s+░speech-to-text · 1\.0 GB░/);
		assert.match(text, /\[ \] Reply with voice notes\s+░text-to-speech · 603 MB░/);
		assert.match(text, /\n\s*\n\s+\[ Delete all speech files \]/);
	});
});
