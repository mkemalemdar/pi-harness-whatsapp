/**
 * What the /whatsapp panel shows and how a picked value changes the settings.
 * Kept free of TUI code so it can be unit-tested.
 */

import { getLanguage, LANGUAGES, languageLabel } from "./languages.ts";
import {
	addLanguage,
	clampSpeed,
	type GlobalSettings,
	MIRROR,
	removeLanguage,
	type ReplyToggles,
	SPEECH_MODELS,
	SPEED_PRESETS,
	type SpeechModel,
	VOICE_MODES,
	type VoiceMode,
} from "./settings.ts";

export const ON = "on";
export const OFF = "off";
export const ALWAYS_ON = "always on";
export const CUSTOM = "custom…";

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
	off: "off",
	voice: "voice",
	"voice+text": "voice + text",
	mirror: "mirror me",
};

export const SPEECH_MODEL_LABELS: Record<SpeechModel, string> = {
	base: "fast (base)",
	small: "balanced (small)",
	turbo: "accurate (turbo)",
};

export const ACCESS_LABELS = { owner: "only me", allowed: "all allowed contacts" } as const;

export const REPLY_TOGGLES: ReadonlyArray<{ key: keyof ReplyToggles; label: string; description: string }> = [
	{ key: "summary", label: "Summary", description: "Adds '✅ 4/6 tool calls ok · ⏱ 2m 14s' to the final reply." },
	{ key: "interim", label: "In-between messages", description: "Sends each text Pi writes while it is still working." },
	{ key: "touchedFiles", label: "Touched files", description: "Adds the list of files Pi wrote or edited." },
	{ key: "toolActivity", label: "Tool activity", description: "One live message showing the latest tool steps." },
];

/** One row of the panel. `action` rows close the panel and run a follow-up flow. */
export interface PanelRow {
	id: string;
	label: string;
	description: string;
	currentValue: string;
	values?: string[];
	kind: "cycle" | "languages" | "voices" | "speed" | "action";
}

export interface PanelState {
	settings: Readonly<GlobalSettings>;
	enabled: boolean;
	connection: string;
}

const onOff = (value: boolean) => (value ? ON : OFF);

export function formatSpeed(speed: number): string {
	return speed.toFixed(speed * 10 === Math.round(speed * 10) ? 1 : 2);
}

export function replyLanguageLabel(code: string): string {
	return code === MIRROR ? "mirror me" : languageLabel(code);
}

export function buildRows(state: PanelState): PanelRow[] {
	const { settings } = state;
	const rows: PanelRow[] = [
		{
			id: "whatsapp",
			label: "WhatsApp",
			description: "Off disconnects completely: nothing is read or sent. Saved per session.",
			currentValue: onOff(state.enabled),
			values: [ON, OFF],
			kind: "cycle",
		},
		{
			id: "replies.final",
			label: "Reply: final answer",
			description: "Pi's final answer is always sent back to WhatsApp automatically.",
			currentValue: ALWAYS_ON,
			values: [ALWAYS_ON],
			kind: "cycle",
		},
	];
	for (const toggle of REPLY_TOGGLES) {
		rows.push({
			id: `replies.${toggle.key}`,
			label: `Reply: ${toggle.label.toLowerCase()}`,
			description: toggle.description,
			currentValue: onOff(settings.replies[toggle.key]),
			values: [ON, OFF],
			kind: "cycle",
		});
	}
	rows.push(
		{
			id: "voiceMode",
			label: "Voice replies",
			description: "Mirror me: voice note in → voice reply, text in → text reply.",
			currentValue: VOICE_MODE_LABELS[settings.voiceMode],
			values: VOICE_MODES.map((mode) => VOICE_MODE_LABELS[mode]),
			kind: "cycle",
		},
		{
			id: "replyLanguage",
			label: "Reply language",
			description: "Mirror me: Pi answers in the language you wrote or spoke.",
			currentValue: replyLanguageLabel(settings.replyLanguage),
			values: [MIRROR, ...settings.languages].map(replyLanguageLabel),
			kind: "cycle",
		},
		{
			id: "languages",
			label: "Languages",
			description: "Languages Pi listens to and speaks. The first is the default. Each needs one voice (~67 MB).",
			currentValue: settings.languages.map(languageLabel).join(", "),
			kind: "languages",
		},
		{
			id: "defaultLanguage",
			label: "Default language",
			description: "Used when the language of a message or reply is unclear.",
			currentValue: languageLabel(settings.languages[0]!),
			values: settings.languages.map(languageLabel),
			kind: "cycle",
		},
		{
			id: "voices",
			label: "Voices",
			description: "The voice used for each language.",
			currentValue: settings.languages.map((code) => voiceLabel(code, settings.voices[code])).join(", "),
			kind: "voices",
		},
		{
			id: "speechModel",
			label: "Speech model",
			description: "How voice notes are understood. Base: fastest (~1.3 GB RAM). Small: more accurate in our tests (~1.6 GB). Turbo: the largest model (~2.6 GB).",
			currentValue: SPEECH_MODEL_LABELS[settings.speechModel],
			values: SPEECH_MODELS.map((model) => SPEECH_MODEL_LABELS[model]),
			kind: "cycle",
		},
		{
			id: "voiceSpeed",
			label: "Voice speed",
			description: "Speaking speed of voice replies (0.5–2.0).",
			currentValue: formatSpeed(settings.voiceSpeed),
			kind: "speed",
		},
		{
			id: "forwardToolImages",
			label: "Forward images from tools",
			description: "Screenshots and images produced by tools are sent to you automatically.",
			currentValue: onOff(settings.forwardToolImages),
			values: [ON, OFF],
			kind: "cycle",
		},
		{
			id: "askAtSessionStart",
			label: "Ask at session start",
			description: "Ask 'WhatsApp for this session?' when Pi starts or a session is opened.",
			currentValue: onOff(settings.askAtSessionStart),
			values: [ON, OFF],
			kind: "cycle",
		},
		{
			id: "commandAccess",
			label: "Command access",
			description: "Who may change Pi from WhatsApp (/model, /think, /compact, /quit…).",
			currentValue: ACCESS_LABELS[settings.commandAccess],
			values: [ACCESS_LABELS.owner, ACCESS_LABELS.allowed],
			kind: "cycle",
		},
		{
			id: "contacts",
			label: "Allowed contacts",
			description: "Who can talk to Pi. Pick from recent chats or add a number.",
			currentValue: contactsSummary(settings),
			kind: "action",
		},
		{
			id: "connection",
			label: "Connection",
			description: "Connect, show the QR code again, or log out.",
			currentValue: state.connection,
			kind: "action",
		},
	);
	return rows;
}

