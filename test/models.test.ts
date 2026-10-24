import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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

	it("continues an interrupted download where it stopped, and checks the checksum", { timeout: 20_000 }, async () => {
		const hub = fakeHub({ dropFirst: true });
		const store = await start(hub);
		const folder = await store.ensure(SPEC);
		assert.equal(readFileSync(join(folder, "model.bin")).equals(DATA), true);
		assert.equal(hub.ranges[0], "none");
		assert.match(hub.ranges[1], /^bytes=[1-9]\d*-$/);
		assert.equal(store.isInstalled(SPEC), true);
		assert.equal(existsSync(join(folder, "README.md")), false);
	});

	it("cancels a running download and lets go of its files", { timeout: 20_000 }, async () => {
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
		assert.equal(store.isDownloading(SPEC), true);
		const started = Date.now();
		await store.cancelDownloads();
		await assert.rejects(download, /cancelled/);
		assert.ok(Date.now() - started < 2000);
		assert.equal(store.isDownloading(SPEC), false);
		store.remove(SPEC);
		assert.deepEqual(readdirSync(dir), []);
	});

	it("rejects a file whose checksum doesn't match, and doesn't retry a missing file", { timeout: 20_000 }, async () => {
		const bad = await start(fakeHub({ sha: "0".repeat(64) }));
		await assert.rejects(bad.ensure(SPEC), /checksum/);
		assert.equal(bad.isInstalled(SPEC), false);
		server.close();
		const missing = await start(fakeHub({ missing: true }));
		const started = Date.now();
		await assert.rejects(missing.ensure(SPEC), /404/);
		assert.ok(Date.now() - started < 1500);
	});
});
