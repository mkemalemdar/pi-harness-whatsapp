/**
 * The speech engine: Whisper (speech-to-text) and Supertonic (text-to-speech),
 * both running on OpenVINO on the CPU.
 *
 * OpenVINO does the heavy work on its own threads (the calls are async), so
 * Pi's terminal stays responsive. Models load on first use and are released
 * after 10 minutes without voice work. OpenVINO itself is loaded lazily from
 * the folder it was downloaded to (see models.ts), so the extension loads fine
 * before it is there.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../log.ts";
import { type OpenVino, Supertonic } from "./supertonic.ts";

const log = createLogger("engine");
const IDLE_UNLOAD_MS = 10 * 60_000;
const DEVICE = "CPU";

interface WhisperPipeline {
	generate(samples: Float32Array, options?: { generationConfig?: Record<string, unknown> }): Promise<{ texts: string[] }>;
}

export class SpeechEngine {
	private whisper: { dir: string; pipeline: WhisperPipeline } | undefined;
	private tts: { dir: string; engine: Supertonic } | undefined;
	private loading = new Map<string, Promise<unknown>>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	/** `runtimeDir` holds node_modules/openvino-node and node_modules/openvino-genai-node. */
	constructor(private readonly runtimeDir: () => string) {}

	isLoaded(): boolean {
		return !!this.whisper || !!this.tts;
	}

	/** Speech → text. `language` forces a language (e.g. "tr"); otherwise Whisper detects it. */
	async transcribe(modelDir: string, samples: Float32Array, language?: string): Promise<{ text: string; ms: number }> {
		const pipeline = await this.loadWhisper(modelDir);
		const started = Date.now();
		const result = await pipeline.generate(samples, {
			generationConfig: { task: "transcribe", ...(language ? { language: `<|${language}|>` } : {}) },
		});
		this.touch();
		return { text: (result.texts[0] ?? "").replace(/\s+/g, " ").trim(), ms: Date.now() - started };
	}

	/** Text → mono samples at the engine's sample rate. */
	async speak(modelDir: string, text: string, language: string, voice: string, speed: number): Promise<{ samples: Float32Array; sampleRate: number }> {
		const tts = await this.loadTts(modelDir);
		const samples = await tts.speak(text, language, voice, speed);
		this.touch();
		return { samples, sampleRate: tts.sampleRate };
	}

	async unload(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.isLoaded()) log.info("unloading speech models");
		// Dropping the references lets OpenVINO free the memory.
		this.whisper = undefined;
		this.tts = undefined;
	}

	private async loadWhisper(dir: string): Promise<WhisperPipeline> {
		if (this.whisper?.dir === dir) return this.whisper.pipeline;
		return this.once(`whisper:${dir}`, async () => {
			const started = Date.now();
			// An async factory: it loads the model and returns a ready pipeline.
			const entry = pathToFileURL(join(this.runtimeDir(), "node_modules", "openvino-genai-node", "dist", "index.js")).href;
			const { WhisperPipeline } = (await import(entry)) as unknown as {
				WhisperPipeline: (dir: string, device: string) => Promise<WhisperPipeline>;
			};
			const pipeline = await WhisperPipeline(dir, DEVICE);
			this.whisper = { dir, pipeline };
			log.info(`speech-to-text loaded in ${Date.now() - started}ms`);
			return pipeline;
		});
	}

	private async loadTts(dir: string): Promise<Supertonic> {
		if (this.tts?.dir === dir) return this.tts.engine;
		return this.once(`tts:${dir}`, async () => {
			const started = Date.now();
			const ov = (createRequire(join(this.runtimeDir(), "index.js"))("openvino-node") as { addon: OpenVino }).addon;
			const engine = await Supertonic.load(ov, dir, DEVICE);
			this.tts = { dir, engine };
			log.info(`text-to-speech loaded in ${Date.now() - started}ms`);
			return engine;
		});
	}

	/** Concurrent loads of the same model share one promise. */
	private once<T>(key: string, load: () => Promise<T>): Promise<T> {
		const running = this.loading.get(key) as Promise<T> | undefined;
		if (running) return running;
		const job = load().finally(() => this.loading.delete(key));
		this.loading.set(key, job);
		return job;
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.unload(), IDLE_UNLOAD_MS);
		this.idleTimer.unref?.();
	}
}
