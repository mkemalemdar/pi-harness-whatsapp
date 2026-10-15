import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModelSpec, ModelStore } from "../src/voice/models.ts";

const DATA = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
const SHA = createHash("sha256").update(DATA).digest("hex");
const SPEC: ModelSpec = { name: "tiny", kind: "tts", approxMB: 1, diskMB: 1, hf: { repo: "x/tiny", revision: "abc", include: ["model.bin"] } };

/** A fake Hugging Face: the first download drops halfway; later ones honour Range. */
function fakeHub(options: { sha?: string; dropFirst?: boolean; missing?: boolean }) {
	const ranges: string[] = [];
	let downloads = 0;
	const server = createServer((request, response) => {
		if (request.url?.startsWith("/api/models/")) {
			response.end(JSON.stringify([
				{ type: "file", path: "model.bin", size: DATA.length, lfs: { size: DATA.length, oid: options.sha ?? SHA } },
				{ type: "file", path: "README.md", size: 3 },
			]));
			return;
		}
		if (options.missing) {
			response.statusCode = 404;
			response.end();
			return;
		}
		downloads++;
		const range = /bytes=(\d+)-/.exec(request.headers.range ?? "");
		ranges.push(request.headers.range ?? "none");
		const start = range ? Number(range[1]) : 0;
		response.writeHead(range ? 206 : 200, { "content-length": String(DATA.length - start) });
		if (options.dropFirst && downloads === 1) {
			response.write(DATA.subarray(0, 80_000));
			setTimeout(() => response.destroy(), 20);
			return;
		}
		response.end(DATA.subarray(start));
	});
	return { server, ranges };
}

describe("ModelStore downloads", () => {
	let dir: string;
	let server: Server;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-models-"));
	});
	afterEach(() => {
		server?.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const start = async (hub: ReturnType<typeof fakeHub>) => {
		server = hub.server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return new ModelStore(dir, undefined, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	};

	it("continues an interrupted download where it stopped, and checks the checksum", async () => {
		const hub = fakeHub({ dropFirst: true });
		const store = await start(hub);
		const folder = await store.ensure(SPEC);
		expect(readFileSync(join(folder, "model.bin")).equals(DATA)).toBe(true);
		expect(hub.ranges[0]).toBe("none");
		expect(hub.ranges[1]).toMatch(/^bytes=[1-9]\d*-$/);
		expect(store.isInstalled(SPEC)).toBe(true);
		expect(existsSync(join(folder, "README.md"))).toBe(false);
	}, 20_000);

	it("cancels a running download and lets go of its files", async () => {
		const hub = fakeHub({});
		// Answer the file request slowly, a few bytes at a time.
		hub.server.removeAllListeners("request");
		hub.server.on("request", (request, response) => {
			if (request.url?.startsWith("/api/models/")) {
				response.end(JSON.stringify([{ type: "file", path: "model.bin", size: DATA.length }]));
				return;
			}
			response.writeHead(200, { "content-length": String(DATA.length) });
			const timer = setInterval(() => response.write(DATA.subarray(0, 10)), 50);
			response.on("close", () => clearInterval(timer));
		});
		const store = await start(hub);
		const download = store.ensure(SPEC);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(store.isDownloading(SPEC)).toBe(true);
		const started = Date.now();
		await store.cancelDownloads();
		await expect(download).rejects.toThrow(/cancelled/);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(store.isDownloading(SPEC)).toBe(false);
		store.remove(SPEC);
		expect(readdirSync(dir)).toEqual([]);
	}, 20_000);

	it("rejects a file whose checksum doesn't match, and doesn't retry a missing file", async () => {
		const bad = await start(fakeHub({ sha: "0".repeat(64) }));
		await expect(bad.ensure(SPEC)).rejects.toThrow(/checksum/);
		expect(bad.isInstalled(SPEC)).toBe(false);
		server.close();
		const missing = await start(fakeHub({ missing: true }));
		const started = Date.now();
		await expect(missing.ensure(SPEC)).rejects.toThrow(/404/);
		expect(Date.now() - started).toBeLessThan(1500);
	}, 20_000);
});
