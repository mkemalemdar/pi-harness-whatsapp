/**
 * Voice: understands voice notes (Whisper turbo) and speaks replies
 * (Supertonic 3), both on OpenVINO. Files download on first use, or when the
 * user says "Now" after changing settings.
 */

import { getLanguage, LANGUAGES, languageLabel, VOICES } from "../languages.ts";
import { createLogger } from "../log.ts";
import type { GlobalSettings, SettingsStore } from "../settings.ts";
import { decodeToSamples, encodeVoiceNote } from "./audio.ts";
import { SpeechEngine } from "./engine.ts";
import { detectLanguage } from "./language.ts";
import { type ModelSpec, ModelStore, oldModelSpec, RUNTIME_SPEC, SUPERTONIC_SPEC, WHISPER_SPEC } from "./models.ts";

const log = createLogger("voice");
/** Longest single voice note (about 1.5–2 minutes); longer answers are split into parts. */
export const MAX_SPOKEN_CHARS = 1500;
/** At most this many parts (about 10 minutes); anything longer also comes as text. */
export const MAX_VOICE_PARTS = 6;

export interface Transcript {
	text: string;
	language?: string;
	ms: number;
}

export interface VoiceEvents {
	/** A download started (fraction 0), progressed, or finished (undefined). */
	onDownload?(spec: ModelSpec, fraction: number | undefined): void;
}

export interface SpeechFile {
	name: string;
	label: string;
	kind: ModelSpec["kind"];
	sizeMB: number;
}

export class VoiceService {
	readonly models: ModelStore;
	readonly engine: SpeechEngine;

	constructor(
		private readonly settings: SettingsStore,
		modelsDir: string,
		private readonly events: VoiceEvents = {},
	) {
		this.models = new ModelStore(modelsDir, (spec, fraction) => this.events.onDownload?.(spec, fraction));
		this.engine = new SpeechEngine(() => this.models.dir(RUNTIME_SPEC));
	}

	/** The voice for a language: the chosen one, or the default. */
	voiceFor(language: string, settings: Readonly<GlobalSettings> = this.settings.get()): string {
		const chosen = settings.voices[language];
		return chosen && VOICES.some((voice) => voice.id === chosen) ? chosen : VOICES[0]!.id;
	}

	/** Everything the current settings need: the engine, speech-to-text, and the voices when replies can be spoken. */
	neededModels(settings: Readonly<GlobalSettings> = this.settings.get()): ModelSpec[] {
		return settings.voiceMode === "off" ? [RUNTIME_SPEC, WHISPER_SPEC] : [RUNTIME_SPEC, WHISPER_SPEC, SUPERTONIC_SPEC];
	}

	/** Starts downloading anything missing, without waiting. */
	prefetch(): void {
		for (const spec of this.neededModels()) {
			if (this.models.isInstalled(spec) || this.models.isDownloading(spec)) continue;
			void this.models.ensure(spec).catch((error) => log.warn(`download of ${spec.name} failed`, error));
		}
	}

	/** Model folders on disk that nothing uses: older Piper/sherpa models, or the voices while replies are text only. */
	unusedModels(): ModelSpec[] {
		const needed = new Set(this.neededModels().map((spec) => spec.name));
		return this.models
			.installedNames()
			.filter((name) => !needed.has(name))
			.map((name) => (name === WHISPER_SPEC.name ? WHISPER_SPEC : name === SUPERTONIC_SPEC.name ? SUPERTONIC_SPEC : oldModelSpec(name)));
	}

	missingModels(): ModelSpec[] {
		return this.neededModels().filter((spec) => !this.models.isInstalled(spec));
	}

