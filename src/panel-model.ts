// What the /whatsapp panel shows: sections, rows, the choices behind each
// row, and every description. Free of TUI code so it can be unit-tested.

import { getLanguage, LANGUAGES, languageLabel } from "./languages.ts";
import { KNOWN_SPECS, type ModelSpec, PART_SPECS } from "./voice/models.ts";
import {
	clampSpeed,
	type GlobalSettings,
	MIRROR,
	replyMode,
	type VoiceParts,
	GROUP_REPLY_MODES,
	type GroupReplies,
	type ReplyToggles,
	SPEED_PRESETS,
	VOICE_MODES,
	type VoiceMode,
} from "./settings.ts";

export const ON = "on";
export const OFF = "off";
export const ALWAYS_ON = "always on";
export const CUSTOM = "custom";

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
	off: "text",
	voice: "voice",
	"voice+text": "voice + text",
	mirror: "mirror me",
};

const VOICE_MODE_DESCRIPTIONS: Record<VoiceMode, string> = {
	mirror: "voice note in → voice reply; text in → text reply",
	off: "always reply with text",
	voice: "always a voice note (code and long answers also as text)",
	"voice+text": "always a voice note and the text",
};


export const ACCESS_LABELS = { owner: "only me", allowed: "all allowed chats" } as const;

export const GROUP_REPLY_LABELS: Record<GroupReplies, string> = {
	all: "every message",
	replies: "replies to Pi",
	mentions: "@mentions only",
	both: "replies and @mentions",
};

const GROUP_REPLY_DETAILS: Record<GroupReplies, string> = {
	all: "everything anyone writes goes to Pi",
	replies: "when someone replies to one of Pi's messages",
	mentions: "when someone tags Pi (@ + the bot's name)",
	both: "replies to Pi, and @mentions",
};

/** The reply extras, in the order they appear in the panel. */
export const REPLY_TOGGLES: ReadonlyArray<{
	key: keyof ReplyToggles;
	label: string;
	description: string;
	/** Notes next to "on" / "off" in the submenu (default "sent" / "not sent"). */
	onDetail?: string;
	offDetail?: string;
}> = [
	{
		key: "terminal",
		label: "Terminal answers",
		description: "Also sends you (the owner) Pi's answers to prompts typed in the terminal, as text.",
		onDetail: "sent to the owner",
		offDetail: "stay in the terminal",
	},
	{ key: "interim", label: "Progress messages", description: "Sends what Pi writes while it's still working." },
	{ key: "toolActivity", label: "Live tool log", description: "One message, updated live, showing the latest tool steps." },
	{ key: "touchedFiles", label: "Changed files", description: "Adds the list of files Pi wrote or edited." },
	{ key: "summary", label: "Stats (tools · time)", description: "Adds a line like '✅ 4/6 tool calls ok · ⏱ 2m 14s'." },
];

export interface Choice {
	value: string;
	label: string;
	/** Short note shown next to the choice (size, RAM, "on disk"…). */
	detail?: string;
	/** Shown greyed out and can't be picked (the detail says why). */
	disabled?: boolean;
}

export type RowKind = "header" | "choice" | "languages" | "voices" | "speed" | "voiceNotes" | "connection" | "contacts" | "remove" | "info";

export interface PanelRow {
	id: string;
	label: string;
	description: string;
	currentValue: string;
	kind: RowKind;
	/** For "choice" rows: the options. */
	choices?: Choice[];
	/** Value of the current choice (marked with ●). */
	current?: string;
	/** Section the row belongs to, e.g. "Voice" (set by buildRows). */
	section?: string;
	/** Greyed out: why, and what to switch on to use it. */
	locked?: string;
}

/** What the panel needs to know about speech files on disk. */
export interface SpeechInfo {
	installed: ReadonlySet<string>;
	downloading: ReadonlySet<string>;
	/** Real size on disk of installed files, in MB. */
	sizesMB: Readonly<Record<string, number>>;
}

export interface PanelState {
	settings: Readonly<GlobalSettings>;
	enabled: boolean;
	connection: string;
	speech: SpeechInfo;
	logFile: string;
}

