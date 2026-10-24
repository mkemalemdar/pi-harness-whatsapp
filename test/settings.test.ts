// Settings: defaults, repairing bad values, contacts, voice switches, the per-session state.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addLanguage, clampSpeed, defaultSettings, MIRROR, normalizeContactId, normalizeSettings, removeLanguage, restoreSessionState, SESSION_ENTRY_TYPE, replyMode } from "../src/core/settings.ts";
import { SettingsStore } from "../src/settings-store.ts";

describe("normalizeSettings", () => {
	it("returns defaults for garbage", () => {
		assert.deepEqual(normalizeSettings(null), defaultSettings());
		assert.deepEqual(normalizeSettings("x"), defaultSettings());
		assert.deepEqual(normalizeSettings([1, 2]), defaultSettings());
	});

	it("keeps valid values and repairs invalid ones", () => {
		const settings = normalizeSettings({
			voiceMode: "voice+text",
			speechModel: "huge",
			voiceSpeed: 9,
			languages: ["tr", "xx", "en", "tr"],
			voices: { tr: "M2", en: "not-a-voice" },
			replyLanguage: "de",
			replies: { summary: true, interim: "yes" },
		});
		assert.equal(settings.voiceMode, "voice+text");
		assert.equal(settings.voiceSpeed, 2);
		assert.deepEqual(settings.languages, ["tr", "en"]);
		assert.deepEqual(settings.voices, { tr: "M2", en: "F1" });
		assert.equal(settings.replyLanguage, MIRROR);
		assert.deepEqual(settings.replies, { summary: true, interim: false, touchedFiles: false, toolActivity: false, terminal: false });
	});

	it("falls back to English when no language is valid", () => {
		assert.deepEqual(normalizeSettings({ languages: ["xx"] }).languages, ["en"]);
	});

	it("drops broken and duplicate contacts", () => {
		const settings = normalizeSettings({
			contacts: [
				{ id: "+90 555 123 45 67", name: " Alex ", owner: true },
				{ id: "905551234567" },
				{ id: "abc" },
				{ id: "120363000000000001@g.us", name: "Team" },
				{ nope: true },
			],
		});
		assert.deepEqual(settings.contacts, [
			{ id: "905551234567", name: "Alex", owner: true },
			{ id: "120363000000000001@g.us", name: "Team" },
		]);
	});
});

describe("voice switches", () => {
	it("are off by default, and only true when set to true", () => {
		assert.deepEqual(defaultSettings().voice, { understand: false, reply: false });
		assert.deepEqual(normalizeSettings({ voice: { understand: true, reply: "yes" } }).voice, { understand: true, reply: false });
	});

	it("make replies text while voice replies are off", () => {
		const settings = defaultSettings();
		settings.voiceMode = "voice";
		assert.equal(replyMode(settings), "off");
		settings.voice.reply = true;
		assert.equal(replyMode(settings), "voice");
		// Mirror me stays mirror me: typed messages get text, even when Pi can't listen.
		settings.voiceMode = "mirror";
		assert.equal(replyMode(settings), "mirror");
	});
});

describe("normalizeContactId", () => {
	for (const [input, expected] of [
		["+90 555 123 45 67", "905551234567"],
		["905551234567@s.whatsapp.net", "905551234567"],
		["905551234567:12@s.whatsapp.net", "905551234567"],
		["(415) 555-1212", "4155551212"],
		["120363000000000001@g.us", "120363000000000001@g.us"],
		["12", undefined],
		["hello", undefined],
	] as const) {
		it(`${input} → ${expected}`, () => {
			assert.equal(normalizeContactId(input), expected);
		});
	}
});

describe("languages", () => {
	it("adds with the default voice and refuses to remove the last one", () => {
		const settings = defaultSettings();
		addLanguage(settings, "tr");
		addLanguage(settings, "tr");
		addLanguage(settings, "xx");
		assert.deepEqual(settings.languages, ["en", "tr"]);
		assert.equal(settings.voices.tr, "F1");

		settings.replyLanguage = "tr";
		assert.equal(removeLanguage(settings, "tr"), true);
		assert.equal(settings.replyLanguage, MIRROR);
		assert.equal(settings.voices.tr, undefined);
		assert.equal(removeLanguage(settings, "en"), false);
		assert.deepEqual(settings.languages, ["en"]);
	});
});

