// What the /whatsapp panel shows: sections, rows, choices, greyed-out rows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
} from "../src/core/panel-model.ts";
import { addLanguage, defaultSettings, MIRROR } from "../src/core/settings.ts";

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
		assert.deepEqual(rows.filter((row) => row.kind === "header").map((row) => row.label), [
			"CONNECTION",
			"REPLIES",
			"VOICE",
			"LANGUAGES",
			"DANGER",
		]);
		assert.deepEqual(rows.map((row) => row.id), [
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
			assert.ok(row.description.length > 10, row.id);
			if (row.kind === "choice") assert.ok((row.choices?.length ?? 0) > 0, row.id);
		}
	});

	it("uses the new names and marks the current choice", () => {
		const rows = buildRows(stateFor(true, { understand: true, reply: true }));
		const byId = (id: string) => rows.find((row) => row.id === id)!;
		assert.partialDeepStrictEqual(byId("whatsapp"), { label: "WhatsApp (this session)", current: ON });
		assert.partialDeepStrictEqual(byId("replies.final"), { currentValue: ALWAYS_ON });
		assert.partialDeepStrictEqual(byId("voiceMode"), { label: "Reply type", currentValue: "mirror me" });
		assert.equal(byId("voiceMode").locked, undefined);
		assert.partialDeepStrictEqual(byId("log"), { label: "Log file: /x/log", kind: "info" });
		assert.deepEqual(byId("voiceMode").choices?.map((choice) => choice.label), ["mirror me", "text", "voice", "voice + text"]);
		assert.deepEqual(byId("replyLanguage").choices?.map((choice) => choice.label), ["mirror me", "English", "Türkçe (Turkish)"]);
		assert.partialDeepStrictEqual(byId("defaultLanguage"), { label: "Fallback language", currentValue: "English" });
		assert.equal(byId("voices").currentValue, "F1, F1");
		assert.partialDeepStrictEqual(byId("forwardToolImages"), { label: "Auto-send tool images", currentValue: OFF });
	});

	it("greys out what needs voice replies, and says which tick turns it on", () => {
		const rows = buildRows(stateFor());
		const byId = (id: string) => rows.find((row) => row.id === id)!;
		assert.equal(byId("voiceNotes").currentValue, "off");
		for (const id of ["voiceMode", "voices", "voiceSpeed"]) assert.match(byId(id).locked ?? "", /tick “Reply with voice notes”/, id);
		assert.equal(byId("voiceMode").currentValue, "text");
		assert.equal(byId("replyLanguage").locked, undefined);

		const replyOnly = buildRows(stateFor(false, { understand: false, reply: true })).find((row) => row.id === "voiceMode")!;
		assert.partialDeepStrictEqual(replyOnly, { currentValue: "mirror me" });
		assert.equal(replyOnly.locked, undefined);
		assert.equal(replyOnly.choices!.every((choice) => !choice.disabled), true);
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
		assert.equal(voiceSummary(on(false, false), disk([])), "off");
		assert.equal(voiceSummary(on(true, false), disk(ALL)), "understand only · 1.0 GB · on disk");
		assert.equal(voiceSummary(on(false, true), disk([])), "reply only · 603 MB · downloads when first needed");
		assert.equal(voiceSummary(on(true, true), disk([], ["supertonic-3"])), "understand + reply · 1.4 GB · downloading");
		assert.equal(formatSize(1431), "1.4 GB");
	});

	it("deletes only what the remaining part doesn't need, and asks about it", () => {
		const plan = voicePlan(on(true, true), on(false, true), false, disk(ALL));
		assert.deepEqual(plan.remove, { files: ["whisper-large-v3-turbo-int8-ov"], parts: ["understand"], megabytes: 828 });
		assert.equal(removalQuestion(plan), "You set speech-to-text for removal. 828 MB will be freed.");
		const both = voicePlan(on(true, true), on(false, false), false, disk(ALL));
		assert.deepEqual(both.remove.files, ALL);
		assert.equal(removalQuestion(both), "You set speech-to-text and text-to-speech for removal. 1.4 GB will be freed.");
	});

	it("doesn't ask about files that aren't there, or about parts left alone", () => {
		assert.deepEqual(voicePlan(on(true, false), on(false, false), false, disk([])).remove.files, []);
		// The reply files exist without the tick (e.g. a hand-edited config): untouched unless "delete all".
		assert.deepEqual(voicePlan(on(true, false), on(true, false), false, disk(ALL)).remove.files, []);
		assert.deepEqual(voicePlan(on(false, false), on(false, false), true, disk(ALL)).remove.files, ALL);
	});

	it("offers to download what a newly ticked part is missing", () => {
		const plan = voicePlan(on(true, false), on(true, true), false, disk(["openvino-runtime", "whisper-large-v3-turbo-int8-ov"]));
		assert.deepEqual(plan.download, { files: ["supertonic-3"], parts: ["reply"], megabytes: 401 });
		assert.equal(downloadQuestion(plan), "Reply with voice notes needs text-to-speech (~401 MB download).");
		const fresh = voicePlan(on(false, false), on(true, true), false, disk([]));
		assert.equal(downloadQuestion(fresh), "Understand voice notes and Reply with voice notes need speech-to-text and text-to-speech (~1.4 GB download).");
		assert.deepEqual(voicePlan(on(false, false), on(true, false), false, disk([], ALL)).download.files, []);
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
		assert.partialDeepStrictEqual(settings, {
			voiceMode: "voice+text",
			replyLanguage: "tr",
			commandAccess: "allowed",
			forwardToolImages: true,
			voiceSpeed: 1.2,
			languages: ["tr", "en"],
		});
		assert.equal(settings.replies.summary, true);
	});

	it("ignores unknown values and doesn't treat the WhatsApp row as a setting", () => {
		const settings = freshSettings();
		applyChoice(settings, "replyLanguage", "xx");
		assert.equal(settings.replyLanguage, MIRROR);
		assert.equal(applyChoice(settings, "whatsapp", OFF), false);
	});
});

describe("languages", () => {
	it("lists enabled languages first, ticked", () => {
		const list = languageChecklist(stateFor().settings);
		assert.deepEqual(list.slice(0, 3), [
			{ id: "en", label: "English", checked: true },
			{ id: "tr", label: "Türkçe (Turkish)", checked: true },
			{ id: "de", label: "Deutsch (German)", checked: false },
		]);
	});

	it("keeps order for kept languages, appends new ones, and never empties", () => {
		const settings = freshSettings();
		settings.replyLanguage = "en";
		applyLanguageSelection(settings, ["tr", "de"]);
		assert.deepEqual(settings.languages, ["tr", "de"]);
		assert.deepEqual(settings.voices, { tr: "F1", de: "F1" });
		assert.equal(settings.replyLanguage, MIRROR);
		applyLanguageSelection(settings, []);
		assert.deepEqual(settings.languages, ["tr", "de"]);
	});

	it("only accepts known voices", () => {
		const settings = freshSettings();
		applyVoiceChoice(settings, "tr", "M3");
		applyVoiceChoice(settings, "tr", "en_US-amy-medium");
		assert.equal(settings.voices.tr, "M3");
	});
});

describe("summaries", () => {
	it("formats speeds and contacts", () => {
		assert.equal(formatSpeed(1), "1.0");
		assert.equal(formatSpeed(1.15), "1.15");
		const settings = defaultSettings();
		assert.equal(contactsSummary(settings), "none yet");
		settings.contacts = [{ id: "905551234567", name: "Alex", owner: true }, { id: "4155551212" }];
		assert.equal(contactsSummary(settings), "2 allowed · owner: Alex");
	});
});
