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
	type PanelState,
	speechFilesSummary,
} from "../src/panel-model.ts";
import { addLanguage, defaultSettings, MIRROR } from "../src/settings.ts";

const speech = { installed: new Set(["sherpa-onnx-whisper-base"]), missingCount: 0, unusedCount: 2, diskMB: 320 };

const freshSettings = () => {
	const settings = defaultSettings();
	addLanguage(settings, "tr");
	return settings;
};

const stateFor = (enabled = false): PanelState => ({ settings: freshSettings(), enabled, connection: "off", speech });

describe("buildRows", () => {
	it("groups rows into the four sections in order", () => {
		const rows = buildRows(stateFor());
		expect(rows.filter((row) => row.kind === "header").map((row) => row.label)).toEqual([
			"CONNECTION",
			"REPLIES",
			"LANGUAGES",
			"TECHNICAL",
		]);
		expect(rows.map((row) => row.id)).toEqual([
			"header:connection",
			"whatsapp",
			"connection",
			"contacts",
			"commandAccess",
			"askAtSessionStart",
			"header:replies",
			"replies.final",
			"voiceMode",
			"replies.terminal",
			"replies.interim",
			"replies.toolActivity",
			"replies.touchedFiles",
			"replies.summary",
			"forwardToolImages",
			"header:languages",
			"replyLanguage",
			"languages",
			"defaultLanguage",
			"voices",
			"header:technical",
			"speechModel",
			"voiceSpeed",
			"speechFiles",
		]);
	});

	it("gives every row a description and every choice row its options", () => {
		for (const row of buildRows(stateFor())) {
			expect(row.description.length, row.id).toBeGreaterThan(10);
			if (row.kind === "choice") expect(row.choices?.length, row.id).toBeGreaterThan(0);
		}
	});

	it("uses the new names and marks the current choice", () => {
		const rows = buildRows(stateFor(true));
		const byId = (id: string) => rows.find((row) => row.id === id)!;
		expect(byId("whatsapp")).toMatchObject({ label: "WhatsApp (this session)", current: ON });
		expect(byId("replies.final")).toMatchObject({ currentValue: ALWAYS_ON });
		expect(byId("voiceMode")).toMatchObject({ label: "Reply type", currentValue: "mirror me" });
		expect(byId("voiceMode").choices?.map((choice) => choice.label)).toEqual(["mirror me", "text", "voice", "voice + text"]);
		expect(byId("replyLanguage").choices?.map((choice) => choice.label)).toEqual(["mirror me", "English", "Türkçe (Turkish)"]);
		expect(byId("defaultLanguage")).toMatchObject({ label: "Fallback language", currentValue: "English" });
		expect(byId("voices").currentValue).toBe("Amy, DFKI");
		expect(byId("forwardToolImages")).toMatchObject({ label: "Auto-send tool images", currentValue: OFF });
	});

	it("shows which speech-to-text models are on disk", () => {
		const choices = buildRows(stateFor()).find((row) => row.id === "speechModel")!.choices!;
		expect(choices[0]?.detail).toBe("✓ on disk · ~1.0 GB RAM");
		expect(choices[2]?.detail).toBe("564 MB · ~2.9 GB RAM");
	});
});

describe("applyChoice", () => {
	it("applies values from the submenus", () => {
		const settings = freshSettings();
		applyChoice(settings, "voiceMode", "voice+text");
		applyChoice(settings, "speechModel", "turbo");
		applyChoice(settings, "replyLanguage", "tr");
		applyChoice(settings, "replies.summary", ON);
		applyChoice(settings, "commandAccess", "allowed");
		applyChoice(settings, "forwardToolImages", ON);
		applyChoice(settings, "voiceSpeed", "1,2");
		applyChoice(settings, "defaultLanguage", "tr");
		expect(settings).toMatchObject({
			voiceMode: "voice+text",
			speechModel: "turbo",
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
		applyChoice(settings, "speechModel", "huge");
		expect(settings.replyLanguage).toBe(MIRROR);
		expect(settings.speechModel).toBe("base");
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
		expect(settings.voices).toEqual({ tr: "tr_TR-dfki-medium", de: "de_DE-thorsten-medium" });
		expect(settings.replyLanguage).toBe(MIRROR);
		applyLanguageSelection(settings, []);
		expect(settings.languages).toEqual(["tr", "de"]);
	});

	it("only accepts voices of that language", () => {
		const settings = freshSettings();
		applyVoiceChoice(settings, "tr", "tr_TR-fettah-medium");
		applyVoiceChoice(settings, "tr", "en_US-amy-medium");
		expect(settings.voices.tr).toBe("tr_TR-fettah-medium");
	});
});

describe("summaries", () => {
	it("formats speeds, contacts and speech files", () => {
		expect(formatSpeed(1)).toBe("1.0");
		expect(formatSpeed(1.15)).toBe("1.15");
		const settings = defaultSettings();
		expect(contactsSummary(settings)).toBe("none yet");
		settings.contacts = [{ id: "905551234567", name: "Alex", owner: true }, { id: "4155551212" }];
		expect(contactsSummary(settings)).toBe("2 allowed · owner: Alex");
		expect(speechFilesSummary(speech)).toBe("1 on disk · 320 MB · nothing missing · 2 unused");
	});
});
