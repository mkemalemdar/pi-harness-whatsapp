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
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createLogger } from "../log.ts";
import { isRemoved } from "../removed.ts";

const log = createLogger("models");
const DONE_MARKER = ".complete";
const HF = "https://huggingface.co";
const OPENVINO_STORAGE = "https://storage.openvinotoolkit.org/repositories";
const NPM_REGISTRY = "https://registry.npmjs.org";
/** A download that receives nothing for this long is given up (and tried again next time). */
const STALL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Tries per file; each retry continues where the last one stopped. */
const DOWNLOAD_ATTEMPTS = 4;

interface RepoFile {
	path: string;
	size: number;
	/** SHA-256 Hugging Face publishes for large (LFS) files. */
	sha256?: string;
}

export type ModelKind = "stt" | "tts" | "runtime";

export interface ModelSpec {
	/** Directory name under models/ (or a fixed name for the engine). */
	name: string;
	kind: ModelKind;
	/** Rough download size, for messages. */
	approxMB: number;
	/** Size on disk once installed, for the settings. */
	diskMB: number;
	/** Hugging Face repo, commit, and the files to fetch (path prefixes). */
	hf?: { repo: string; revision: string; include?: string[] };
}

export const WHISPER_SPEC: ModelSpec = {
	name: "whisper-large-v3-turbo-int8-ov",
	kind: "stt",
	approxMB: 828,
	diskMB: 828,
	hf: { repo: "OpenVINO/whisper-large-v3-turbo-int8-ov", revision: "b568445dd5dc8c695bde596f8acbb4694fd6ba64" },
};

export const SUPERTONIC_SPEC: ModelSpec = {
	name: "supertonic-3",
	kind: "tts",
	approxMB: 401,
	diskMB: 401,
	hf: { repo: "Supertone/supertonic-3", revision: "3cadd1ee6394adea1bd021217a0e650ede09a323", include: ["onnx/", "voice_styles/", "LICENSE"] },
};

export const RUNTIME_SPEC: ModelSpec = { name: "openvino-runtime", kind: "runtime", approxMB: 195, diskMB: 202 };