export type VoicePart = keyof VoiceParts;
export const VOICE_PARTS: readonly VoicePart[] = ["understand", "reply"];
export const PART_LABELS: Record<VoicePart, string> = { understand: "Understand voice notes", reply: "Reply with voice notes" };
/** What each part is called in the removal question. */
const PART_FILES: Record<VoicePart, string> = { understand: "speech-to-text", reply: "text-to-speech" };
const REPLY_LOCKED = "Voice replies are off. Open “Voice notes” and tick “Reply with voice notes” to use this.";

/** "828 MB", "1.4 GB" */
export function formatSize(megabytes: number): string {
	return megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}

const specsOf = (parts: readonly VoicePart[]): ModelSpec[] => KNOWN_SPECS.filter((spec) => parts.some((part) => (PART_SPECS[part] as readonly ModelSpec[]).includes(spec)));
const onParts = (voice: VoiceParts): VoicePart[] => VOICE_PARTS.filter((part) => voice[part]);

/** Disk space of a part (or both: the engine counts once). */
export function partsDiskMB(parts: readonly VoicePart[]): number {
	return specsOf(parts).reduce((sum, spec) => sum + spec.diskMB, 0);
}

/** "understand + reply · 1.4 GB · on disk" */
export function voiceSummary(voice: VoiceParts, speech: SpeechInfo): string {
	const parts = onParts(voice);
	if (parts.length === 0) return "off";
	const name = parts.length === 2 ? "understand + reply" : parts[0] === "understand" ? "understand only" : "reply only";
	const specs = specsOf(parts);
	const state = specs.every((spec) => speech.installed.has(spec.name))
		? "on disk"
		: specs.some((spec) => speech.downloading.has(spec.name))
			? "downloading"
			: "downloads when first needed";
	return `${name} · ${formatSize(partsDiskMB(parts))} · ${state}`;
}

export interface VoicePlan {
	/** Files to delete, the parts they belong to (for the question), and the space freed. */
	remove: { files: string[]; parts: VoicePart[]; megabytes: number };
	/** Files to download for parts switched on, and the download size. */
	download: { files: string[]; parts: VoicePart[]; megabytes: number };
}

/**
 * What leaving the Voice notes menu means: files of parts switched off are
 * deleted (unless the other part still needs them), files of parts switched
 * on are downloaded. "Delete all" removes every speech file on disk.
 */
export function voicePlan(before: VoiceParts, after: VoiceParts, deleteAll: boolean, speech: SpeechInfo): VoicePlan {
	const switchedOff = VOICE_PARTS.filter((part) => (before[part] || deleteAll) && !after[part]);
	const switchedOn = VOICE_PARTS.filter((part) => !before[part] && after[part]);
	const needed = new Set(specsOf(onParts(after)).map((spec) => spec.name));
	const present = (spec: ModelSpec) => speech.installed.has(spec.name) || speech.downloading.has(spec.name);
	const removable = (deleteAll ? KNOWN_SPECS : specsOf(switchedOff)).filter((spec) => present(spec) && !needed.has(spec.name));
	const missing = specsOf(switchedOn).filter((spec) => !present(spec));
	return {
		remove: {
			files: removable.map((spec) => spec.name),
			parts: switchedOff,
			megabytes: removable.reduce((sum, spec) => sum + (speech.sizesMB[spec.name] ?? spec.diskMB), 0),
		},
		download: {
			files: missing.map((spec) => spec.name),
			parts: switchedOn,
			megabytes: missing.reduce((sum, spec) => sum + spec.approxMB, 0),
		},
	};
}

/** "You set speech-to-text for removal. 828 MB will be freed." */
export function removalQuestion(plan: VoicePlan): string {
	const what = plan.remove.parts.length > 0 ? plan.remove.parts.map((part) => PART_FILES[part]).join(" and ") : "the speech files";
	return `You set ${what} for removal. ${formatSize(plan.remove.megabytes)} will be freed.`;
}

