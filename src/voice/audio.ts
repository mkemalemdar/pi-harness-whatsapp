// ffmpeg helpers: WhatsApp audio ↔ raw samples. Everything goes through pipes, no temp files.

import { spawn } from "node:child_process";

const TIMEOUT_MS = 120_000;

function ffmpeg(args: string[], input: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" ? new Error("ffmpeg is not installed (needed for voice notes)") : error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`));
		});
		child.stdin.on("error", () => {
			// ffmpeg may close stdin early on bad input; the close handler reports it.
		});
		child.stdin.end(input);
	});
}

/** Any audio (WhatsApp sends ogg/opus) → 16 kHz mono float samples for Whisper. */
export async function decodeToSamples(audio: Buffer, sampleRate = 16000): Promise<Float32Array> {
	const raw = await ffmpeg(["-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", String(sampleRate), "pipe:1"], audio);
	// Copy into an aligned buffer: Buffer slices may not start on a 4-byte boundary.
	const aligned = new ArrayBuffer(raw.byteLength - (raw.byteLength % 4));
	new Uint8Array(aligned).set(raw.subarray(0, aligned.byteLength));
	return new Float32Array(aligned);
}

/** Float samples → ogg/opus, the format WhatsApp plays as a voice note. */
export async function encodeVoiceNote(samples: Float32Array, sampleRate: number): Promise<{ audio: Buffer; seconds: number }> {
	const input = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
	const audio = await ffmpeg(
		[
			"-f",
			"f32le",
			"-ar",
			String(sampleRate),
			"-ac",
			"1",
			"-i",
			"pipe:0",
			"-c:a",
			"libopus",
			"-b:a",
			"32k",
			"-ar",
			"48000",
			"-application",
			"voip",
			"-f",
			"ogg",
			"pipe:1",
		],
		input,
	);
	return { audio, seconds: Math.max(1, Math.round(samples.length / sampleRate)) };
}

export async function ffmpegAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}
