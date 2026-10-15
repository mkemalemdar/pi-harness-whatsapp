/**
 * Speech files: what exists, where it lives on disk, and downloading it.
 *
 * - Speech-to-text: Whisper large-v3-turbo (int8), exported for OpenVINO by Intel.
 * - Text-to-speech: Supertonic 3 (ONNX, 31 languages, 10 voices), run by OpenVINO.
 * - The OpenVINO engine itself: Intel's two Node packages and their native
 *   libraries. They are fetched here instead of through npm, because their npm
 *   install scripts download the libraries in a way that fails in some setups
 *   (e.g. as root in a container), which would break installing the extension.
 *
 * Everything is unpacked under ~/.pi/agent/pi-harness-whatsapp/models/<name>/.
 * Every download is pinned (Hugging Face commits, npm integrity hashes) or
 * checked against the publisher's checksum, so every install gets the tested files.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createLogger } from "../log.ts";

const log = createLogger("models");
const DONE_MARKER = ".complete";
const HF = "https://huggingface.co";
const OPENVINO_STORAGE = "https://storage.openvinotoolkit.org/repositories";
const NPM_REGISTRY = "https://registry.npmjs.org";

export type ModelKind = "stt" | "tts" | "runtime" | "old";

export interface ModelSpec {
	/** Directory name under models/ (or a fixed name for the engine). */
	name: string;
	kind: ModelKind;
	/** Rough download size, for messages. */
	approxMB: number;
	/** Hugging Face repo, commit, and the files to fetch (path prefixes). */
	hf?: { repo: string; revision: string; include?: string[] };
}

export const WHISPER_SPEC: ModelSpec = {
	name: "whisper-large-v3-turbo-int8-ov",
	kind: "stt",
	approxMB: 828,
	hf: { repo: "OpenVINO/whisper-large-v3-turbo-int8-ov", revision: "b568445dd5dc8c695bde596f8acbb4694fd6ba64" },
};

export const SUPERTONIC_SPEC: ModelSpec = {
	name: "supertonic-3",
	kind: "tts",
	approxMB: 401,
	hf: { repo: "Supertone/supertonic-3", revision: "3cadd1ee6394adea1bd021217a0e650ede09a323", include: ["onnx/", "voice_styles/", "LICENSE"] },
};

export const RUNTIME_SPEC: ModelSpec = { name: "openvino-runtime", kind: "runtime", approxMB: 195 };

/** A model folder from an older version of the extension (Piper voices, sherpa Whisper). */
export function oldModelSpec(name: string): ModelSpec {
	return { name, kind: "old", approxMB: 0 };
}

/**
 * Intel's Node packages for OpenVINO: the npm tarball (pinned by its integrity
 * hash) and the native libraries for this platform (checked against Intel's .sha256).
 */
export const RUNTIME_PACKAGES = [
	{
		name: "openvino-node",
		version: "2026.4.1",
		integrity: "sha512-nINwp1d+sYSXfQjYgr6cYaJWCp6UVRcYye6nYL7XALGEoUIcgN4N+qrjM6DWKN4zaBYJlY3crv2q7IO0VsgBsQ==",
		binary: (os: string, cpu: string) =>
			`openvino/nodejs_bindings/2026.4.1/${os}/openvino_nodejs_bindings_${os}_2026.4.1_${cpu}.tar.gz`,
	},
	{
		name: "openvino-genai-node",
		version: "2026.4.1",
		integrity: "sha512-W48O4a+tUKVWRlbx9YycQrzutXN1NuogE3pIHdCn6+tZyGxzuUX/H6zBlqNblEzivm/uj+z+vkNIp6eEL9k9xg==",
		binary: (os: string, cpu: string) =>
			`openvino_genai/nodejs_bindings/2026.4.1.0/${os}/openvino_genai_nodejs_bindings_${os}_2026.4.1.0_${cpu}.tar.gz`,
	},
] as const;