/** "Reply with voice notes needs text-to-speech (~0.6 GB download)." */
export function downloadQuestion(plan: VoicePlan): string {
	const parts = plan.download.parts;
	return `${parts.map((part) => PART_LABELS[part]).join(" and ")} ${parts.length > 1 ? "need" : "needs"} ${parts.map((part) => PART_FILES[part]).join(" and ")} (~${formatSize(plan.download.megabytes)} download).`;
}

const onOff = (value: boolean) => (value ? ON : OFF);

const onOffChoices = (onDetail: string, offDetail: string): Choice[] => [
	{ value: ON, label: ON, detail: onDetail },
	{ value: OFF, label: OFF, detail: offDetail },
];

export function formatSpeed(speed: number): string {
	return speed.toFixed(speed * 10 === Math.round(speed * 10) ? 1 : 2);
}

export function replyLanguageLabel(code: string): string {
	return code === MIRROR ? "mirror me" : languageLabel(code);
}

export function voiceLabel(code: string, voiceId: string | undefined): string {
	const voice = getLanguage(code)?.voices.find((option) => option.id === voiceId);
	return voice ? voice.label.replace(/ \(.*\)$/, "") : (voiceId ?? "?");
}

export function contactsSummary(settings: Readonly<GlobalSettings>): string {
	const count = settings.contacts.length;
	if (count === 0) return "none yet";
	const owner = settings.contacts.find((contact) => contact.owner);
	return `${count} allowed${owner ? ` · owner: ${owner.name ?? `+${owner.id}`}` : " · no owner set"}`;
}

const header = (id: string, label: string, description: string): PanelRow => ({
	id: `header:${id}`,
	label,
	description,
	currentValue: "",
	kind: "header",
});

