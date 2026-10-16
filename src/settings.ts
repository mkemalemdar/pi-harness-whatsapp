/**
 * Settings: global defaults in config.json, plus a small per-session state
 * (WhatsApp on/off, auto-compaction) stored as custom session entries so a
 * continued session gets its own values back.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultVoiceFor, getLanguage } from "./languages.ts";
import { isRemoved } from "./removed.ts";

export type VoiceMode = "off" | "voice" | "voice+text" | "mirror";
export type CommandAccess = "owner" | "allowed";
/** Which messages in an allowed group reach Pi: all, replies to Pi, @mentions of Pi, or replies and mentions. */
export type GroupReplies = "all" | "replies" | "mentions" | "both";
export const GROUP_REPLY_MODES: readonly GroupReplies[] = ["all", "replies", "mentions", "both"];

export const VOICE_MODES: readonly VoiceMode[] = ["off", "voice", "voice+text", "mirror"];
export const SPEED_PRESETS: readonly number[] = [0.9, 1.0, 1.2];
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;
/** `replyLanguage` value meaning "answer in the language the user used". */
export const MIRROR = "mirror";

export interface ReplyToggles {
	/** Append "✅ 4/6 tool calls ok · ⏱ 2m 14s" to the final reply. */
	summary: boolean;
	/** Send each text Pi writes while it is still working. */
	interim: boolean;
	/** Append the list of files written or edited during the run. */
	touchedFiles: boolean;
	/** Keep one live message with the latest tool steps. */
	toolActivity: boolean;
	/** Also send the owner Pi's answers to prompts typed in the terminal. */
	terminal: boolean;
}

/** Optional voice: understanding voice notes (speech-to-text) and replying with them (text-to-speech). Both off by default. */
export interface VoiceParts {
	understand: boolean;
	reply: boolean;
}

export interface Contact {
	/** Phone number digits without "+" for people, or a group JID ending in "@g.us". */
	id: string;
	name?: string;
	/** WhatsApp's hidden id for this person (the digits before "@lid"), learned from messages. */
	lid?: string;
	/** The owner may use commands that change Pi when access is "owner". */
	owner?: boolean;
}

export interface GlobalSettings {
	version: 1;
	replies: ReplyToggles;
	voice: VoiceParts;
	/** "Reply type"; only used while voice.reply is on (see replyMode). */
	voiceMode: VoiceMode;
	/** MIRROR or a language code from `languages`. */
	replyLanguage: string;
	/** Enabled languages; the first one is the default. */
	languages: string[];
	/** Chosen voice per language code. */
	voices: Record<string, string>;
	voiceSpeed: number;
	forwardToolImages: boolean;
	askAtSessionStart: boolean;
	commandAccess: CommandAccess;
	groupReplies: GroupReplies;
	contacts: Contact[];
	/** WhatsApp state of the most recent session, used for new sessions. */
	lastEnabled: boolean;
}

export interface SessionState {
	enabled: boolean;
	autoCompact: boolean;
}

export const SESSION_ENTRY_TYPE = "pi-harness-whatsapp/session";

export function defaultSettings(): GlobalSettings {
	return {
		version: 1,
		replies: { summary: false, interim: false, touchedFiles: false, toolActivity: false, terminal: false },
		voice: { understand: false, reply: false },
		voiceMode: "mirror",
		replyLanguage: MIRROR,
		languages: ["en"],
		voices: { en: defaultVoiceFor("en")! },
		voiceSpeed: 1.0,
		forwardToolImages: false,
		askAtSessionStart: false,
		commandAccess: "owner",
		groupReplies: "both",
		contacts: [],
		lastEnabled: false,
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

export function clampSpeed(value: number): number {
	if (!Number.isFinite(value)) return 1.0;
	return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) * 100) / 100;
}

function normalizeContact(raw: unknown): Contact | undefined {
	if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
	const id = normalizeContactId(raw.id);
	if (!id) return undefined;
	const contact: Contact = { id };
	if (typeof raw.name === "string" && raw.name.trim()) contact.name = raw.name.trim();
	if (typeof raw.lid === "string" && /^\d+$/.test(raw.lid)) contact.lid = raw.lid;
	if (raw.owner === true && !id.endsWith("@g.us")) contact.owner = true;
	return contact;
}

/**
 * Accepts "+90 555 123 45 67", "905551234567", "905551234567@s.whatsapp.net"
 * or a group JID; returns digits for people and the JID for groups.
 */
export function normalizeContactId(input: string): string | undefined {
	const trimmed = input.trim();
	if (/^[\d-]+@g\.us$/.test(trimmed)) return trimmed;
	const withoutSuffix = trimmed.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
	const digits = withoutSuffix.replace(/[\s()+.-]/g, "");
	return /^\d{6,15}$/.test(digits) ? digits : undefined;
}

