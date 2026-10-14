import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAccess, parseMessage, SeenIds } from "../src/wa/inbound.ts";
import { ConnectionLock } from "../src/wa/lock.ts";
import { backoffDelay, CODES, decideOnClose, MAX_DELAY_MS } from "../src/wa/reconnect.ts";
import { RecentsStore } from "../src/wa/recents.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phw-wa-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ConnectionLock", () => {
	it("lets one process hold it and reports the holder to others", () => {
		const file = join(dir, "lock");
		const mine = new ConnectionLock(file, process.pid);
		expect(mine.acquire()).toEqual({ ok: true });
		// Another live process (pid 1 always exists) trying to take it:
		const other = new ConnectionLock(file, 1);
		const result = other.acquire();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.holder.pid).toBe(process.pid);
		mine.release();
		expect(other.acquire()).toEqual({ ok: true });
	});

	it("takes over a lock left behind by a dead process", () => {
		const file = join(dir, "lock");
		writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), since: 1 }));
		expect(new ConnectionLock(file).acquire()).toEqual({ ok: true });
	});

	it("respects a lock from another machine", () => {
		const file = join(dir, "lock");
		writeFileSync(file, JSON.stringify({ pid: 99999999, host: "other-box", since: 1 }));
		expect(new ConnectionLock(file).acquire().ok).toBe(false);
	});
});

describe("decideOnClose", () => {
	const fixed = () => 0.5;
	it("reconnects right away when WhatsApp asks for a restart", () => {
		expect(decideOnClose({ statusCode: CODES.restartRequired, attempt: 3, pairing: true })).toEqual({
			action: "reconnect",
			delayMs: 0,
		});
	});

	it("asks for a new QR when logged out or the session is broken", () => {
		expect(decideOnClose({ statusCode: CODES.loggedOut, attempt: 0, pairing: false }).action).toBe("repair");
		expect(decideOnClose({ statusCode: CODES.badSession, attempt: 0, pairing: false }).action).toBe("repair");
	});

	it("stops when replaced, forbidden, or the QR expired", () => {
		expect(decideOnClose({ statusCode: CODES.connectionReplaced, attempt: 0, pairing: false }).action).toBe("stop");
		expect(decideOnClose({ statusCode: CODES.forbidden, attempt: 0, pairing: false }).action).toBe("stop");
		expect(decideOnClose({ statusCode: CODES.connectionLost, attempt: 0, pairing: true }).action).toBe("stop");
	});

	it("backs off exponentially with a cap", () => {
		expect(decideOnClose({ statusCode: CODES.connectionLost, attempt: 0, pairing: false, random: fixed })).toEqual({
			action: "reconnect",
			delayMs: 5000,
		});
		expect(backoffDelay(2, fixed)).toBe(20_000);
		expect(backoffDelay(20, fixed)).toBe(MAX_DELAY_MS);
		expect(backoffDelay(0, () => 0)).toBe(4000);
		expect(backoffDelay(0, () => 1)).toBe(6000);
	});
});

const message = (overrides: Partial<WAMessage> & { message?: WAMessage["message"] }): WAMessage =>
	({
		key: { id: "ID1", remoteJid: "905551234567@s.whatsapp.net", fromMe: false },
		messageTimestamp: 1_700_000_000,
		pushName: "Alex",
		message: { conversation: "hello" },
		...overrides,
	}) as WAMessage;

describe("parseMessage", () => {
	it("reads plain and extended text", () => {
		expect(parseMessage(message({}))).toMatchObject({ kind: "text", text: "hello", timestamp: 1_700_000_000_000 });
		const quoted = parseMessage(
			message({
				message: {
					extendedTextMessage: { text: "yes", contextInfo: { quotedMessage: { conversation: "do it?" } } },
				},
			}),
		);
		expect(quoted).toMatchObject({ kind: "text", text: "yes", quotedText: "do it?" });
	});

	it("unwraps ephemeral messages and reads media", () => {
		const image = parseMessage(
			message({ message: { ephemeralMessage: { message: { imageMessage: { caption: "look", mimetype: "image/png" } } } } }),
		);
		expect(image).toMatchObject({ kind: "image", text: "look", mimeType: "image/png" });
		const audio = parseMessage(message({ message: { audioMessage: { seconds: 7, mimetype: "audio/ogg; codecs=opus" } } }));
		expect(audio).toMatchObject({ kind: "audio", seconds: 7 });
	});

	it("ignores reactions, protocol messages, status and missing ids", () => {
		expect(parseMessage(message({ message: { reactionMessage: { text: "👍" } } }))).toBeUndefined();
		expect(parseMessage(message({ message: { protocolMessage: {} } }))).toBeUndefined();
		expect(parseMessage(message({ key: { id: "x", remoteJid: "status@broadcast" } }))).toBeUndefined();
		expect(parseMessage(message({ key: { remoteJid: "905551234567@s.whatsapp.net" } }))).toBeUndefined();
	});

	it("uses the participant as sender in groups", () => {
		const parsed = parseMessage(
			message({
				key: {
					id: "G1",
					remoteJid: "120363000000000001@g.us",
					participant: "100000000000001:4@lid",
					participantAlt: "905551234567@s.whatsapp.net",
				},
			}),
		);
		expect(parsed).toMatchObject({
			isGroup: true,
			senderJid: "100000000000001@lid",
			senderAltJid: "905551234567@s.whatsapp.net",
		});
	});
});