export function buildRows(state: PanelState): PanelRow[] {
	const { settings, speech } = state;
	const rows: PanelRow[] = [
		header("connection", "CONNECTION", "Connecting WhatsApp, and who may talk to Pi."),
		{
			id: "whatsapp",
			label: "WhatsApp (this session)",
			description: "On: Pi reads and answers WhatsApp in this session. Off: disconnected, nothing is read or sent.",
			currentValue: onOff(state.enabled),
			kind: "choice",
			current: onOff(state.enabled),
			choices: onOffChoices("connect and handle messages", "disconnected"),
		},
		{
			id: "connection",
			label: "Connection",
			description: "Connect now, show a new QR code to pair again, or log out.",
			currentValue: state.connection,
			kind: "connection",
		},
		{
			id: "contacts",
			label: "Allowed chats",
			description: "People and groups that can talk to Pi. ★ marks the owner.",
			currentValue: contactsSummary(settings),
			kind: "contacts",
		},
		{
			id: "groupReplies",
			label: "In groups, answer",
			description: "Which group messages Pi answers. Private chats always reach Pi. When it answers, it also sees the last 20 messages since its previous answer.",
			currentValue: GROUP_REPLY_LABELS[settings.groupReplies],
			kind: "choice",
			current: settings.groupReplies,
			choices: GROUP_REPLY_MODES.map((mode) => ({ value: mode, label: GROUP_REPLY_LABELS[mode], detail: GROUP_REPLY_DETAILS[mode] })),
		},
		{
			id: "commandAccess",
			label: "Who can use commands",
			description: "Who may change Pi from WhatsApp with /model, /compact, /quit and the other commands.",
			currentValue: ACCESS_LABELS[settings.commandAccess],
			kind: "choice",
			current: settings.commandAccess,
			choices: [
				{ value: "owner", label: ACCESS_LABELS.owner, detail: "only the owner (★)" },
				{ value: "allowed", label: ACCESS_LABELS.allowed, detail: "everyone in Allowed chats" },
			],
		},
		{
			id: "askAtSessionStart",
			label: "Ask on/off at session start",
			description: "When a session opens, ask whether WhatsApp should be on for it.",
			currentValue: onOff(settings.askAtSessionStart),
			kind: "choice",
			current: onOff(settings.askAtSessionStart),
			choices: onOffChoices("ask every time", "use the last choice"),
		},

		header("replies", "REPLIES", "What Pi sends back to WhatsApp."),
		{
			id: "replies.final",
			label: "Final answer",
			description: "Pi's final answer is always sent back automatically.",
			currentValue: ALWAYS_ON,
			kind: "choice",
			current: ALWAYS_ON,
			choices: [{ value: ALWAYS_ON, label: ALWAYS_ON, detail: "can't be turned off" }],
		},
	];
	for (const toggle of REPLY_TOGGLES) {
		rows.push({
			id: `replies.${toggle.key}`,
			label: toggle.label,
			description: toggle.description,
			currentValue: onOff(settings.replies[toggle.key]),
			kind: "choice",
			current: onOff(settings.replies[toggle.key]),
			choices: onOffChoices(toggle.onDetail ?? "sent", toggle.offDetail ?? "not sent"),
		});
	}
	rows.push(
		{
			id: "forwardToolImages",
			label: "Auto-send tool images",
			description: "Every image a tool makes while answering you (e.g. browser screenshots) is sent to you.",
			currentValue: onOff(settings.forwardToolImages),
			kind: "choice",
			current: onOff(settings.forwardToolImages),
			choices: onOffChoices("send them all", "only when you ask for one"),
		},

		header("voice", "VOICE", "Optional voice notes, both ways. Off by default."),
		{
			id: "voiceNotes",
			label: "Voice notes",
			description: `Optional. Understanding voice notes takes ${formatSize(partsDiskMB(["understand"]))} of disk, replying with voice notes ${formatSize(partsDiskMB(["reply"]))}, both ${formatSize(partsDiskMB(VOICE_PARTS))}.`,
			currentValue: voiceSummary(settings.voice, speech),
			kind: "voiceNotes",
		},
		{
			id: "voiceMode",
			label: "Reply type",
			description: "Whether Pi answers with text, a voice note, or both.",
			currentValue: VOICE_MODE_LABELS[replyMode(settings)],
			kind: "choice",
			current: replyMode(settings),
			choices: (["mirror", "off", "voice", "voice+text"] as const).map((mode) => ({
				value: mode,
				label: VOICE_MODE_LABELS[mode],
				detail: VOICE_MODE_DESCRIPTIONS[mode],
			})),
			...(settings.voice.reply ? {} : { locked: REPLY_LOCKED }),
		},
		{
			id: "voices",
			label: "Voice per language",
			description: "Which voice speaks each language. You can get a sample on WhatsApp before choosing.",
			currentValue: settings.languages.map((code) => voiceLabel(code, settings.voices[code])).join(", "),
			kind: "voices",
			...(settings.voice.reply ? {} : { locked: REPLY_LOCKED }),
		},
		{
			id: "voiceSpeed",
			label: "Voice reply speed",
			description: "How fast Pi's voice replies are spoken.",
			currentValue: formatSpeed(settings.voiceSpeed),
			kind: "speed",
			...(settings.voice.reply ? {} : { locked: REPLY_LOCKED }),
		},

		header("languages", "LANGUAGES", "Which languages Pi answers in, and understands and speaks when voice is on."),
		{
			id: "replyLanguage",
			label: "Reply language",
			description: "The language Pi answers in.",
			currentValue: replyLanguageLabel(settings.replyLanguage),
			kind: "choice",
			current: settings.replyLanguage,
			choices: [MIRROR, ...settings.languages].map((code) => ({
				value: code,
				label: replyLanguageLabel(code),
				detail: code === MIRROR ? "the language you wrote or spoke in" : "always this language",
			})),
		},
		{
			id: "languages",
			label: "My languages",
			description: "The languages you use. Pi replies in them, and understands and speaks them when voice is on.",
			currentValue: settings.languages.map(languageLabel).join(", "),
			kind: "languages",
		},
		{
			id: "defaultLanguage",
			label: "Fallback language",
			description: "Used only when Pi can't tell which language to use, e.g. for very short replies.",
			currentValue: languageLabel(settings.languages[0]!),
			kind: "choice",
			current: settings.languages[0]!,
			choices: settings.languages.map((code) => ({ value: code, label: languageLabel(code) })),
		},

		header("danger", "DANGER", "Can't be undone."),
		{
			id: "remove",
			label: "Remove everything (before uninstalling)…",
			description:
				"Unlinks Pi from your phone; deletes the login, speech files, settings, log, received files and npm's cached copies; asks about programs installed for it. Asks first. Same as /whatsapp remove.",
			currentValue: "",
			kind: "remove",
		},
		{
			id: "log",
			label: `Log file: ${state.logFile}`,
			description: "Connection events and errors, never message text.",
			currentValue: "",
			kind: "info",
		},
	);
	let section = "";
	for (const row of rows) {
		if (row.kind === "header") section = row.label.charAt(0) + row.label.slice(1).toLowerCase();
		else row.section = section;
	}
	return rows;
}

