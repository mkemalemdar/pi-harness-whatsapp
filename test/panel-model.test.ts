import { describe, expect, it } from "vitest";
import {
	ALWAYS_ON,
	applyChoice,
	applyLanguageSelection,
	applyVoiceChoice,
	buildRows,
	contactsSummary,
	formatSpeed,
	languageChecklist,
	OFF,
	ON,
	downloadQuestion,
	formatSize,
	type PanelState,
	removalQuestion,
	type SpeechInfo,
	voicePlan,
	voiceSummary,
} from "../src/panel-model.ts";
import { addLanguage, defaultSettings, MIRROR } from "../src/settings.ts";

const speech: SpeechInfo = { installed: new Set(["whisper-large-v3-turbo-int8-ov"]), downloading: new Set(), sizesMB: { "whisper-large-v3-turbo-int8-ov": 828 } };

const freshSettings = () => {
	const settings = defaultSettings();
	addLanguage(settings, "tr");
	return settings;
};

const stateFor = (enabled = false, voice = { understand: false, reply: false }): PanelState => ({
	settings: { ...freshSettings(), voice },
	enabled,
	connection: "off",
	speech,
	logFile: "/x/log",
});

describe("buildRows", () => {
	it("groups rows into the five sections in order", () => {
		const rows = buildRows(stateFor());
		expect(rows.filter((row) => row.kind === "header").map((row) => row.label)).toEqual([
			"CONNECTION",
			"REPLIES",
			"VOICE",
			"LANGUAGES",
			"DANGER",
		]);
		expect(rows.map((row) => row.id)).toEqual([
			"header:connection",
			"whatsapp",
			"connection",
			"contacts",
			"groupReplies",
			"commandAccess",
			"askAtSessionStart",
			"header:replies",
			"replies.final",
			"replies.terminal",
			"replies.interim",
			"replies.toolActivity",
			"replies.touchedFiles",
			"replies.summary",
			"forwardToolImages",
			"header:voice",
			"voiceNotes",
			"voiceMode",
			"voices",
			"voiceSpeed",
			"header:languages",
			"replyLanguage",
			"languages",
			"defaultLanguage",
			"header:danger",
			"remove",
			"log",
		]);
	});

	it("gives every row a description and every choice row its options", () => {
		for (const row of buildRows(stateFor())) {
			if (row.kind === "info") continue;
			expect(row.description.length, row.id).toBeGreaterThan(10);
			if (row.kind === "choice") expect(row.choices?.length, row.id).toBeGreaterThan(0);
		}
	});

	it("uses the new names and marks the current choice", () => {
		const rows = buildRows(stateFor(true, { understand: true, reply: true }));
		const byId = (id: string) => rows.find((row) => row.id === id)!;
		expect(byId("whatsapp")).toMatchObject({ label: "WhatsApp (this session)", current: ON });
		expect(byId("replies.final")).toMatchObject({ currentValue: ALWAYS_ON });
		expect(byId("voiceMode")).toMatchObject({ label: "Reply type", currentValue: "mirror me" });
		expect(byId("voiceMode").locked).toBeUndefined();
		expect(byId("log")).toMatchObject({ label: "Log file: /x/log", kind: "info" });
		expect(byId("voiceMode").choices?.map((choice) => choice.label)).toEqual(["mirror me", "text", "voice", "voice + text"]);
		expect(byId("replyLanguage").choices?.map((choice) => choice.label)).toEqual(["mirror me", "English", "Türkçe (Turkish)"]);
		expect(byId("defaultLanguage")).toMatchObject({ label: "Fallback language", currentValue: "English" });
		expect(byId("voices").currentValue).toBe("F1, F1");
		expect(byId("forwardToolImages")).toMatchObject({ label: "Auto-send tool images", currentValue: OFF });
	});

	it("greys out what needs voice replies, and says which tick turns it on", () => {
		const rows = buildRows(stateFor());
		const byId = (id: string) => rows.find((row) => row.id === id)!;
		expect(byId("voiceNotes").currentValue).toBe("off");
		for (const id of ["voiceMode", "voices", "voiceSpeed"]) expect(byId(id).locked, id).toMatch(/tick “Reply with voice notes”/);
		expect(byId("voiceMode").currentValue).toBe("text");
		expect(byId("replyLanguage").locked).toBeUndefined();

		const mirror = buildRows(stateFor(false, { understand: false, reply: true })).find((row) => row.id === "voiceMode")!.choices!.find((choice) => choice.value === "mirror")!;
		expect(mirror).toMatchObject({ disabled: true, detail: "needs “Understand voice notes”" });
	});
});