describe("clampSpeed", () => {
	it("clamps and rounds", () => {
		assert.equal(clampSpeed(0.1), 0.5);
		assert.equal(clampSpeed(1.234), 1.23);
		assert.equal(clampSpeed(Number.NaN), 1);
	});
});

describe("restoreSessionState", () => {
	const fallback = { enabled: false, autoCompact: true };

	it("uses the last matching entry on the branch", () => {
		const branch = [
			{ type: "custom", customType: SESSION_ENTRY_TYPE, data: { enabled: true, autoCompact: false } },
			{ type: "message" },
			{ type: "custom", customType: "other", data: { enabled: false } },
			{ type: "custom", customType: SESSION_ENTRY_TYPE, data: { enabled: false } },
		];
		assert.deepEqual(restoreSessionState(branch, fallback), { enabled: false, autoCompact: true });
		assert.deepEqual(restoreSessionState(branch.slice(0, 3), fallback), { enabled: true, autoCompact: false });
	});

	it("returns a copy of the fallback when nothing is saved", () => {
		const restored = restoreSessionState([], fallback);
		assert.deepEqual(restored, fallback);
		assert.notEqual(restored, fallback);
	});
});

describe("SettingsStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-settings-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("loads defaults, saves atomically with private permissions, and notifies", () => {
		const file = join(dir, "nested", "config.json");
		const store = new SettingsStore(file);
		assert.deepEqual(store.load(), defaultSettings());

		const seen: string[] = [];
		store.onChange((settings) => seen.push(settings.voiceMode));
		store.update((draft) => {
			draft.voiceMode = "voice";
		});

		assert.deepEqual(seen, ["voice"]);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).voiceMode, "voice");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(join(dir, "nested")), ["config.json"]);
		assert.equal(new SettingsStore(file).load().voiceMode, "voice");
	});

	it("tells a file from before the voice switches apart from a new one", () => {
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ version: 1, voiceMode: "mirror" }));
		const store = new SettingsStore(file);
		store.load();
		assert.equal(store.isFromOlderVersion(), true);
		store.update((draft) => {
			draft.voice.reply = true;
		});
		store.load();
		assert.equal(store.isFromOlderVersion(), false);
		assert.equal(new SettingsStore(join(dir, "missing.json")).isFromOlderVersion(), false);
	});

	it("keeps a corrupt file aside and starts from defaults", () => {
		const file = join(dir, "config.json");
		writeFileSync(file, "{ not json");
		const store = new SettingsStore(file);
		assert.deepEqual(store.load(), defaultSettings());
		assert.equal(readdirSync(dir).some((name) => name.startsWith("config.json.bad-")), true);
	});

	it("keeps one owner, never a group, and doesn't overwrite another process's changes", () => {
		const settings = normalizeSettings({
			contacts: [
				{ id: "120363000000000001@g.us", owner: true },
				{ id: "905551234567", owner: true },
				{ id: "4155551212", owner: true },
			],
		});
		assert.deepEqual(settings.contacts.map((contact) => !!contact.owner), [false, true, false]);

		const file = join(dir, "config.json");
		const mine = new SettingsStore(file);
		mine.load();
		const other = new SettingsStore(file);
		other.load();
		other.update((draft) => {
			draft.contacts.push({ id: "905551234567", name: "Alex" });
		});
		mine.update((draft) => {
			draft.voiceSpeed = 1.2;
		});
		assert.partialDeepStrictEqual(new SettingsStore(file).load(), { voiceSpeed: 1.2, contacts: [{ id: "905551234567", name: "Alex" }] });
	});

	it("re-validates whatever an update writes", () => {
		const store = new SettingsStore(join(dir, "config.json"));
		store.load();
		const saved = store.update((draft) => {
			draft.voiceSpeed = 50;
			(draft as { voiceMode: string }).voiceMode = "shout";
		});
		assert.equal(saved.voiceSpeed, 2);
		assert.equal(saved.voiceMode, "mirror");
	});
});
