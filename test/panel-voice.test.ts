// The Voice notes menu: ticking parts on and off, downloading and deleting speech files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MenuStack } from "../src/ui/panel-components.ts";
import type { SpeechInfo } from "../src/core/panel-model.ts";
import { type PanelHost, type SubmenuContext, voiceNotesMenu } from "../src/ui/panel.ts";
import { SettingsStore } from "../src/settings-store.ts";

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
		assert.equal(question(), "You set speech-to-text for removal. 828 MB will be freed.");
		press(KEY.enter); // Yes
		await Promise.resolve();
		assert.deepEqual(settings.get().voice, { understand: false, reply: true });
		assert.deepEqual(removed, [["whisper-large-v3-turbo-int8-ov"]]);
	});

	it("puts the tick back when the removal is refused (No or Esc)", () => {
		setVoice(true, true);
		open();
		press(KEY.space, KEY.escape, KEY.down, KEY.enter); // No
		assert.deepEqual(settings.get().voice, { understand: true, reply: true });
		open();
		press(KEY.down, KEY.space, KEY.escape, KEY.escape); // Esc on the question
		assert.deepEqual(settings.get().voice, { understand: true, reply: true });
		assert.equal(removed.length, 0);
	});

	it("offers to download a newly ticked part: now, or when first needed", () => {
		speech = { installed: new Set(), downloading: new Set(), sizesMB: {} };
		open();
		press(KEY.down, KEY.space, KEY.escape);
		assert.equal(question(), "Reply with voice notes needs text-to-speech (~596 MB download).");
		press(KEY.enter); // Now (recommended)
		assert.equal(downloads, 1);
		assert.deepEqual(settings.get().voice, { understand: false, reply: true });
		open();
		press(KEY.space, KEY.escape, KEY.escape); // understand too, then Esc = when first needed
		assert.equal(downloads, 1);
		assert.deepEqual(settings.get().voice, { understand: true, reply: true });
	});

	it("'Delete all speech files' unticks both and asks once", async () => {
		setVoice(true, true);
		open();
		press(KEY.down, KEY.down, KEY.enter, KEY.escape);
		assert.equal(question(), "You set speech-to-text and text-to-speech for removal. 1.4 GB will be freed.");
		press(KEY.enter);
		await Promise.resolve();
		assert.deepEqual(settings.get().voice, { understand: false, reply: false });
		assert.deepEqual(removed, [ALL]);
	});

	it("leaves quietly when nothing changed", () => {
		setVoice(true, false);
		open();
		press(KEY.escape);
		assert.equal(question(), undefined);
		assert.equal(removed.length, 0);
		assert.equal(downloads, 0);
	});
});
