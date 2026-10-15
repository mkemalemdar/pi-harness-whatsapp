import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MenuStack } from "../src/panel-components.ts";
import type { SpeechInfo } from "../src/panel-model.ts";
import { type PanelHost, type SubmenuContext, voiceNotesMenu } from "../src/panel.ts";
import { SettingsStore } from "../src/settings.ts";

const ALL = ["openvino-runtime", "whisper-large-v3-turbo-int8-ov", "supertonic-3"];
const KEY = { space: " ", enter: "\r", escape: "\x1b", down: "\x1b[B" };

describe("Voice notes menu", () => {
	let dir: string;
	let settings: SettingsStore;
	let removed: string[][];
	let downloads: number;
	let speech: SpeechInfo;
	let stack: MenuStack;
	let question: () => string | undefined;
	let open: () => void;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-panel-voice-"));
		settings = new SettingsStore(join(dir, "config.json"));
		settings.load();
		removed = [];
		downloads = 0;
		speech = { installed: new Set(ALL), downloading: new Set(), sizesMB: { "openvino-runtime": 202, "whisper-large-v3-turbo-int8-ov": 828, "supertonic-3": 401 } };
		stack = new MenuStack(() => {});
		const host = {
			settings,
			speechInfo: () => speech,
			removeSpeechFiles: async (names: readonly string[]) => {
				removed.push([...names]);
			},
			downloadMissing: () => {
				downloads++;
			},
		} as unknown as PanelHost;
		const context: SubmenuContext = { path: "WhatsApp › Voice", host, theme: {} as never, stack, render: () => {}, refreshValues: () => {}, finish: () => {} };
		stack.push({ render: () => [], invalidate() {}, handleInput() {} }); // the main panel
		open = () => stack.push(voiceNotesMenu(context));
		// The question screens show their question as the description.
		question = () => (stack.top() as unknown as { options?: { description?: string } }).options?.description;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const press = (...keys: string[]) => {
		for (const key of keys) stack.handleInput(key);
	};
	const setVoice = (understand: boolean, reply: boolean) =>
		settings.update((draft) => {
			draft.voice = { understand, reply };
		});

	it("asks before deleting an unticked part, then deletes it", async () => {
		setVoice(true, true);
		open();
		press(KEY.space, KEY.escape);
		expect(question()).toBe("You set speech-to-text for removal. 828 MB will be freed.");
		press(KEY.enter); // Yes
		await Promise.resolve();
		expect(settings.get().voice).toEqual({ understand: false, reply: true });
		expect(removed).toEqual([["whisper-large-v3-turbo-int8-ov"]]);
	});

	it("puts the tick back when the removal is refused (No or Esc)", () => {
		setVoice(true, true);
		open();
		press(KEY.space, KEY.escape, KEY.down, KEY.enter); // No
		expect(settings.get().voice).toEqual({ understand: true, reply: true });
		open();
		press(KEY.down, KEY.space, KEY.escape, KEY.escape); // Esc on the question
		expect(settings.get().voice).toEqual({ understand: true, reply: true });
		expect(removed).toEqual([]);
	});

	it("offers to download a newly ticked part: now, or when first needed", () => {
		speech = { installed: new Set(), downloading: new Set(), sizesMB: {} };
		open();
		press(KEY.down, KEY.space, KEY.escape);
		expect(question()).toBe("Reply with voice notes needs text-to-speech (~596 MB download).");
		press(KEY.enter); // Now (recommended)
		expect(downloads).toBe(1);
		expect(settings.get().voice).toEqual({ understand: false, reply: true });
		open();
		press(KEY.space, KEY.escape, KEY.escape); // understand too, then Esc = when first needed
		expect(downloads).toBe(1);
		expect(settings.get().voice).toEqual({ understand: true, reply: true });
	});

	it("'Delete all speech files' unticks both and asks once", async () => {
		setVoice(true, true);
		open();
		press(KEY.down, KEY.down, KEY.enter, KEY.escape);
		expect(question()).toBe("You set speech-to-text and text-to-speech for removal. 1.4 GB will be freed.");
		press(KEY.enter);
		await Promise.resolve();
		expect(settings.get().voice).toEqual({ understand: false, reply: false });
		expect(removed).toEqual([ALL]);
	});

	it("leaves quietly when nothing changed", () => {
		setVoice(true, false);
		open();
		press(KEY.escape);
		expect(question()).toBeUndefined();
		expect(removed).toEqual([]);
		expect(downloads).toBe(0);
	});
});