/** Applies a choice picked in the panel. Returns false for rows that aren't settings (e.g. "whatsapp"). */
export function applyChoice(draft: GlobalSettings, id: string, value: string): boolean {
	if (id.startsWith("replies.")) {
		const key = id.slice("replies.".length) as keyof ReplyToggles;
		if (key in draft.replies) draft.replies[key] = value === ON;
		return true;
	}
	switch (id) {
		case "voiceMode":
			if ((VOICE_MODES as readonly string[]).includes(value)) draft.voiceMode = value as VoiceMode;
			return true;
		case "replyLanguage":
			draft.replyLanguage = value === MIRROR || draft.languages.includes(value) ? value : MIRROR;
			return true;
		case "defaultLanguage":
			// The first enabled language is the fallback.
			if (draft.languages.includes(value)) draft.languages = [value, ...draft.languages.filter((code) => code !== value)];
			return true;
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
		case "groupReplies":
			if ((GROUP_REPLY_MODES as readonly string[]).includes(value)) draft.groupReplies = value as GroupReplies;
			return true;
		case "commandAccess":
			draft.commandAccess = value === "allowed" ? "allowed" : "owner";
			return true;
		default:
			return false;
	}
}

/** The "My languages" checklist: enabled languages first (in their order), then the rest. */
export function languageChecklist(settings: Readonly<GlobalSettings>): Array<{ id: string; label: string; checked: boolean }> {
	const enabled = settings.languages.map((code) => ({ id: code, label: languageLabel(code), checked: true }));
	const others = LANGUAGES.filter((language) => !settings.languages.includes(language.code)).map((language) => ({
		id: language.code,
		label: languageLabel(language.code),
		checked: false,
	}));
	return [...enabled, ...others];
}

/**
 * Applies the ticked languages: ones that stay keep their order, new ones are
 * added at the end. At least one language always remains.
 */
export function applyLanguageSelection(draft: GlobalSettings, ticked: readonly string[]): void {
	const valid = ticked.filter((code) => !!getLanguage(code));
	if (valid.length === 0) return;
	const kept = draft.languages.filter((code) => valid.includes(code));
	const added = valid.filter((code) => !draft.languages.includes(code));
	draft.languages = [...kept, ...added];
	for (const code of Object.keys(draft.voices)) if (!draft.languages.includes(code)) delete draft.voices[code];
	for (const code of added) draft.voices[code] = getLanguage(code)!.voices[0]!.id;
	if (draft.replyLanguage !== MIRROR && !draft.languages.includes(draft.replyLanguage)) draft.replyLanguage = MIRROR;
}

export function applyVoiceChoice(draft: GlobalSettings, code: string, voiceId: string): void {
	if (getLanguage(code)?.voices.some((voice) => voice.id === voiceId)) draft.voices[code] = voiceId;
}

export const SPEED_CHOICES: readonly Choice[] = [
	...SPEED_PRESETS.map((speed) => ({
		value: formatSpeed(speed),
		label: formatSpeed(speed),
		detail: speed < 1 ? "slower" : speed > 1 ? "faster" : "normal",
	})),
	{ value: CUSTOM, label: "custom…", detail: "type a value from 0.5 to 2.0" },
];
