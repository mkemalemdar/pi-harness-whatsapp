/**
 * Speech worker (plain CommonJS so it runs in a worker thread without a
 * TypeScript loader). Runs sherpa-onnx off Pi's main thread so the terminal
 * never freezes while Whisper or Piper are busy.
 *
 * Messages in:  { id, type: "transcribe", files, samples, language?, threads }
 *               { id, type: "speak", files, text, speed, threads }
 * Messages out: { id, ok: true, ... } | { id, ok: false, error }
 */

"use strict";

const { parentPort } = require("node:worker_threads");
const sherpa = require("sherpa-onnx-node");

const SAMPLE_RATE = 16000;
/** Whisper sees at most 30 s at once; cut a little earlier, at a quiet spot. */
const MAX_CHUNK_SECONDS = 28;
const MIN_CHUNK_SECONDS = 18;

let recognizer;
let recognizerKey = "";
const voices = new Map();

function getRecognizer(files, language, threads) {
	const key = `${files.encoder}|${language || "auto"}|${threads}`;
	if (recognizer && recognizerKey === key) return recognizer;
	recognizer = new sherpa.OfflineRecognizer({
		featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			whisper: { encoder: files.encoder, decoder: files.decoder, language: language || "", task: "transcribe", tailPaddings: -1 },
			tokens: files.tokens,
			numThreads: threads,
			provider: "cpu",
			debug: 0,
		},
	});
	recognizerKey = key;
	return recognizer;
}

/** Splits long audio at the quietest 0.4 s window between 18 and 28 seconds. */
function splitAtSilence(samples) {
	const chunks = [];
	const maxLength = MAX_CHUNK_SECONDS * SAMPLE_RATE;
	const minLength = MIN_CHUNK_SECONDS * SAMPLE_RATE;
	const window = Math.round(0.4 * SAMPLE_RATE);
	let start = 0;
	while (samples.length - start > maxLength) {
		let bestCut = start + maxLength;
		let bestEnergy = Number.POSITIVE_INFINITY;
		for (let cut = start + minLength; cut + window <= start + maxLength; cut += window / 2) {
			let energy = 0;
			for (let index = cut; index < cut + window; index++) energy += samples[index] * samples[index];
			if (energy < bestEnergy) {
				bestEnergy = energy;
				bestCut = cut + Math.round(window / 2);
			}
		}
		chunks.push(samples.subarray(start, bestCut));
		start = bestCut;
	}
	chunks.push(samples.subarray(start));
	return chunks;
}

function normalizeLanguage(lang) {
	if (!lang) return undefined;
	const match = /([a-z]{2,3})/i.exec(String(lang));
	return match ? match[1].toLowerCase() : undefined;
}

function decode(files, samples, language, threads) {
	const engine = getRecognizer(files, language, threads);
	const stream = engine.createStream();
	stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
	engine.decode(stream);
	const result = engine.getResult(stream);
	return { text: String(result.text || "").trim(), lang: normalizeLanguage(result.lang) };
}

function transcribe(message) {
	const chunks = splitAtSilence(message.samples);
	const texts = [];
	let language = message.language || undefined;
	for (const chunk of chunks) {
		// Detect the language on the first chunk, then keep it for the rest.
		const result = decode(message.files, chunk, language, message.threads);
		if (!language && result.lang) language = result.lang;
		if (result.text) texts.push(result.text);
	}
	return { text: texts.join(" ").trim(), language };
}

function speak(message) {
	const key = `${message.files.model}|${message.threads}`;
	let tts = voices.get(key);
	if (!tts) {
		tts = new sherpa.OfflineTts({
			model: {
				vits: { model: message.files.model, tokens: message.files.tokens, dataDir: message.files.dataDir },
				numThreads: message.threads,
				provider: "cpu",
				debug: 0,
			},
			maxNumSentences: 1,
		});
		voices.set(key, tts);
	}
	const audio = tts.generate({
		text: message.text,
		generationConfig: new sherpa.GenerationConfig({ sid: 0, speed: message.speed || 1.0 }),
	});
	return { samples: audio.samples, sampleRate: audio.sampleRate };
}

parentPort.on("message", (message) => {
	const started = Date.now();
	try {
		if (message.type === "transcribe") {
			const result = transcribe(message);
			parentPort.postMessage({ id: message.id, ok: true, ...result, ms: Date.now() - started });
		} else if (message.type === "speak") {
			const result = speak(message);
			const samples = Float32Array.from(result.samples);
			parentPort.postMessage({ id: message.id, ok: true, samples, sampleRate: result.sampleRate, ms: Date.now() - started }, [samples.buffer]);
		} else {
			parentPort.postMessage({ id: message.id, ok: false, error: `unknown request ${message.type}` });
		}
	} catch (error) {
		parentPort.postMessage({ id: message.id, ok: false, error: error && error.message ? error.message : String(error) });
	}
});