/** What each voice part needs on disk. The engine is shared. */
export const PART_SPECS = { understand: [RUNTIME_SPEC, WHISPER_SPEC], reply: [RUNTIME_SPEC, SUPERTONIC_SPEC] } as const;
export const KNOWN_SPECS: readonly ModelSpec[] = [RUNTIME_SPEC, WHISPER_SPEC, SUPERTONIC_SPEC];


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
	/** One per running download, to cancel it. */
	private readonly cancels = new Map<string, AbortController>();

	constructor(
		private readonly root: string,
		private readonly onProgress?: ProgressListener,
		/** Hugging Face's address (a local server in tests). */
		private readonly hfBase = HF,
	) {}

	dir(spec: ModelSpec): string {
		return join(this.root, spec.name);
	}

	isInstalled(spec: ModelSpec): boolean {
		return existsSync(join(this.dir(spec), DONE_MARKER));
	}

	/** Downloads and unpacks unless it's already there. Concurrent calls share one download. */
	ensure(spec: ModelSpec): Promise<string> {
		if (isRemoved()) return Promise.reject(new Error("the WhatsApp extension's files were removed"));
		if (this.isInstalled(spec)) return Promise.resolve(this.dir(spec));
		const running = this.inFlight.get(spec.name);
		if (running) return running;
		this.cancels.set(spec.name, new AbortController());
		const job = (spec.kind === "runtime" ? this.installRuntime(spec) : this.install(spec)).finally(() => {
			this.inFlight.delete(spec.name);
			this.cancels.delete(spec.name);
		});
		this.inFlight.set(spec.name, job);
		return job;
	}

	/** Stops all running downloads and waits until they have let go of their files. */
	async cancelDownloads(names?: readonly string[]): Promise<void> {
		const jobs: Array<Promise<string>> = [];
		for (const [name, job] of this.inFlight) {
			if (names && !names.includes(name)) continue;
			this.cancels.get(name)?.abort();
			jobs.push(job);
		}
		await Promise.allSettled(jobs);
	}

	/**
	 * Deletes everything in the models folder except the `keep` folders and the
	 * unfinished downloads of `resume` (which continue later): folders from older
	 * versions, and partial downloads nothing needs. Returns the names deleted.
	 */
	removeLeftovers(keep: readonly string[], resume: readonly string[]): string[] {
		if (!existsSync(this.root)) return [];
		const removed: string[] = [];
		for (const name of readdirSync(this.root)) {
			if (keep.includes(name) || resume.some((kept) => name === `.${kept}.downloading`)) continue;
			if (this.inFlight.has(name.replace(/^\.(.+)\.downloading$/, "$1"))) continue;
			rmSync(join(this.root, name), { recursive: true, force: true });
			removed.push(name);
		}
		return removed;
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
		rmSync(this.staging(spec), { recursive: true, force: true });
	}

	/** Where a download is collected; kept after a failure so the next try continues it. */
	private staging(spec: ModelSpec): string {
		return join(this.root, `.${spec.name}.downloading`);
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
		const staging = this.staging(spec);
		log.info(`downloading ${spec.hf.repo}@${spec.hf.revision.slice(0, 8)}`);
		this.onProgress?.(spec, 0);
		try {
			mkdirSync(staging, { recursive: true });
			const files = await listRepoFiles(this.hfBase, spec.hf.repo, spec.hf.revision, spec.hf.include);
			const total = files.reduce((sum, file) => sum + file.size, 0);
			let done = 0;
			for (const file of files) {
				const target = join(staging, file.path);
				mkdirSync(dirname(target), { recursive: true });
				// Files finished by an earlier, interrupted download are kept.
				if (!(await isComplete(target, file))) {
					await this.fetchTo(spec, `${this.hfBase}/${spec.hf.repo}/resolve/${spec.hf.revision}/${file.path}`, target, (bytes) => {
						if (total > 0) this.onProgress?.(spec, (done + bytes) / total);
					});
					if (!(await isComplete(target, file))) {
						rmSync(target, { force: true });
						throw new Error(`${file.path} of ${spec.name} failed its checksum`);
					}
				}
				done += file.size;
			}
			const target = this.dir(spec);
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
			writeFileSync(join(target, DONE_MARKER), new Date().toISOString());
			log.info(`installed ${spec.name}`);
			return target;
		} finally {
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

	/** Downloads `url` to `target`; when the connection drops, tries again and continues where it stopped. */
	private async fetchTo(spec: ModelSpec, url: string, target: string, onBytes: (bytes: number) => void): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await this.fetchOnce(spec, url, target, onBytes);
				return;
			} catch (error) {
				if (this.cancels.get(spec.name)?.signal.aborted) throw new Error(`download of ${spec.name} cancelled`);
				if ((error as { permanent?: boolean }).permanent || attempt >= DOWNLOAD_ATTEMPTS) throw error;
				log.warn(`download of ${spec.name} interrupted, trying again (${attempt}/${DOWNLOAD_ATTEMPTS - 1})`, error);
				await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
			}
		}
	}

	private async fetchOnce(spec: ModelSpec, url: string, target: string, onBytes: (bytes: number) => void): Promise<void> {
		const have = existsSync(target) ? statSync(target).size : 0;
		const abort = new AbortController();
		let stall: ReturnType<typeof setTimeout> | undefined;
		const watch = () => {
			clearTimeout(stall);
			stall = setTimeout(() => abort.abort(), STALL_MS);
		};
		watch();
		try {
			const response = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.any([abort.signal, ...(this.cancels.has(spec.name) ? [this.cancels.get(spec.name)!.signal] : [])]),
				...(have > 0 ? { headers: { Range: `bytes=${have}-` } } : {}),
			});
			if (response.status === 416) {
				// The partial file doesn't fit the server's file: start it over.
				rmSync(target, { force: true });
				throw new Error(`download of ${spec.name} has to start over`);
			}
			if (!response.ok || !response.body) {
				const error = new Error(`download failed (${response.status}) for ${spec.name}`);
				// Missing or forbidden won't change by trying again.
				if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
					Object.assign(error, { permanent: true });
				}
				throw error;
			}
			// 206: the server continues the partial file; 200: it sends the whole file again.
			const start = response.status === 206 ? have : 0;
			const length = Number(response.headers.get("content-length") ?? 0);
			const expected = length > 0 ? start + length : 0;
			let received = start;
			let lastReport = 0;
			const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
			body.on("data", (chunk: Buffer) => {
				watch();
				received += chunk.length;
				const now = Date.now();
				if (now - lastReport > 1000) {
					lastReport = now;
					onBytes(received);
				}
			});
			await pipeline(body, createWriteStream(target, { flags: start > 0 ? "a" : "w" }));
			if (expected > 0 && received !== expected) throw new Error(`download of ${spec.name} was incomplete`);
			onBytes(received);
		} catch (error) {
			if (abort.signal.aborted) throw new Error(`download of ${spec.name} stalled (no data for ${STALL_MS / 1000} s)`);
			throw error;
		} finally {
			clearTimeout(stall);
		}
	}
}

/** Files of a Hugging Face repo at a commit, optionally only those under the given prefixes. */
async function listRepoFiles(base: string, repo: string, revision: string, include?: string[]): Promise<RepoFile[]> {
	const response = await fetch(`${base}/api/models/${repo}/tree/${revision}?recursive=true`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`could not list ${repo} (${response.status})`);
	const entries = (await response.json()) as Array<{ type: string; path: string; size?: number; lfs?: { size?: number; oid?: string } }>;
	return entries
		.filter((entry) => entry.type === "file" && !entry.path.startsWith(".") && entry.path !== "README.md")
		.filter((entry) => !include || include.some((prefix) => entry.path.startsWith(prefix)))
		.map((entry) => ({
			path: entry.path,
			size: entry.lfs?.size ?? entry.size ?? 0,
			...(entry.lfs?.oid && /^[0-9a-f]{64}$/.test(entry.lfs.oid) ? { sha256: entry.lfs.oid } : {}),
		}));
}

/** The file is there in full, and matches its published checksum when there is one. */
async function isComplete(path: string, file: RepoFile): Promise<boolean> {
	if (!existsSync(path) || statSync(path).size !== file.size) return false;
	return !file.sha256 || (await fileHash(path, "sha256", "hex")) === file.sha256;
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
		// Symlinks (e.g. libopenvino.so → libopenvino.so.2026.4.1) take no space of their own.
		if (entry.isDirectory()) total += folderSize(full);
		else if (entry.isFile()) total += lstatSync(full).size;
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
