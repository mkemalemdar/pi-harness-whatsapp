/**
 * Main-thread side of the speech worker: starts it on first use, queues
 * requests, and stops it after a while without work to give the RAM back.
 */

import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createLogger } from "../log.ts";
import type { PiperFiles, WhisperFiles } from "./models.ts";

const log = createLogger("speech");
const IDLE_UNLOAD_MS = 10 * 60_000;

interface Pending {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
}

function workerPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "worker.cjs");
}

/** Leave a couple of cores for Pi and the rest of the machine. */
export function defaultThreads(): number {
	return Math.max(1, Math.min(8, availableParallelism() - 2));
}

export class SpeechEngine {
	private worker: Worker | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly threads = defaultThreads()) {}

	async transcribe(files: WhisperFiles, samples: Float32Array, language?: string): Promise<{ text: string; language?: string; ms: number }> {
		const result = await this.request({ type: "transcribe", files, samples, threads: this.threads, ...(language ? { language } : {}) }, [
			samples.buffer as ArrayBuffer,
		]);
		return {
			text: String(result.text ?? ""),
			...(typeof result.language === "string" ? { language: result.language } : {}),
			ms: Number(result.ms ?? 0),
		};
	}

	async speak(files: PiperFiles, text: string, speed: number): Promise<{ samples: Float32Array; sampleRate: number; ms: number }> {
		// Piper is fast; two threads are plenty and leave room for Whisper.
		const result = await this.request({ type: "speak", files, text, speed, threads: Math.min(2, this.threads) });
		return { samples: result.samples as Float32Array, sampleRate: Number(result.sampleRate), ms: Number(result.ms ?? 0) };
	}

	/** Stops the worker and frees the models' memory. */
	async unload(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		const worker = this.worker;
		this.worker = undefined;
		if (worker) await worker.terminate();
		this.failAll(new Error("speech worker stopped"));
	}

	isLoaded(): boolean {
		return !!this.worker;
	}

	private request(message: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<Record<string, unknown>> {
		const worker = this.ensureWorker();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ ...message, id }, transfer);
		}).finally(() => this.scheduleUnload()) as Promise<Record<string, unknown>>;
	}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(workerPath());
		worker.unref();
		worker.on("message", (message: { id: number; ok: boolean; error?: string }) => {
			const waiting = this.pending.get(message.id);
			if (!waiting) return;
			this.pending.delete(message.id);
			if (message.ok) waiting.resolve(message as unknown as Record<string, unknown>);
			else waiting.reject(new Error(message.error ?? "speech failed"));
		});
		worker.on("error", (error) => {
			log.error("speech worker crashed", error);
			if (this.worker === worker) this.worker = undefined;
			this.failAll(error instanceof Error ? error : new Error(String(error)));
		});
		worker.on("exit", (code) => {
			if (this.worker === worker) this.worker = undefined;
			if (code !== 0) this.failAll(new Error(`speech worker exited (${code})`));
		});
		this.worker = worker;
		return worker;
	}

	private scheduleUnload(): void {
		if (this.pending.size > 0) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.unload(), IDLE_UNLOAD_MS);
		this.idleTimer.unref?.();
	}

	private failAll(error: Error): void {
		for (const waiting of this.pending.values()) waiting.reject(error);
		this.pending.clear();
	}
}