/** Turns anything read from disk into valid settings, keeping what is usable. */
export function normalizeSettings(raw: unknown): GlobalSettings {
	const defaults = defaultSettings();
	if (!isRecord(raw)) return defaults;

	const replies = isRecord(raw.replies) ? raw.replies : {};
	const voice = isRecord(raw.voice) ? raw.voice : {};
	const languages = Array.isArray(raw.languages)
		? [...new Set(raw.languages.filter((code): code is string => typeof code === "string" && !!getLanguage(code)))]
		: [];
	if (languages.length === 0) languages.push(...defaults.languages);

	const voices: Record<string, string> = {};
	const rawVoices = isRecord(raw.voices) ? raw.voices : {};
	for (const code of languages) {
		const known = getLanguage(code)!.voices.map((voice) => voice.id);
		const chosen = rawVoices[code];
		voices[code] = typeof chosen === "string" && known.includes(chosen) ? chosen : known[0]!;
	}

	const replyLanguage =
		raw.replyLanguage === MIRROR || (typeof raw.replyLanguage === "string" && languages.includes(raw.replyLanguage))
			? (raw.replyLanguage as string)
			: MIRROR;

	const contacts: Contact[] = [];
	if (Array.isArray(raw.contacts)) {
		for (const entry of raw.contacts) {
			const contact = normalizeContact(entry);
			if (!contact || contacts.some((existing) => existing.id === contact.id)) continue;
			// Only one owner: the first one marked.
			if (contact.owner && contacts.some((existing) => existing.owner)) delete contact.owner;
			contacts.push(contact);
		}
	}

	return {
		version: 1,
		replies: {
			summary: bool(replies.summary, defaults.replies.summary),
			interim: bool(replies.interim, defaults.replies.interim),
			touchedFiles: bool(replies.touchedFiles, defaults.replies.touchedFiles),
			toolActivity: bool(replies.toolActivity, defaults.replies.toolActivity),
			terminal: bool(replies.terminal, defaults.replies.terminal),
		},
		voice: { understand: bool(voice.understand, false), reply: bool(voice.reply, false) },
		voiceMode: pick(raw.voiceMode, VOICE_MODES, defaults.voiceMode),
		replyLanguage,
		languages,
		voices,
		voiceSpeed: typeof raw.voiceSpeed === "number" ? clampSpeed(raw.voiceSpeed) : defaults.voiceSpeed,
		forwardToolImages: bool(raw.forwardToolImages, defaults.forwardToolImages),
		askAtSessionStart: bool(raw.askAtSessionStart, defaults.askAtSessionStart),
		commandAccess: pick(raw.commandAccess, ["owner", "allowed"] as const, defaults.commandAccess),
		groupReplies: pick(raw.groupReplies, GROUP_REPLY_MODES, defaults.groupReplies),
		contacts,
		lastEnabled: bool(raw.lastEnabled, defaults.lastEnabled),
	};
}

/** How replies go out: text ("off") whenever voice replies are off, otherwise the chosen reply type. */
export function replyMode(settings: Readonly<GlobalSettings>): VoiceMode {
	return settings.voice.reply ? settings.voiceMode : "off";
}

export type SettingsListener = (settings: Readonly<GlobalSettings>) => void;

/** Loads, validates and atomically saves config.json. */
export class SettingsStore {
	private settings: GlobalSettings = defaultSettings();
	private readonly listeners = new Set<SettingsListener>();
	/** The file is from a version without the voice switches (see Controller.migrateVoice). */
	private olderFile = false;

	constructor(private readonly filePath: string) {}

	/** Reads the file. A corrupt file is kept as config.json.bad-<time> and replaced by defaults. */
	load(): Readonly<GlobalSettings> {
		this.olderFile = false;
		if (!existsSync(this.filePath)) {
			this.settings = defaultSettings();
			return this.settings;
		}
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			this.olderFile = isRecord(raw) && !("voice" in raw);
			this.settings = normalizeSettings(raw);
		} catch {
			try {
				renameSync(this.filePath, `${this.filePath}.bad-${Date.now()}`);
			} catch {
				// Keeping a copy of the broken file is best-effort.
			}
			this.settings = defaultSettings();
		}
		return this.settings;
	}

	get(): Readonly<GlobalSettings> {
		return this.settings;
	}

	/** True when the loaded file was saved before voice became optional. */
	isFromOlderVersion(): boolean {
		return this.olderFile;
	}

	/**
	 * Applies a change, re-validates, saves and notifies listeners. Starts from
	 * the file on disk, so a change made by another Pi process isn't overwritten.
	 */
	update(change: (draft: GlobalSettings) => void): Readonly<GlobalSettings> {
		const draft = structuredClone(this.fromDisk() ?? this.settings);
		change(draft);
		this.settings = normalizeSettings(draft);
		this.save();
		for (const listener of this.listeners) listener(this.settings);
		return this.settings;
	}

	/** The saved settings, or undefined when there is no readable file. */
	private fromDisk(): GlobalSettings | undefined {
		try {
			return normalizeSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
		} catch {
			return undefined;
		}
	}

	onChange(listener: SettingsListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private save(): void {
		if (isRemoved()) return;
		mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.filePath);
	}
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The last saved session state on the current branch, or `fallback` when there is none. */
export function restoreSessionState(branch: readonly EntryLike[], fallback: SessionState): SessionState {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		return {
			enabled: bool(entry.data.enabled, fallback.enabled),
			autoCompact: bool(entry.data.autoCompact, fallback.autoCompact),
		};
	}
	return { ...fallback };
}

/** Adds a language with its default voice (no-op if unknown or already enabled). */
export function addLanguage(settings: GlobalSettings, code: string): void {
	const voice = defaultVoiceFor(code);
	if (!voice || settings.languages.includes(code)) return;
	settings.languages.push(code);
	settings.voices[code] = voice;
}

/** Removes a language; the last remaining language cannot be removed. */
export function removeLanguage(settings: GlobalSettings, code: string): boolean {
	if (settings.languages.length <= 1 || !settings.languages.includes(code)) return false;
	settings.languages = settings.languages.filter((existing) => existing !== code);
	delete settings.voices[code];
	if (settings.replyLanguage === code) settings.replyLanguage = MIRROR;
	return true;
}
