import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addLanguage,
	clampSpeed,
	defaultSettings,
	MIRROR,
	normalizeContactId,
	normalizeSettings,
	removeLanguage,
	restoreSessionState,
	SESSION_ENTRY_TYPE,
	replyMode,
	SettingsStore,
} from "../src/settings.ts";

describe("normalizeSettings", () => {
	it("returns defaults for garbage", () => {
		expect(normalizeSettings(null)).toEqual(defaultSettings());
		expect(normalizeSettings("x")).toEqual(defaultSettings());
		expect(normalizeSettings([1, 2])).toEqual(defaultSettings());
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
		expect(settings.voiceMode).toBe("voice+text");
		expect(settings.voiceSpeed).toBe(2);
		expect(settings.languages).toEqual(["tr", "en"]);
		expect(settings.voices).toEqual({ tr: "M2", en: "F1" });
		expect(settings.replyLanguage).toBe(MIRROR);
		expect(settings.replies).toEqual({ summary: true, interim: false, touchedFiles: false, toolActivity: false, terminal: false });
	});

	it("falls back to English when no language is valid", () => {
		expect(normalizeSettings({ languages: ["xx"] }).languages).toEqual(["en"]);
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
		expect(settings.contacts).toEqual([
			{ id: "905551234567", name: "Alex", owner: true },
			{ id: "120363000000000001@g.us", name: "Team" },
		]);
	});
});

describe("voice switches", () => {
	it("are off by default, and only true when set to true", () => {
		expect(defaultSettings().voice).toEqual({ understand: false, reply: false });
		expect(normalizeSettings({ voice: { understand: true, reply: "yes" } }).voice).toEqual({ understand: true, reply: false });
	});

	it("make replies text while voice replies are off", () => {
		const settings = defaultSettings();
		settings.voiceMode = "voice";
		expect(replyMode(settings)).toBe("off");
		settings.voice.reply = true;
		expect(replyMode(settings)).toBe("voice");
		// Mirror me stays mirror me: typed messages get text, even when Pi can't listen.
		settings.voiceMode = "mirror";
		expect(replyMode(settings)).toBe("mirror");
	});
});

describe("normalizeContactId", () => {
	it.each([
		["+90 555 123 45 67", "905551234567"],
		["905551234567@s.whatsapp.net", "905551234567"],
		["905551234567:12@s.whatsapp.net", "905551234567"],
		["(415) 555-1212", "4155551212"],
		["120363000000000001@g.us", "120363000000000001@g.us"],
		["12", undefined],
		["hello", undefined],
	])("%s → %s", (input, expected) => {
		expect(normalizeContactId(input)).toBe(expected);
	});
});

describe("languages", () => {
	it("adds with the default voice and refuses to remove the last one", () => {
		const settings = defaultSettings();
		addLanguage(settings, "tr");
		addLanguage(settings, "tr");
		addLanguage(settings, "xx");
		expect(settings.languages).toEqual(["en", "tr"]);
		expect(settings.voices.tr).toBe("F1");

		settings.replyLanguage = "tr";
		expect(removeLanguage(settings, "tr")).toBe(true);
		expect(settings.replyLanguage).toBe(MIRROR);
		expect(settings.voices.tr).toBeUndefined();
		expect(removeLanguage(settings, "en")).toBe(false);
		expect(settings.languages).toEqual(["en"]);
	});
});

describe("clampSpeed", () => {
	it("clamps and rounds", () => {
		expect(clampSpeed(0.1)).toBe(0.5);
		expect(clampSpeed(1.234)).toBe(1.23);
		expect(clampSpeed(Number.NaN)).toBe(1);
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
		expect(restoreSessionState(branch, fallback)).toEqual({ enabled: false, autoCompact: true });
		expect(restoreSessionState(branch.slice(0, 3), fallback)).toEqual({ enabled: true, autoCompact: false });
	});

	it("returns a copy of the fallback when nothing is saved", () => {
		const restored = restoreSessionState([], fallback);
		expect(restored).toEqual(fallback);
		expect(restored).not.toBe(fallback);
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
		expect(store.load()).toEqual(defaultSettings());

		const seen: string[] = [];
		store.onChange((settings) => seen.push(settings.voiceMode));
		store.update((draft) => {
			draft.voiceMode = "voice";
		});

		expect(seen).toEqual(["voice"]);
		expect(JSON.parse(readFileSync(file, "utf8")).voiceMode).toBe("voice");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, "nested"))).toEqual(["config.json"]);
		expect(new SettingsStore(file).load().voiceMode).toBe("voice");
	});

	it("tells a file from before the voice switches apart from a new one", () => {
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ version: 1, voiceMode: "mirror" }));
		const store = new SettingsStore(file);
		store.load();
		expect(store.isFromOlderVersion()).toBe(true);
		store.update((draft) => {
			draft.voice.reply = true;
		});
		store.load();
		expect(store.isFromOlderVersion()).toBe(false);
		expect(new SettingsStore(join(dir, "missing.json")).isFromOlderVersion()).toBe(false);
	});

	it("keeps a corrupt file aside and starts from defaults", () => {
		const file = join(dir, "config.json");
		writeFileSync(file, "{ not json");
		const store = new SettingsStore(file);
		expect(store.load()).toEqual(defaultSettings());
		expect(readdirSync(dir).some((name) => name.startsWith("config.json.bad-"))).toBe(true);
	});

	it("keeps one owner, never a group, and doesn't overwrite another process's changes", () => {
		const settings = normalizeSettings({
			contacts: [
				{ id: "120363000000000001@g.us", owner: true },
				{ id: "905551234567", owner: true },
				{ id: "4155551212", owner: true },
			],
		});
		expect(settings.contacts.map((contact) => !!contact.owner)).toEqual([false, true, false]);

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
		expect(new SettingsStore(file).load()).toMatchObject({ voiceSpeed: 1.2, contacts: [{ id: "905551234567", name: "Alex" }] });
	});

	it("re-validates whatever an update writes", () => {
		const store = new SettingsStore(join(dir, "config.json"));
		store.load();
		const saved = store.update((draft) => {
			draft.voiceSpeed = 50;
			(draft as { voiceMode: string }).voiceMode = "shout";
		});
		expect(saved.voiceSpeed).toBe(2);
		expect(saved.voiceMode).toBe("mirror");
	});
});
