/**
 * Supertonic 3 text-to-speech on OpenVINO. Ported from Supertone's MIT-licensed
 * reference code (github.com/supertone-inc/supertonic, nodejs/helper.js), with
 * ONNX Runtime swapped for OpenVINO.
 *
 * Four models: duration predictor → text encoder → vector estimator (run
 * `steps` times, from noise to a speech latent) → vocoder (latent → audio).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Languages Supertonic 3 speaks. */
export const SUPERTONIC_LANGUAGES = new Set([
	"en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
	"id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
]);

/** Denoising steps; Supertone's default. */
export const DEFAULT_STEPS = 8;
/** Supertone's default speed; our speed setting (1.0 = normal) is scaled by it. */
export const BASE_SPEED = 1.05;

const EMOJI = /[\u{1f600}-\u{1f64f}\u{1f300}-\u{1f5ff}\u{1f680}-\u{1f6ff}\u{1f700}-\u{1f77f}\u{1f780}-\u{1f7ff}\u{1f800}-\u{1f8ff}\u{1f900}-\u{1f9ff}\u{1fa00}-\u{1fa6f}\u{1fa70}-\u{1faff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}]+/gu;
const REPLACEMENTS: Array<[string, string]> = [
	["–", "-"], ["‑", "-"], ["—", "-"], ["_", " "], ["“", '"'], ["”", '"'], ["‘", "'"], ["’", "'"],
	["´", "'"], ["`", "'"], ["[", " "], ["]", " "], ["|", " "], ["/", " "], ["#", " "], ["→", " "], ["←", " "],
];

/** Same cleanup as Supertone's reference, plus the language tags the model expects. */
export function prepareText(text: string, lang: string): string {
	let out = text.normalize("NFKD").replace(EMOJI, "");
	for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
	out = out.replace(/[♥☆♡©\\]/g, "");
	out = out.split("@").join(" at ").split("e.g.,").join("for example, ").split("i.e.,").join("that is, ");
	out = out.replace(/ ,/g, ",").replace(/ \./g, ".").replace(/ !/g, "!").replace(/ \?/g, "?").replace(/ ;/g, ";").replace(/ :/g, ":").replace(/ '/g, "'");
	while (out.includes('""')) out = out.replace('""', '"');
	while (out.includes("''")) out = out.replace("''", "'");
	out = out.replace(/\s+/g, " ").trim();
	if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(out)) out += ".";
	if (!SUPERTONIC_LANGUAGES.has(lang)) throw new Error(`Supertonic doesn't speak "${lang}"`);
	return `<${lang}>${out}</${lang}>`;
}

/** Splits into sentence-sized chunks of at most maxLen characters (Supertone's rule). */
export function chunkText(text: string, maxLen = 300): string[] {
	const chunks: string[] = [];
	for (const paragraph of text.trim().split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)) {
		const sentences = paragraph.split(
			/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/,
		);
		let current = "";
		for (const sentence of sentences.flatMap((sentence) => splitLong(sentence, maxLen))) {
			if (current.length + sentence.length + 1 <= maxLen) current += (current ? " " : "") + sentence;
			else {
				if (current) chunks.push(current.trim());
				current = sentence;
			}
		}
		if (current) chunks.push(current.trim());
	}
	return chunks;
}

/** A sentence longer than maxLen, cut at commas or spaces (very long inputs need much more memory). */
function splitLong(sentence: string, maxLen: number): string[] {
	const parts: string[] = [];
	let rest = sentence;
	while (rest.length > maxLen) {
		const window = rest.slice(0, maxLen);
		let cut = window.lastIndexOf(", ");
		if (cut < maxLen * 0.5) cut = window.lastIndexOf(" ");
		cut = cut > 0 ? cut + 1 : maxLen;
		parts.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) parts.push(rest);
	return parts;
}