/** OpenVINO publishes Node builds for these platforms only. */
export function runtimeSupported(os = platform(), cpu = arch()): boolean {
	return (os === "linux" && (cpu === "x64" || cpu === "arm64")) || (os === "win32" && cpu === "x64") || (os === "darwin" && cpu === "arm64");
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

	/** Downloads and unpacks unless it's already there. Concurrent calls share one download. */
	ensure(spec: ModelSpec): Promise<string> {
		if (this.isInstalled(spec)) return Promise.resolve(this.dir(spec));
		const running = this.inFlight.get(spec.name);
		if (running) return running;
		const job = (spec.kind === "runtime" ? this.installRuntime(spec) : this.install(spec)).finally(() => this.inFlight.delete(spec.name));
		this.inFlight.set(spec.name, job);
		return job;
	}

	isDownloading(spec: ModelSpec): boolean {
		return this.inFlight.has(spec.name);
	}

	/** Names of fully installed model folders. */
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

	/** Disk use of everything installed, in bytes. */
	diskUsage(): number {
		return folderSize(this.root);
	}

	private async install(spec: ModelSpec): Promise<string> {
		if (!spec.hf) throw new Error(`${spec.name} can't be downloaded`);
		mkdirSync(this.root, { recursive: true });
		const staging = join(this.root, `.${spec.name}.downloading`);
		log.info(`downloading ${spec.hf.repo}@${spec.hf.revision.slice(0, 8)}`);
		this.onProgress?.(spec, 0);
		try {
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			const files = await listRepoFiles(spec.hf.repo, spec.hf.revision, spec.hf.include);
			const total = files.reduce((sum, file) => sum + file.size, 0);
			let done = 0;
			for (const file of files) {
				const target = join(staging, file.path);
				mkdirSync(dirname(target), { recursive: true });
				await this.fetchTo(spec, `${HF}/${spec.hf.repo}/resolve/${spec.hf.revision}/${file.path}`, target, (bytes) => {
					if (total > 0) this.onProgress?.(spec, (done + bytes) / total);
				});
				done += file.size;
			}
			const target = this.dir(spec);
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
			writeFileSync(join(target, DONE_MARKER), new Date().toISOString());
			log.info(`installed ${spec.name}`);
			return target;
		} finally {
			rmSync(staging, { recursive: true, force: true });
			this.onProgress?.(spec, undefined);
		}
	}

	/** Installs Intel's two packages as models/openvino-runtime/node_modules/<name>/ (with bin/). */
	private async installRuntime(spec: ModelSpec): Promise<string> {
		const os = platform();
		const cpu = arch();
		if (!runtimeSupported(os, cpu)) {
			throw new Error(`OpenVINO has no build for ${os}/${cpu}, so voice notes can't work on this machine`);
		}
		mkdirSync(this.root, { recursive: true });
		const staging = join(this.root, `.${spec.name}.downloading`);
		this.onProgress?.(spec, 0);
		try {
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			const steps = RUNTIME_PACKAGES.length * 2;
			let step = 0;
			const progress = (bytes: number, expected: number) => this.onProgress?.(spec, Math.min(0.99, (step + Math.min(1, bytes / expected)) / steps));
			for (const pkg of RUNTIME_PACKAGES) {
				const target = join(staging, "node_modules", pkg.name);
				mkdirSync(join(target, "bin"), { recursive: true });
				// The package's JavaScript, from npm, checked against the pinned integrity hash.
				const tarball = join(staging, `${pkg.name}.tgz`);
				log.info(`downloading ${pkg.name} ${pkg.version}`);
				await this.fetchTo(spec, `${NPM_REGISTRY}/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`, tarball, (bytes) => progress(bytes, 1e6));
				if ((await fileHash(tarball, "sha512", "base64")) !== pkg.integrity.slice("sha512-".length)) {
					throw new Error(`${pkg.name} failed its integrity check`);
				}
				// --no-same-owner: as root in a container, keeping the archive's owners fails.
				await run("tar", ["--no-same-owner", "-xzf", tarball, "-C", target, "--strip-components=1"]);
				rmSync(tarball, { force: true });
				step++;
				// The native libraries, from Intel, checked against Intel's published checksum.
				const url = `${OPENVINO_STORAGE}/${pkg.binary(os, cpu)}`;
				const archive = join(staging, `${pkg.name}-bin.tgz`);
				const checksum = await fetchText(`${url}.sha256`);
				log.info(`downloading the ${pkg.name} native libraries`);
				await this.fetchTo(spec, url, archive, (bytes) => progress(bytes, 120e6));
				if ((await fileHash(archive, "sha256", "hex")) !== checksum.trim().split(/\s+/)[0]) {
					throw new Error(`${pkg.name} native libraries failed their checksum`);
				}
				await run("tar", ["--no-same-owner", "-xzf", archive, "-C", join(target, "bin")]);
				rmSync(archive, { force: true });
				step++;
			}
			const target = this.dir(spec);
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
			writeFileSync(join(target, DONE_MARKER), new Date().toISOString());
			log.info("installed the OpenVINO runtime");
			return target;
		} finally {
			rmSync(staging, { recursive: true, force: true });
			this.onProgress?.(spec, undefined);
		}
	}

	private async fetchTo(spec: ModelSpec, url: string, target: string, onBytes: (bytes: number) => void): Promise<void> {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${spec.name}`);
		const expected = Number(response.headers.get("content-length") ?? 0);
		let received = 0;
		let lastReport = 0;
		const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
		body.on("data", (chunk: Buffer) => {
			received += chunk.length;
			const now = Date.now();
			if (now - lastReport > 1000) {
				lastReport = now;
				onBytes(received);
			}
		});
		await pipeline(body, createWriteStream(target));
		if (expected > 0 && received !== expected) throw new Error(`download of ${spec.name} was incomplete`);
		onBytes(received);
	}
}

/** Files of a Hugging Face repo at a commit, optionally only those under the given prefixes. */
async function listRepoFiles(repo: string, revision: string, include?: string[]): Promise<Array<{ path: string; size: number }>> {
	const response = await fetch(`${HF}/api/models/${repo}/tree/${revision}?recursive=true`);
	if (!response.ok) throw new Error(`could not list ${repo} (${response.status})`);
	const entries = (await response.json()) as Array<{ type: string; path: string; size?: number; lfs?: { size?: number } }>;
	return entries
		.filter((entry) => entry.type === "file" && !entry.path.startsWith(".") && entry.path !== "README.md")
		.filter((entry) => !include || include.some((prefix) => entry.path.startsWith(prefix)))
		.map((entry) => ({ path: entry.path, size: entry.lfs?.size ?? entry.size ?? 0 }));
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
	return response.text();
}

function fileHash(path: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash(algorithm);
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest(encoding)));
	});
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