export function contactsSummary(settings: Readonly<GlobalSettings>): string {
	const count = settings.contacts.length;
	if (count === 0) return "none yet";
	const owner = settings.contacts.find((contact) => contact.owner);
	return `${count} allowed${owner ? ` · owner: ${owner.name ?? `+${owner.id}`}` : " · no owner set"}`;
}

export function voiceLabel(code: string, voiceId: string | undefined): string {
	const voice = getLanguage(code)?.voices.find((option) => option.id === voiceId);
	return voice ? voice.label.replace(/ \(.*\)$/, "") : (voiceId ?? "?");
}

const fromLabel = <T extends string>(labels: Record<T, string>, label: string): T | undefined =>
	(Object.keys(labels) as T[]).find((key) => labels[key] === label);

/**
 * Applies a value picked in the panel to a settings draft.
 * Returns false when the row is not a settings row (e.g. "whatsapp").
 */
export function applyRowChange(draft: GlobalSettings, id: string, value: string): boolean {
	if (id.startsWith("replies.")) {
		const key = id.slice("replies.".length) as keyof ReplyToggles;
		if (key in draft.replies) draft.replies[key] = value === ON;
		return true;
	}
	switch (id) {
		case "voiceMode": {
			const mode = fromLabel(VOICE_MODE_LABELS, value);
			if (mode) draft.voiceMode = mode;
			return true;
		}
		case "replyLanguage": {
			draft.replyLanguage =
				value === replyLanguageLabel(MIRROR)
					? MIRROR
					: (draft.languages.find((code) => languageLabel(code) === value) ?? MIRROR);
			return true;
		}
		case "defaultLanguage": {
			// The first enabled language is the default.
			const code = draft.languages.find((candidate) => languageLabel(candidate) === value);
			if (code) draft.languages = [code, ...draft.languages.filter((candidate) => candidate !== code)];
			return true;
		}
		case "speechModel": {
			const model = fromLabel(SPEECH_MODEL_LABELS, value);
			if (model) draft.speechModel = model;
			return true;
		}
		case "voiceSpeed": {
			const speed = Number.parseFloat(value.replace(",", "."));
			if (Number.isFinite(speed)) draft.voiceSpeed = clampSpeed(speed);
			return true;
		}
		case "forwardToolImages":
			draft.forwardToolImages = value === ON;
			return true;
		case "askAtSessionStart":
			draft.askAtSessionStart = value === ON;
			return true;
		case "commandAccess":
			draft.commandAccess = value === ACCESS_LABELS.allowed ? "allowed" : "owner";
			return true;
		default:
			return false;
	}
}

/** Rows of the Languages submenu: every known language with on/off. */
export function languageRows(settings: Readonly<GlobalSettings>) {
	return LANGUAGES.map((language) => ({
		id: language.code,
		label: languageLabel(language.code),
		currentValue: onOff(settings.languages.includes(language.code)),
		values: [ON, OFF],
	}));
}

/** Turns a language on or off. Returns false if refused (the last language stays). */
export function applyLanguageToggle(draft: GlobalSettings, code: string, value: string): boolean {
	if (value === ON) {
		addLanguage(draft, code);
		return true;
	}
	return removeLanguage(draft, code);
}

/** Rows of the Voices submenu: each enabled language cycles through its voices. */
export function voiceRows(settings: Readonly<GlobalSettings>) {
	return settings.languages.map((code) => {
		const language = getLanguage(code)!;
		return {
			id: code,
			label: languageLabel(code),
			currentValue: voiceLabel(code, settings.voices[code]),
			values: language.voices.map((voice) => voiceLabel(code, voice.id)),
		};
	});
}

export function applyVoiceChoice(draft: GlobalSettings, code: string, label: string): void {
	const voice = getLanguage(code)?.voices.find((option) => voiceLabel(code, option.id) === label);
	if (voice) draft.voices[code] = voice.id;
}

export const SPEED_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
	...SPEED_PRESETS.map((speed) => ({
		value: formatSpeed(speed),
		label: `${speed < 1 ? "Slower" : speed > 1 ? "Faster" : "Normal"} ${formatSpeed(speed)}`,
	})),
	{ value: CUSTOM, label: "Custom…" },
];