describe("voice notes menu", () => {
	const on = (understand: boolean, reply: boolean) => ({ understand, reply });
	const disk = (names: string[], downloading: string[] = []): SpeechInfo => ({
		installed: new Set(names),
		downloading: new Set(downloading),
		sizesMB: Object.fromEntries(names.map((name) => [name, name.startsWith("whisper") ? 828 : name === "supertonic-3" ? 401 : 202])),
	});
	const ALL = ["openvino-runtime", "whisper-large-v3-turbo-int8-ov", "supertonic-3"];

	it("summarizes the switches with their size and state", () => {
		expect(voiceSummary(on(false, false), disk([]))).toBe("off");
		expect(voiceSummary(on(true, false), disk(ALL))).toBe("understand only · 1.0 GB · on disk");
		expect(voiceSummary(on(false, true), disk([]))).toBe("reply only · 603 MB · downloads when first needed");
		expect(voiceSummary(on(true, true), disk([], ["supertonic-3"]))).toBe("understand + reply · 1.4 GB · downloading");
		expect(formatSize(1431)).toBe("1.4 GB");
	});

	it("deletes only what the remaining part doesn't need, and asks about it", () => {
		const plan = voicePlan(on(true, true), on(false, true), false, disk(ALL));
		expect(plan.remove).toEqual({ files: ["whisper-large-v3-turbo-int8-ov"], parts: ["understand"], megabytes: 828 });
		expect(removalQuestion(plan)).toBe("You set speech-to-text for removal. 828 MB will be freed.");
		const both = voicePlan(on(true, true), on(false, false), false, disk(ALL));
		expect(both.remove.files).toEqual(ALL);
		expect(removalQuestion(both)).toBe("You set speech-to-text and text-to-speech for removal. 1.4 GB will be freed.");
	});

	it("doesn't ask about files that aren't there, or about parts left alone", () => {
		expect(voicePlan(on(true, false), on(false, false), false, disk([])).remove.files).toEqual([]);
		// The reply files exist without the tick (e.g. a hand-edited config): untouched unless "delete all".
		expect(voicePlan(on(true, false), on(true, false), false, disk(ALL)).remove.files).toEqual([]);
		expect(voicePlan(on(false, false), on(false, false), true, disk(ALL)).remove.files).toEqual(ALL);
	});

	it("offers to download what a newly ticked part is missing", () => {
		const plan = voicePlan(on(true, false), on(true, true), false, disk(["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]));
		expect(plan.download).toEqual({ files: ["supertonic-3"], parts: ["reply"], megabytes: 401 });
		expect(downloadQuestion(plan)).toBe("Reply with voice notes needs text-to-speech (~401 MB download).");
		const fresh = voicePlan(on(false, false), on(true, true), false, disk([]));
		expect(downloadQuestion(fresh)).toBe(
			"Understand voice notes and Reply with voice notes need speech-to-text and text-to-speech (~1.4 GB download).",
		);
		expect(voicePlan(on(false, false), on(true, false), false, disk([], ALL)).download.files).toEqual([]);
	});
});

describe("applyChoice", () => {
	it("applies values from the submenus", () => {
		const settings = freshSettings();
		applyChoice(settings, "voiceMode", "voice+text");
		applyChoice(settings, "replyLanguage", "tr");
		applyChoice(settings, "replies.summary", ON);
		applyChoice(settings, "commandAccess", "allowed");
		applyChoice(settings, "forwardToolImages", ON);
		applyChoice(settings, "voiceSpeed", "1,2");
		applyChoice(settings, "defaultLanguage", "tr");
		expect(settings).toMatchObject({
			voiceMode: "voice+text",
			replyLanguage: "tr",
			commandAccess: "allowed",
			forwardToolImages: true,
			voiceSpeed: 1.2,
			languages: ["tr", "en"],
		});
		expect(settings.replies.summary).toBe(true);
	});

	it("ignores unknown values and doesn't treat the WhatsApp row as a setting", () => {
		const settings = freshSettings();
		applyChoice(settings, "replyLanguage", "xx");
		expect(settings.replyLanguage).toBe(MIRROR);
		expect(applyChoice(settings, "whatsapp", OFF)).toBe(false);
	});
});

describe("languages", () => {
	it("lists enabled languages first, ticked", () => {
		const list = languageChecklist(stateFor().settings);
		expect(list.slice(0, 3)).toEqual([
			{ id: "en", label: "English", checked: true },
			{ id: "tr", label: "Türkçe (Turkish)", checked: true },
			{ id: "de", label: "Deutsch (German)", checked: false },
		]);
	});

	it("keeps order for kept languages, appends new ones, and never empties", () => {
		const settings = freshSettings();
		settings.replyLanguage = "en";
		applyLanguageSelection(settings, ["tr", "de"]);
		expect(settings.languages).toEqual(["tr", "de"]);
		expect(settings.voices).toEqual({ tr: "F1", de: "F1" });
		expect(settings.replyLanguage).toBe(MIRROR);
		applyLanguageSelection(settings, []);
		expect(settings.languages).toEqual(["tr", "de"]);
	});

	it("only accepts known voices", () => {
		const settings = freshSettings();
		applyVoiceChoice(settings, "tr", "M3");
		applyVoiceChoice(settings, "tr", "en_US-amy-medium");
		expect(settings.voices.tr).toBe("M3");
	});
});

describe("summaries", () => {
	it("formats speeds and contacts", () => {
		expect(formatSpeed(1)).toBe("1.0");
		expect(formatSpeed(1.15)).toBe("1.15");
		const settings = defaultSettings();
		expect(contactsSummary(settings)).toBe("none yet");
		settings.contacts = [{ id: "905551234567", name: "Alex", owner: true }, { id: "4155551212" }];
		expect(contactsSummary(settings)).toBe("2 allowed · owner: Alex");
	});
});
