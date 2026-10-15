/**
 * Speech models: what exists, where it lives on disk, and downloading it.
 * Models come from the sherpa-onnx GitHub releases and are unpacked under
 * ~/.pi/agent/pi-harness-whatsapp/models/<name>/.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createLogger } from "../log.ts";
import type { SpeechModel } from "../settings.ts";

const log = createLogger("models");
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const DONE_MARKER = ".complete";

export interface ModelSpec {
	/** Directory name under models/, also the archive name without .tar.bz2. */
	name: string;
	url: string;
	/** Rough download size, for messages. */
	approxMB: number;
	kind: "stt" | "tts";
}

export const SPEECH_MODEL_SPECS: Record<SpeechModel, ModelSpec> = {
	base: { name: "sherpa-onnx-whisper-base", url: `${RELEASES}/asr-models/sherpa-onnx-whisper-base.tar.bz2`, approxMB: 208, kind: "stt" },
	small: { name: "sherpa-onnx-whisper-small", url: `${RELEASES}/asr-models/sherpa-onnx-whisper-small.tar.bz2`, approxMB: 639, kind: "stt" },
	turbo: { name: "sherpa-onnx-whisper-turbo", url: `${RELEASES}/asr-models/sherpa-onnx-whisper-turbo.tar.bz2`, approxMB: 564, kind: "stt" },
};

export function voiceModelSpec(voiceId: string): ModelSpec {
	const name = `vits-piper-${voiceId}`;
	return { name, url: `${RELEASES}/tts-models/${name}.tar.bz2`, approxMB: 67, kind: "tts" };
}

/** Files the recognizer needs, found by pattern because releases name them per size. */
export interface WhisperFiles {
	encoder: string;
	decoder: string;
	tokens: string;
}

export interface PiperFiles {
	model: string;
	tokens: string;
	dataDir: string;
}

export type ProgressListener = (spec: ModelSpec, fraction: number | undefined) => void;

export class ModelStore {
	private readonly inFlight = new Map<string, Promise<string>>();

	constructor(
		private readonly root: string,
		private readonly onProgress?: ProgressListener,
	) {}

	dir(spec: ModelSpec): string {
		return join(this.root, spec.name);
	}

	isInstalled(spec: ModelSpec): boolean {
		return existsSync(join(this.dir(spec), DONE_MARKER));
	}

	/** Downloads and unpacks the model unless it's already there. Concurrent calls share one download. */
	ensure(spec: ModelSpec): Promise<string> {
		if (this.isInstalled(spec)) return Promise.resolve(this.dir(spec));
		const running = this.inFlight.get(spec.name);
		if (running) return running;
		const job = this.install(spec).finally(() => this.inFlight.delete(spec.name));
		this.inFlight.set(spec.name, job);
		return job;
	}

	isDownloading(spec: ModelSpec): boolean {
		return this.inFlight.has(spec.name);
	}

	/** Names of fully installed models. */
	installedNames(): string[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root).filter((name) => existsSync(join(this.root, name, DONE_MARKER)));
	}

	remove(spec: ModelSpec): void {
		rmSync(this.dir(spec), { recursive: true, force: true });
	}

	/** Disk use of one model, in bytes. */
	sizeOf(spec: ModelSpec): number {
		return folderSize(this.dir(spec));
	}

	/** Disk use of installed models, in bytes. */
	diskUsage(): number {
		return folderSize(this.root);
	}

	whisperFiles(spec: ModelSpec): WhisperFiles {
		const dir = this.dir(spec);
		const files = readdirSync(dir);
		const pick = (pattern: RegExp, what: string) => {
			const found = files.find((file) => pattern.test(file));
			if (!found) throw new Error(`${spec.name}: ${what} not found`);
			return join(dir, found);
		};
		return {
			encoder: pick(/encoder\.int8\.onnx$/, "encoder"),
			decoder: pick(/decoder\.int8\.onnx$/, "decoder"),
			tokens: pick(/tokens\.txt$/, "tokens"),
		};
	}

	piperFiles(spec: ModelSpec): PiperFiles {
		const dir = this.dir(spec);
		const model = readdirSync(dir).find((file) => file.endsWith(".onnx"));
		if (!model) throw new Error(`${spec.name}: voice model not found`);
		return { model: join(dir, model), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data") };
	}

	private async install(spec: ModelSpec): Promise<string> {
		mkdirSync(this.root, { recursive: true });
		const archive = join(this.root, `${spec.name}.tar.bz2.part`);
		const staging = join(this.root, `.${spec.name}.unpacking`);
		log.info(`downloading ${spec.url}`);
		this.onProgress?.(spec, 0);
		try {
			await this.download(spec, archive);
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			await run("tar", ["--no-same-owner", "-xjf", archive, "-C", staging]);
			// Archives contain one top-level folder named like the model.
			const inner = readdirSync(staging);
			const source = inner.length === 1 && statSync(join(staging, inner[0]!)).isDirectory() ? join(staging, inner[0]!) : staging;
			if (spec.kind === "stt") pruneWhisper(source);
			const target = this.dir(spec);
			rmSync(target, { recursive: true, force: true });
			renameSync(source, target);
			writeFileSync(join(target, DONE_MARKER), new Date().toISOString());
			log.info(`installed ${spec.name}`);
			return target;
		} finally {
			rmSync(archive, { force: true });
			rmSync(staging, { recursive: true, force: true });
			this.onProgress?.(spec, undefined);
		}
	}

	private async download(spec: ModelSpec, target: string): Promise<void> {
		const response = await fetch(spec.url, { redirect: "follow" });
		if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${spec.name}`);
		const total = Number(response.headers.get("content-length") ?? 0);
		let received = 0;
		let lastReport = 0;
		const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
		body.on("data", (chunk: Buffer) => {
			received += chunk.length;
			const now = Date.now();
			if (total > 0 && now - lastReport > 1000) {
				lastReport = now;
				this.onProgress?.(spec, received / total);
			}
		});
		await pipeline(body, createWriteStream(target));
		if (total > 0 && received !== total) throw new Error(`download of ${spec.name} was incomplete`);
	}
}

function folderSize(path: string): number {
	if (!existsSync(path)) return 0;
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		total += entry.isDirectory() ? folderSize(full) : statSync(full).size;
	}
	return total;
}

/** Keeps only the int8 encoder/decoder and tokens; the full-precision copies are large and unused. */
function pruneWhisper(dir: string): void {
	for (const file of readdirSync(dir)) {
		const keep = /\.int8\.onnx$/.test(file) || /tokens\.txt$/.test(file) || /^(README|LICENSE)/i.test(file);
		if (!keep) rmSync(join(dir, file), { recursive: true, force: true });
	}
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))));
	});
}