	/** A readable name, e.g. "speech-to-text (Whisper turbo)". */
	describe(spec: ModelSpec): string {
		switch (spec.kind) {
			case "runtime":
				return "speech engine (OpenVINO)";
			case "stt":
				return "speech-to-text (Whisper turbo)";
			case "tts":
				return "voices (Supertonic)";
			default:
				if (spec.name.startsWith("vits-piper-")) return `old voice: ${spec.name.slice("vits-piper-".length)}`;
				if (spec.name.startsWith("sherpa-onnx-whisper-")) return `old speech-to-text: ${spec.name.slice("sherpa-onnx-whisper-".length)}`;
				return spec.name;
		}
	}

	/** Name, label, kind and size (real size on disk, or the download size). */
	file(spec: ModelSpec, onDisk: boolean): SpeechFile {
		const sizeMB = onDisk ? Math.round(this.models.sizeOf(spec) / 1e6) : spec.approxMB;
		return { name: spec.name, label: this.describe(spec), kind: spec.kind, sizeMB };
	}

	/** Speaks a short text with a specific voice (for "Send me a sample"). */
	async speakWith(text: string, language: string, voice: string): Promise<{ audio: Buffer; seconds: number }> {
		const spoken = await this.engine.speak(await this.ready(SUPERTONIC_SPEC), text, language, voice, this.settings.get().voiceSpeed);
		return encodeVoiceNote(spoken.samples, spoken.sampleRate);
	}

	/** Voice note audio → text and language. */
	async transcribe(audio: Buffer): Promise<Transcript> {
		const dir = await this.ready(WHISPER_SPEC);
		const samples = await decodeToSamples(audio);
		const first = await this.engine.transcribe(dir, samples);
		const enabled = this.settings.get().languages;
		if (!first.text) return { text: "", ms: first.ms };
		// The language comes from the text (OpenVINO doesn't report Whisper's guess).
		const heard = detectLanguage(first.text, allLanguageCodes());
		if (!heard || enabled.includes(heard)) {
			const language = heard ?? detectLanguage(first.text, enabled);
			return { text: first.text, ...(language ? { language } : {}), ms: first.ms };
		}
		// Whisper wrote a language the user doesn't use (e.g. Polish for a short Turkish
		// note): decode again in the most likely enabled language.
		const retry = detectLanguage(first.text, enabled) ?? enabled[0]!;
		log.info(`heard ${heard}; retrying as ${retry}`);
		const second = await this.engine.transcribe(dir, samples, retry);
		return { text: second.text || first.text, language: retry, ms: first.ms + second.ms };
	}

	/** Text → WhatsApp voice note in the given language, with that language's voice. */
	async speak(text: string, language: string): Promise<{ audio: Buffer; seconds: number }> {
		const settings = this.settings.get();
		if (!getLanguage(language)) throw new Error(`no voice for ${languageLabel(language)}`);
		const spoken = await this.engine.speak(await this.ready(SUPERTONIC_SPEC), text, language, this.voiceFor(language, settings), settings.voiceSpeed);
		return encodeVoiceNote(spoken.samples, spoken.sampleRate);
	}

	/** One line for /status. */
	statusLine(): string {
		const missing = this.missingModels();
		const downloading = missing.filter((spec) => this.models.isDownloading(spec));
		const disk = `${Math.round(this.models.diskUsage() / 1e6)} MB on disk`;
		if (downloading.length > 0) return `Voice: downloading ${downloading.map((spec) => this.describe(spec)).join(", ")} · ${disk}`;
		if (missing.length > 0) return `Voice: ${missing.length} file set(s) still to download (on first use) · ${disk}`;
		return `Voice: ready · ${disk}${this.engine.isLoaded() ? " · loaded" : ""}`;
	}

	async shutdown(): Promise<void> {
		await this.engine.unload();
	}

	/** Makes sure the engine and the given model are on disk; returns the model folder. */
	private async ready(spec: ModelSpec): Promise<string> {
		await this.models.ensure(RUNTIME_SPEC);
		return this.models.ensure(spec);
	}
}

function allLanguageCodes(): string[] {
	return LANGUAGES.map((language) => language.code);
}