/** Standard normal noise (Box–Muller). */
function gaussian(size: number, random: () => number = Math.random): Float32Array {
	const out = new Float32Array(size);
	for (let i = 0; i < size; i++) {
		const u1 = Math.max(1e-10, random());
		out[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
	}
	return out;
}

// Minimal shapes of the openvino-node API used here (it's loaded lazily).
interface OvTensor {
	getData(): Float32Array | BigInt64Array;
	getShape(): number[];
}
interface OvRequest {
	inferAsync(inputs: OvTensor[]): Promise<Record<string, OvTensor>>;
}
export interface OpenVino {
	Core: new () => {
		compileModel(path: string, device: string): Promise<{ inputs: Array<{ getAnyName(): string }>; createInferRequest(): OvRequest }>;
	};
	Tensor: new (type: string, shape: number[], data: Float32Array | BigInt64Array) => OvTensor;
}

/**
 * One compiled model. openvino-node matches inputs by position, so inputs are
 * passed in the order the model declares them, looked up by name.
 */
class Model {
	constructor(
		private readonly inputNames: string[],
		private readonly request: OvRequest,
	) {}

	run(inputs: Record<string, OvTensor>): Promise<Record<string, OvTensor>> {
		return this.request.inferAsync(
			this.inputNames.map((name) => {
				const tensor = inputs[name];
				if (!tensor) throw new Error(`missing model input "${name}"`);
				return tensor;
			}),
		);
	}
}

interface Style {
	ttl: OvTensor;
	dp: OvTensor;
}

export class Supertonic {
	private readonly styles = new Map<string, Style>();

	private constructor(
		private readonly ov: OpenVino,
		private readonly dir: string,
		private readonly config: { sampleRate: number; baseChunkSize: number; chunkCompress: number; latentDim: number },
		private readonly indexer: number[],
		private readonly models: { duration: Model; textEncoder: Model; vectorEstimator: Model; vocoder: Model },
	) {}

	static async load(ov: OpenVino, dir: string, device = "CPU"): Promise<Supertonic> {
		const cfg = JSON.parse(readFileSync(join(dir, "onnx", "tts.json"), "utf8")) as {
			ae: { sample_rate: number; base_chunk_size: number };
			ttl: { chunk_compress_factor: number; latent_dim: number };
		};
		const indexer = JSON.parse(readFileSync(join(dir, "onnx", "unicode_indexer.json"), "utf8")) as number[];
		const core = new ov.Core();
		const compile = async (name: string): Promise<Model> => {
			const compiled = await core.compileModel(join(dir, "onnx", `${name}.onnx`), device);
			return new Model(compiled.inputs.map((input) => input.getAnyName()), compiled.createInferRequest());
		};
		const [duration, textEncoder, vectorEstimator, vocoder] = await Promise.all(
			["duration_predictor", "text_encoder", "vector_estimator", "vocoder"].map(compile),
		);
		return new Supertonic(
			ov,
			dir,
			{ sampleRate: cfg.ae.sample_rate, baseChunkSize: cfg.ae.base_chunk_size, chunkCompress: cfg.ttl.chunk_compress_factor, latentDim: cfg.ttl.latent_dim },
			indexer,
			{ duration: duration!, textEncoder: textEncoder!, vectorEstimator: vectorEstimator!, vocoder: vocoder! },
		);
	}

	get sampleRate(): number {
		return this.config.sampleRate;
	}

	/** Text → mono samples. Long text is spoken chunk by chunk with short pauses in between. */
	async speak(text: string, lang: string, voice: string, speed = 1.0, steps = DEFAULT_STEPS): Promise<Float32Array> {
		const style = this.style(voice);
		const pause = new Float32Array(Math.floor(0.3 * this.config.sampleRate));
		const parts: Float32Array[] = [];
		for (const chunk of chunkText(text, lang === "ko" || lang === "ja" ? 120 : 300)) {
			if (parts.length > 0) parts.push(pause);
			parts.push(await this.speakChunk(chunk, lang, style, speed * BASE_SPEED, steps));
		}
		const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	}

	private style(voice: string): Style {
		const cached = this.styles.get(voice);
		if (cached) return cached;
		if (!/^[FM][1-5]$/.test(voice)) throw new Error(`unknown voice "${voice}"`);
		const json = JSON.parse(readFileSync(join(this.dir, "voice_styles", `${voice}.json`), "utf8")) as {
			style_ttl: { dims: number[]; data: unknown[] };
			style_dp: { dims: number[]; data: unknown[] };
		};
		const tensor = (part: { dims: number[]; data: unknown[] }) =>
			new this.ov.Tensor("f32", part.dims, Float32Array.from((part.data as unknown[]).flat(Infinity) as number[]));
		const style = { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
		this.styles.set(voice, style);
		return style;
	}

	private async speakChunk(text: string, lang: string, style: Style, speed: number, steps: number): Promise<Float32Array> {
		const { Tensor } = this.ov;
		const prepared = prepareText(text, lang);
		const ids = new BigInt64Array(prepared.length);
		for (let i = 0; i < prepared.length; i++) ids[i] = BigInt(this.indexer[prepared.charCodeAt(i)] ?? 0);
		const textIds = new Tensor("i64", [1, ids.length], ids);
		const textMask = new Tensor("f32", [1, 1, ids.length], new Float32Array(ids.length).fill(1));

		const dp = await this.models.duration.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
		const seconds = Number((dp.duration ?? Object.values(dp)[0]!).getData()[0]) / speed;
		const enc = await this.models.textEncoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
		const textEmb = enc.text_emb ?? Object.values(enc)[0]!;

		const { sampleRate, baseChunkSize, chunkCompress, latentDim } = this.config;
		const wavLength = Math.floor(seconds * sampleRate);
		const chunk = baseChunkSize * chunkCompress;
		const latentLen = Math.max(1, Math.floor((wavLength + chunk - 1) / chunk));
		const dim = latentDim * chunkCompress;
		let latent = gaussian(dim * latentLen);
		const latentMask = new Tensor("f32", [1, 1, latentLen], new Float32Array(latentLen).fill(1));
		const total = new Tensor("f32", [1], Float32Array.of(steps));
		for (let step = 0; step < steps; step++) {
			const result = await this.models.vectorEstimator.run({
				noisy_latent: new Tensor("f32", [1, dim, latentLen], latent),
				text_emb: textEmb,
				style_ttl: style.ttl,
				text_mask: textMask,
				latent_mask: latentMask,
				total_step: total,
				current_step: new Tensor("f32", [1], Float32Array.of(step)),
			});
			latent = Float32Array.from((result.denoised_latent ?? Object.values(result)[0]!).getData() as Float32Array);
		}
		const voc = await this.models.vocoder.run({ latent: new Tensor("f32", [1, dim, latentLen], latent) });
		const wav = (voc.wav_tts ?? Object.values(voc)[0]!).getData() as Float32Array;
		// The vocoder pads to whole latent chunks; keep only the predicted duration.
		return Float32Array.from(wav.subarray(0, Math.min(wav.length, wavLength)));
	}
}
