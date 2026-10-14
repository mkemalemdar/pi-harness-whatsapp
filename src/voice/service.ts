/**
 * Voice: understands voice notes and speaks replies, downloading the needed
 * models on first use (and in the background when settings change).
 */

import { getLanguage, languageLabel } from "../languages.ts";
import { createLogger } from "../log.ts";
import type { GlobalSettings, SettingsStore } from "../settings.ts";
import { decodeToSamples, encodeVoiceNote } from "./audio.ts";
import { SpeechEngine } from "./engine.ts";
import { detectLanguage } from "./language.ts";
import { type ModelSpec, ModelStore, SPEECH_MODEL_SPECS, voiceModelSpec } from "./models.ts";

const log = createLogger("voice");
/** Longer replies are spoken only partly; the full text is sent as well. */
export const MAX_SPOKEN_CHARS = 1500;

export interface Transcript {
	text: string;
	language?: string;
	ms: number;
}

export interface VoiceEvents {
	/** A download started (fraction 0), progressed, or finished (undefined). */
	onDownload?(spec: ModelSpec, fraction: number | undefined): void;
}

export class VoiceService {
	readonly models: ModelStore;
	readonly engine = new SpeechEngine();

	constructor(
		private readonly settings: SettingsStore,
		modelsDir: string,
		private readonly events: VoiceEvents = {},
	) {
		this.models = new ModelStore(modelsDir, (spec, fraction) => this.events.onDownload?.(spec, fraction));
	}

	speechModelSpec(settings: Readonly<GlobalSettings> = this.settings.get()): ModelSpec {
		return SPEECH_MODEL_SPECS[settings.speechModel];
	}

	voiceSpec(language: string, settings: Readonly<GlobalSettings> = this.settings.get()): ModelSpec | undefined {
		const voice = settings.voices[language] ?? getLanguage(language)?.voices[0]?.id;
		return voice ? voiceModelSpec(voice) : undefined;
	}

	/** Every model the current settings need. */
	neededModels(settings: Readonly<GlobalSettings> = this.settings.get()): ModelSpec[] {
		const specs = [this.speechModelSpec(settings)];
		if (settings.voiceMode !== "off") {
			for (const language of settings.languages) {
				const spec = this.voiceSpec(language, settings);
				if (spec) specs.push(spec);
			}
		}
		return specs;
	}

	/** Starts downloading anything missing, without waiting. */
	prefetch(): void {
		for (const spec of this.neededModels()) {
			if (this.models.isInstalled(spec) || this.models.isDownloading(spec)) continue;
			void this.models.ensure(spec).catch((error) => log.warn(`background download of ${spec.name} failed`, error));
		}
	}

	/** Installed models the current settings no longer use (all speech sizes and voices are candidates). */
	unusedModels(): ModelSpec[] {
		const needed = new Set(this.neededModels().map((spec) => spec.name));
		const settings = this.settings.get();
		const candidates: ModelSpec[] = [...Object.values(SPEECH_MODEL_SPECS)];
		for (const language of settings.languages) {
			for (const voice of getLanguage(language)?.voices ?? []) candidates.push(voiceModelSpec(voice.id));
		}
		for (const name of this.models.installedNames()) {
			if (name.startsWith("vits-piper-")) candidates.push(voiceModelSpec(name.slice("vits-piper-".length)));
		}
		const unique = new Map(candidates.map((spec) => [spec.name, spec]));
		return [...unique.values()].filter((spec) => !needed.has(spec.name) && this.models.isInstalled(spec));
	}

	missingModels(): ModelSpec[] {
		return this.neededModels().filter((spec) => !this.models.isInstalled(spec));
	}

	/** Voice note audio → text and language. */
	async transcribe(audio: Buffer): Promise<Transcript> {
		const settings = this.settings.get();
		const spec = this.speechModelSpec(settings);
		await this.models.ensure(spec);
		const files = this.models.whisperFiles(spec);
		const samples = await decodeToSamples(audio);
		const keep = new Float32Array(samples); // the first pass transfers its copy to the worker
		const first = await this.engine.transcribe(files, samples);
		const enabled = settings.languages;
		if (!first.language || enabled.includes(first.language) || !first.text) {
			return { text: first.text, ...(first.language ? { language: first.language } : {}), ms: first.ms };
		}
		// Whisper heard a language the user doesn't use (e.g. Azerbaijani for Turkish):
		// decode again in the most likely enabled language.
		const retry = detectLanguage(first.text, enabled) ?? enabled[0]!;
		log.info(`whisper detected ${first.language}; retrying as ${retry}`);
		const second = await this.engine.transcribe(files, keep, retry);
		return { text: second.text || first.text, language: retry, ms: first.ms + second.ms };
	}

	/** Text → WhatsApp voice note in the given language. */
	async speak(text: string, language: string): Promise<{ audio: Buffer; seconds: number }> {
		const settings = this.settings.get();
		const spec = this.voiceSpec(language, settings);
		if (!spec) throw new Error(`no voice for ${languageLabel(language)}`);
		await this.models.ensure(spec);
		const spoken = await this.engine.speak(this.models.piperFiles(spec), text, settings.voiceSpeed);
		return encodeVoiceNote(spoken.samples, spoken.sampleRate);
	}

	/** One line for /status. */
	statusLine(): string {
		const missing = this.missingModels();
		const downloading = missing.filter((spec) => this.models.isDownloading(spec));
		const disk = `${Math.round(this.models.diskUsage() / 1e6)} MB on disk`;
		if (downloading.length > 0) return `Voice models: downloading ${downloading.map((spec) => spec.name).join(", ")} · ${disk}`;
		if (missing.length > 0) return `Voice models: ${missing.length} still to download (on first use) · ${disk}`;
		return `Voice models: ready · ${disk}${this.engine.isLoaded() ? " · loaded" : ""}`;
	}

	async shutdown(): Promise<void> {
		await this.engine.unload();
	}
}