describe("checkAccess", () => {
	const owner = { id: "905551234567", name: "Alex", owner: true };
	const friend = { id: "4155551212", lid: "111222333" };
	const group = { id: "120363000000000001@g.us", name: "Team" };
	const self = { phone: "905550000000", lid: "999888777" };
	const parse = (overrides: Partial<WAMessage>) => parseMessage(message(overrides))!;

	it("allows listed people by phone and learns their LID", () => {
		const access = checkAccess(
			parse({ key: { id: "1", remoteJid: "100000000000001@lid", remoteJidAlt: "905551234567@s.whatsapp.net" } }),
			[owner],
			self,
		);
		expect(access).toMatchObject({ allowed: true, isOwner: true, learnedLid: { contactId: "905551234567", lid: "100000000000001" } });
	});

	it("allows by a remembered LID without a phone number", () => {
		const access = checkAccess(parse({ key: { id: "2", remoteJid: "111222333@lid" } }), [owner, friend], self);
		expect(access).toMatchObject({ allowed: true, isOwner: false });
		expect(access.learnedLid).toBeUndefined();
	});

	it("refuses strangers and unknown groups", () => {
		expect(checkAccess(parse({ key: { id: "3", remoteJid: "4477001122@s.whatsapp.net" } }), [owner], self).allowed).toBe(false);
		expect(
			checkAccess(parse({ key: { id: "4", remoteJid: "1203@g.us", participant: "905551234567@s.whatsapp.net" } }), [owner], self)
				.allowed,
		).toBe(false);
	});

	it("allows any member of an allowed group, owner flag by sender", () => {
		const access = checkAccess(
			parse({ key: { id: "5", remoteJid: group.id, participant: "905551234567@s.whatsapp.net" } }),
			[owner, group],
			self,
		);
		expect(access).toMatchObject({ allowed: true, isOwner: true, contact: group });
		const other = checkAccess(parse({ key: { id: "6", remoteJid: group.id, participant: "1234567@s.whatsapp.net" } }), [owner, group], self);
		expect(other).toMatchObject({ allowed: true, isOwner: false });
	});

	it("treats the 'message yourself' chat as the owner and ignores other own messages", () => {
		expect(checkAccess(parse({ key: { id: "7", remoteJid: "905550000000@s.whatsapp.net", fromMe: true } }), [], self)).toMatchObject({
			allowed: true,
			isOwner: true,
		});
		expect(checkAccess(parse({ key: { id: "8", remoteJid: "999888777@lid", fromMe: true } }), [], self).allowed).toBe(true);
		expect(checkAccess(parse({ key: { id: "9", remoteJid: "905551234567@s.whatsapp.net", fromMe: true } }), [owner], self).allowed).toBe(
			false,
		);
	});
});

describe("SeenIds", () => {
	it("reports duplicates and forgets the oldest", () => {
		const seen = new SeenIds(2);
		expect(seen.add("a")).toBe(true);
		expect(seen.add("a")).toBe(false);
		seen.add("b");
		seen.add("c");
		expect(seen.has("a")).toBe(false);
		expect(seen.has("c")).toBe(true);
	});
});

describe("RecentsStore", () => {
	it("lists chats newest first under phone numbers once the LID is known", () => {
		const file = join(dir, "recents.json");
		const store = new RecentsStore(file);
		store.see({ jid: "100000000000001@lid", name: "Alex", at: 2000 });
		store.see({ jid: "4155551212@s.whatsapp.net", at: 1000 });
		expect(store.list().map((chat) => chat.id)).toEqual(["100000000000001", "4155551212"]);
		expect(store.list()[0]?.lid).toBe("100000000000001");

		store.rememberLid("100000000000001@lid", "905551234567@s.whatsapp.net");
		expect(store.list()[0]).toMatchObject({ id: "905551234567", name: "Alex" });
		expect(store.list()[0]?.lid).toBeUndefined();
		store.flush();

		const reloaded = new RecentsStore(file);
		reloaded.load();
		expect(reloaded.list().map((chat) => chat.id)).toEqual(["905551234567", "4155551212"]);
		expect(reloaded.phoneForLid("100000000000001")).toBe("905551234567");
	});

	it("skips status and newsletters", () => {
		const store = new RecentsStore(join(dir, "r.json"));
		store.see({ jid: "status@broadcast", at: 1 });
		store.see({ jid: "123@newsletter", at: 1 });
		expect(store.list()).toEqual([]);
	});
});
