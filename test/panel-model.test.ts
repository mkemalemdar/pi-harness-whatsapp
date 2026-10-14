import { describe, expect, it } from "vitest";
import {
	ALWAYS_ON,
	applyLanguageToggle,
	applyRowChange,
	applyVoiceChoice,
	buildRows,
	contactsSummary,
	formatSpeed,
	OFF,
	ON,
	voiceRows,
} from "../src/panel-model.ts";
import { addLanguage, defaultSettings, MIRROR } from "../src/settings.ts";

const rowsFor = (enabled = false) => {
	const settings = defaultSettings();
	addLanguage(settings, "tr");
	return { settings, rows: buildRows({ settings, enabled, connection: "off" }) };
};

describe("buildRows", () => {
	it("shows WhatsApp first and the final reply as locked", () => {
		const { rows } = rowsFor(true);
		expect(rows[0]).toMatchObject({ id: "whatsapp", currentValue: ON });
		expect(rows[1]).toMatchObject({ id: "replies.final", currentValue: ALWAYS_ON, values: [ALWAYS_ON] });
	});

	it("offers mirror me plus every enabled language as reply language", () => {
		const { rows } = rowsFor();
		expect(rows.find((row) => row.id === "replyLanguage")?.values).toEqual([
			"mirror me",
			"English",
			"Türkçe (Turkish)",
		]);
	});

	it("summarises languages and voices", () => {
		const { rows } = rowsFor();
		expect(rows.find((row) => row.id === "languages")?.currentValue).toBe("English, Türkçe (Turkish)");
		expect(rows.find((row) => row.id === "voices")?.currentValue).toBe("Amy, DFKI");
	});
});

describe("applyRowChange", () => {
	it("maps labels back to values", () => {
		const { settings } = rowsFor();
		applyRowChange(settings, "voiceMode", "voice + text");
		applyRowChange(settings, "speechModel", "accurate (turbo)");
		applyRowChange(settings, "replyLanguage", "Türkçe (Turkish)");
		applyRowChange(settings, "replies.summary", ON);
		applyRowChange(settings, "commandAccess", "all allowed contacts");
		applyRowChange(settings, "forwardToolImages", OFF);
		applyRowChange(settings, "voiceSpeed", "1,15");
		expect(settings).toMatchObject({
			voiceMode: "voice+text",
			speechModel: "turbo",
			replyLanguage: "tr",
			commandAccess: "allowed",
			forwardToolImages: false,
			voiceSpeed: 1.15,
		});
		expect(settings.replies.summary).toBe(true);
	});

	it("falls back to mirror me for an unknown language label", () => {
		const { settings } = rowsFor();
		applyRowChange(settings, "replyLanguage", "Klingon");
		expect(settings.replyLanguage).toBe(MIRROR);
	});

	it("does not treat the WhatsApp row as a setting", () => {
		const { settings } = rowsFor();
		expect(applyRowChange(settings, "whatsapp", OFF)).toBe(false);
	});
});

describe("submenus", () => {
	it("toggles languages but keeps the last one", () => {
		const settings = defaultSettings();
		expect(applyLanguageToggle(settings, "de", ON)).toBe(true);
		expect(applyLanguageToggle(settings, "en", OFF)).toBe(true);
		expect(applyLanguageToggle(settings, "de", OFF)).toBe(false);
		expect(settings.languages).toEqual(["de"]);
	});

	it("picks a voice by its short label", () => {
		const { settings } = rowsFor();
		expect(voiceRows(settings)[1]?.values).toEqual(["DFKI", "Fahrettin", "Fettah"]);
		applyVoiceChoice(settings, "tr", "Fettah");
		expect(settings.voices.tr).toBe("tr_TR-fettah-medium");
	});
});

describe("formatting", () => {
	it("formats speeds", () => {
		expect(formatSpeed(1)).toBe("1.0");
		expect(formatSpeed(0.9)).toBe("0.9");
		expect(formatSpeed(1.15)).toBe("1.15");
	});

	it("summarises contacts", () => {
		const settings = defaultSettings();
		expect(contactsSummary(settings)).toBe("none yet");
		settings.contacts = [{ id: "905551234567", name: "Alex", owner: true }, { id: "4155551212" }];
		expect(contactsSummary(settings)).toBe("2 allowed · owner: Alex");
	});
});

describe("default language", () => {
	it("moves the picked language to the front", () => {
		const settings = defaultSettings();
		addLanguage(settings, "tr");
		applyRowChange(settings, "defaultLanguage", "Türkçe (Turkish)");
		expect(settings.languages).toEqual(["tr", "en"]);
		const rows = buildRows({ settings, enabled: false, connection: "off" });
		expect(rows.find((row) => row.id === "defaultLanguage")?.currentValue).toBe("Türkçe (Turkish)");
	});
});
