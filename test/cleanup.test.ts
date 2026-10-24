import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cacheKeysFor, cleanNpmCache, installedTree } from "../src/cleanup/npm-cache.ts";
import type { Runner } from "../src/cleanup/run.ts";
import { manualCommand, readSetupRecord, removeItem, type SetupItem } from "../src/cleanup/setup-record.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phw-cleanup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (path: string, name: string, version: string, dependencies: Record<string, string> = {}) => {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package.json"), JSON.stringify({ name, version, dependencies }));
};
const KEY = "make-fetch-happen:request-cache:https://registry.npmjs.org";

describe("npm cache", () => {
	it("finds the installed dependency tree the way Node does", () => {
		const root = join(dir, "node_modules");
		pkg(join(root, "pi-harness-whatsapp"), "pi-harness-whatsapp", "0.1.1", { baileys: "7", franc: "6" });
		pkg(join(root, "baileys"), "baileys", "7.0.0-rc14", { "@hapi/boom": "9" });
		pkg(join(root, "@hapi", "boom"), "@hapi/boom", "9.1.4");
		pkg(join(root, "franc"), "franc", "6.2.0", { "trigram-utils": "2" });
		// A nested copy wins over the hoisted one.
		pkg(join(root, "franc", "node_modules", "trigram-utils"), "trigram-utils", "2.0.1");
		pkg(join(root, "trigram-utils"), "trigram-utils", "1.0.0");
		pkg(join(root, "unrelated"), "unrelated", "1.0.0");
		assert.deepEqual(installedTree(join(root, "pi-harness-whatsapp")).map((entry) => `${entry.name}@${entry.version}`), [
			"pi-harness-whatsapp@0.1.1",
			"baileys@7.0.0-rc14",
			"@hapi/boom@9.1.4",
			"franc@6.2.0",
			"trigram-utils@2.0.1",
		]);
	});

	it("picks only our packages' entries", () => {
		const keys = [
			`${KEY}/pi-harness-whatsapp`,
			`${KEY}/pi-harness-whatsapp/-/pi-harness-whatsapp-0.1.0.tgz`,
			`${KEY}/baileys`,
			`${KEY}/baileys/-/baileys-7.0.0-rc14.tgz`,
			`${KEY}/baileys/-/baileys-6.7.21.tgz`,
			`${KEY}/@hapi%2fboom`,
			`${KEY}/@hapi/boom/-/boom-9.1.4.tgz`,
			`${KEY}/boom`,
			`${KEY}/not-baileys`,
			"something-else:key",
			"pacote:tarball:file:/home/alex/pi-harness-whatsapp",
			"pacote:tarball:file:../pkg/pi-harness-whatsapp-0.1.1.tgz",
			"pacote:tarball:file:/home/alex/pi-harness-whatsapp-fork/x.tgz",
		];
		const packages = [
			{ name: "pi-harness-whatsapp", version: "0.1.1" },
			{ name: "baileys", version: "7.0.0-rc14" },
			{ name: "@hapi/boom", version: "9.1.4" },
		];
		assert.deepEqual(cacheKeysFor(keys, packages), keys.slice(0, 4).concat(keys.slice(5, 7), keys.slice(10, 12)));
	});

	it("deletes our entries, their content and their index files, and keeps what others use", async () => {
		const root = join(dir, "node_modules");
		pkg(join(root, "pi-harness-whatsapp"), "pi-harness-whatsapp", "0.1.1", { franc: "6" });
		pkg(join(root, "franc"), "franc", "6.2.0");
		const cache = join(dir, "npm-cache", "_cacache");
		const integrity = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;
		const content = (text: string) => {
			const hex = createHash("sha512").update(text).digest("hex");
			return join(cache, "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
		};
		const index = (key: string) => {
			const hash = createHash("sha256").update(key).digest("hex");
			return join(cache, "index-v5", hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
		};
		const entry = (key: string, text: string | null) => {
			mkdirSync(join(index(key), ".."), { recursive: true });
			writeFileSync(index(key), `\nabc\t${JSON.stringify({ key, integrity: text === null ? null : integrity(text) })}\n`, { flag: "a" });
			if (text !== null) {
				mkdirSync(join(content(text), ".."), { recursive: true });
				writeFileSync(content(text), text);
			}
		};
		entry(`${KEY}/franc`, "franc metadata");
		entry(`${KEY}/franc/-/franc-6.2.0.tgz`, "shared bytes");
		entry("pacote:tarball:file:/home/alex/pi-harness-whatsapp-0.1.1.tgz", "local copy");
		entry(`${KEY}/other`, "shared bytes");
		entry(`${KEY}/old`, "old bytes");
		entry(`${KEY}/old`, null);

		assert.equal(await cleanNpmCache(join(root, "pi-harness-whatsapp"), async () => ({ code: 0, stdout: "", stderr: "" }), join(dir, "npm-cache")), 3);
		assert.equal(existsSync(index(`${KEY}/franc`)), false);
		assert.equal(existsSync(index(`${KEY}/franc/-/franc-6.2.0.tgz`)), false);
		assert.equal(existsSync(index("pacote:tarball:file:/home/alex/pi-harness-whatsapp-0.1.1.tgz")), false);
		assert.equal(existsSync(content("franc metadata")), false);
		assert.equal(existsSync(content("local copy")), false);
		// Still used by another entry.
		assert.equal(existsSync(content("shared bytes")), true);
		assert.equal(existsSync(index(`${KEY}/other`)), true);
		assert.equal(existsSync(index(`${KEY}/old`)), true);
	});
});

describe("setup.json", () => {
	it("accepts only known package managers and plain package names", () => {
		writeFileSync(
			join(dir, "setup.json"),
			JSON.stringify({
				version: 1,
				installed: [
					{ what: "ffmpeg", manager: "apt", packages: ["ffmpeg", "libavcodec61:amd64", "ffmpeg"], at: "2026-10-15", by: "Claude Code" },
					{ what: "evil", manager: "apt", packages: ["ffmpeg; rm -rf /"] },
					{ what: "evil", manager: "curl", packages: ["x"] },
					{ what: "empty", manager: "apt", packages: [] },
					{ what: "tmux", manager: "brew", packages: ["tmux"] },
				],
			}),
		);
		const items = readSetupRecord(dir);
		assert.deepEqual(items, [
			{ what: "ffmpeg", manager: "apt", packages: ["ffmpeg", "libavcodec61:amd64"], at: "2026-10-15", by: "Claude Code" },
			{ what: "tmux", manager: "brew", packages: ["tmux"] },
		]);
		assert.equal(manualCommand(items[0]!), "sudo apt-get remove --purge ffmpeg libavcodec61:amd64");
		assert.deepEqual(readSetupRecord(join(dir, "missing")), []);
	});
});

describe("removeItem (apt)", () => {
	const item: SetupItem = { what: "sl", manager: "apt", packages: ["sl", "libfoo1"] };
	function fakeApt(options: { dryRun: string; sudo?: boolean; installedAfter?: boolean }) {
		const calls: string[] = [];
		let removed = false;
		const runner: Runner = async (command, args) => {
			calls.push([command, ...args].join(" "));
			if (command === "dpkg-query") {
				const installed = !removed || options.installedAfter;
				return { code: 0, stdout: installed ? "sl\tinstall ok installed\nlibfoo1\tinstall ok installed\n" : "", stderr: "" };
			}
			if (command === "sudo" && args[1] === "true") return { code: options.sudo ? 0 : 1, stdout: "", stderr: "" };
			if (args.includes("-s")) return { code: 0, stdout: options.dryRun, stderr: "" };
			if (args.includes("-y")) removed = true;
			return { code: 0, stdout: "", stderr: "" };
		};
		return { runner, calls };
	}

	it("removes exactly the listed packages, with sudo when it needs no password", async () => {
		const { runner, calls } = fakeApt({ dryRun: "Purg sl [5.02]\nPurg libfoo1:amd64 [1.0]\n", sudo: true });
		assert.deepEqual(await removeItem(item, runner, false), { ok: true, message: "removed sl (2 packages)" });
		assert.ok(calls.includes("sudo -n env DEBIAN_FRONTEND=noninteractive apt-get remove --purge -y sl libfoo1"));
	});

	it("keeps everything when the removal would take other programs with it", async () => {
		const { runner, calls } = fakeApt({ dryRun: "Purg sl [5.02]\nPurg libfoo1 [1.0]\nPurg vlc [3.0]\n" });
		const result = await removeItem(item, runner, true);
		assert.partialDeepStrictEqual(result, { ok: false, message: "kept: removing it would also remove vlc, installed later" });
		assert.equal(calls.some((call) => call.includes(" -y ")), false);
	});

	it("gives the command when it would need a password", async () => {
		const { runner } = fakeApt({ dryRun: "" });
		assert.deepEqual(await removeItem(item, runner, false), {
			ok: false,
			message: "needs your password",
			command: "sudo apt-get remove --purge sl libfoo1",
		});
	});
});
