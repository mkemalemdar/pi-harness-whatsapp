// The connection's basics: the lock (one pi at a time), what to do when it closes, parsing messages, who may talk
// to pi, seen ids, recent chats, the login check and group addressing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "baileys";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addressedToSelf, checkAccess, parseMessage, SeenIds } from "../src/wa/inbound.ts";
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
		assert.deepEqual(mine.acquire(), { ok: true });
		// Another live process (pid 1 always exists) trying to take it:
		const other = new ConnectionLock(file, 1);
		const result = other.acquire();
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.holder.pid, process.pid);
		mine.release();
		assert.deepEqual(other.acquire(), { ok: true });
	});

	it("takes over a lock left behind by a dead process", () => {
		const file = join(dir, "lock");
		writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), since: 1 }));
		assert.deepEqual(new ConnectionLock(file).acquire(), { ok: true });
	});

	it("takes over a lock whose pid now belongs to a newer process", { skip: process.platform !== "linux" && "needs Linux's /proc to read a process's start time" }, () => {
		const file = join(dir, "lock");
		// This test process started long after 1970, so it can't have written this lock.
		const lock = { pid: process.pid, host: hostname(), since: 1000 };
		writeFileSync(file, JSON.stringify(lock));
		assert.deepEqual(new ConnectionLock(file, 2 ** 22 + 1).acquire(), { ok: true });
		// A lock written after the process started is respected.
		writeFileSync(file, JSON.stringify({ ...lock, since: Date.now() }));
		assert.equal(new ConnectionLock(file, 2 ** 22 + 1).acquire().ok, false);
	});

	it("respects a lock from another machine", () => {
		const file = join(dir, "lock");
		writeFileSync(file, JSON.stringify({ pid: 99999999, host: "other-box", since: 1 }));
		assert.equal(new ConnectionLock(file).acquire().ok, false);
	});
});

describe("decideOnClose", () => {
	const fixed = () => 0.5;
	it("reconnects right away when WhatsApp asks for a restart", () => {
		assert.deepEqual(decideOnClose({ statusCode: CODES.restartRequired, attempt: 3, pairing: true }), {
			action: "reconnect",
			delayMs: 0,
		});
	});

	it("asks for a new QR when logged out or the session is broken", () => {
		assert.equal(decideOnClose({ statusCode: CODES.loggedOut, attempt: 0, pairing: false }).action, "repair");
		assert.equal(decideOnClose({ statusCode: CODES.badSession, attempt: 0, pairing: false }).action, "reconnect");
	});

	it("stops when replaced, forbidden, or the QR expired", () => {
		assert.equal(decideOnClose({ statusCode: CODES.connectionReplaced, attempt: 0, pairing: false }).action, "stop");
		assert.equal(decideOnClose({ statusCode: CODES.forbidden, attempt: 0, pairing: false }).action, "stop");
		assert.equal(decideOnClose({ statusCode: CODES.connectionLost, attempt: 0, pairing: true }).action, "stop");
	});

	it("backs off exponentially with a cap", () => {
		assert.deepEqual(decideOnClose({ statusCode: CODES.connectionLost, attempt: 0, pairing: false, random: fixed }), {
			action: "reconnect",
			delayMs: 5000,
		});
		assert.equal(backoffDelay(2, fixed), 20_000);
		assert.equal(backoffDelay(20, fixed), MAX_DELAY_MS);
		assert.equal(backoffDelay(0, () => 0), 4000);
		assert.equal(backoffDelay(0, () => 1), 6000);
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
		assert.partialDeepStrictEqual(parseMessage(message({})), { kind: "text", text: "hello", timestamp: 1_700_000_000_000 });
		const quoted = parseMessage(
			message({
				message: {
					extendedTextMessage: { text: "yes", contextInfo: { quotedMessage: { conversation: "do it?" } } },
				},
			}),
		);
		assert.partialDeepStrictEqual(quoted, { kind: "text", text: "yes", quotedText: "do it?" });
	});

	it("unwraps ephemeral messages and reads media", () => {
		const image = parseMessage(
			message({ message: { ephemeralMessage: { message: { imageMessage: { caption: "look", mimetype: "image/png" } } } } }),
		);
		assert.partialDeepStrictEqual(image, { kind: "image", text: "look", mimeType: "image/png" });
		const audio = parseMessage(message({ message: { audioMessage: { seconds: 7, mimetype: "audio/ogg; codecs=opus" } } }));
		assert.partialDeepStrictEqual(audio, { kind: "audio", seconds: 7 });
	});

	it("ignores reactions, protocol messages, status and missing ids", () => {
		assert.equal(parseMessage(message({ message: { reactionMessage: { text: "👍" } } })), undefined);
		assert.equal(parseMessage(message({ message: { protocolMessage: {} } })), undefined);
		assert.equal(parseMessage(message({ key: { id: "x", remoteJid: "status@broadcast" } })), undefined);
		assert.equal(parseMessage(message({ key: { remoteJid: "905551234567@s.whatsapp.net" } })), undefined);
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
		assert.partialDeepStrictEqual(parsed, {
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
		assert.partialDeepStrictEqual(access, { allowed: true, isOwner: true, learnedLid: { contactId: "905551234567", lid: "100000000000001" } });
	});

	it("allows by a remembered LID without a phone number", () => {
		const access = checkAccess(parse({ key: { id: "2", remoteJid: "111222333@lid" } }), [owner, friend], self);
		assert.partialDeepStrictEqual(access, { allowed: true, isOwner: false });
		assert.equal(access.learnedLid, undefined);
	});

	it("refuses strangers and unknown groups", () => {
		assert.equal(checkAccess(parse({ key: { id: "3", remoteJid: "4477001122@s.whatsapp.net" } }), [owner], self).allowed, false);
		assert.equal(checkAccess(parse({ key: { id: "4", remoteJid: "1203@g.us", participant: "905551234567@s.whatsapp.net" } }), [owner], self)
				.allowed, false);
	});

	it("allows any member of an allowed group, owner flag by sender", () => {
		const access = checkAccess(
			parse({ key: { id: "5", remoteJid: group.id, participant: "905551234567@s.whatsapp.net" } }),
			[owner, group],
			self,
		);
		assert.partialDeepStrictEqual(access, { allowed: true, isOwner: true, contact: group });
		const other = checkAccess(parse({ key: { id: "6", remoteJid: group.id, participant: "1234567@s.whatsapp.net" } }), [owner, group], self);
		assert.partialDeepStrictEqual(other, { allowed: true, isOwner: false });
	});

	it("treats the 'message yourself' chat as the owner and ignores other own messages", () => {
		assert.partialDeepStrictEqual(checkAccess(parse({ key: { id: "7", remoteJid: "905550000000@s.whatsapp.net", fromMe: true } }), [], self), {
			allowed: true,
			isOwner: true,
		});
		assert.equal(checkAccess(parse({ key: { id: "8", remoteJid: "999888777@lid", fromMe: true } }), [], self).allowed, true);
		assert.equal(checkAccess(parse({ key: { id: "9", remoteJid: "905551234567@s.whatsapp.net", fromMe: true } }), [owner], self).allowed, false);
	});
});

describe("SeenIds", () => {
	it("reports duplicates and forgets the oldest", () => {
		const seen = new SeenIds(2);
		assert.equal(seen.add("a"), true);
		assert.equal(seen.add("a"), false);
		seen.add("b");
		seen.add("c");
		assert.equal(seen.has("a"), false);
		assert.equal(seen.has("c"), true);
	});
});

describe("RecentsStore", () => {
	it("lists chats newest first under phone numbers once the LID is known", () => {
		const file = join(dir, "recents.json");
		const store = new RecentsStore(file);
		store.see({ jid: "100000000000001@lid", name: "Alex", at: 2000 });
		store.see({ jid: "4155551212@s.whatsapp.net", at: 1000 });
		assert.deepEqual(store.list().map((chat) => chat.id), ["100000000000001", "4155551212"]);
		assert.equal(store.list()[0]?.lid, "100000000000001");

		store.rememberLid("100000000000001@lid", "905551234567@s.whatsapp.net");
		assert.partialDeepStrictEqual(store.list()[0], { id: "905551234567", name: "Alex" });
		assert.equal(store.list()[0]?.lid, undefined);
		store.flush();

		const reloaded = new RecentsStore(file);
		reloaded.load();
		assert.deepEqual(reloaded.list().map((chat) => chat.id), ["905551234567", "4155551212"]);
		assert.equal(reloaded.phoneForLid("100000000000001"), "905551234567");
	});

	it("skips status and newsletters", () => {
		const store = new RecentsStore(join(dir, "r.json"));
		store.see({ jid: "status@broadcast", at: 1 });
		store.see({ jid: "123@newsletter", at: 1 });
		assert.equal(store.list().length, 0);
	});
});

describe("isLoggedIn", () => {
	it("counts a QR login (me set, registered false) as logged in", async () => {
		const { isLoggedIn } = await import("../src/wa/connection.ts");
		assert.equal(isLoggedIn({ me: { id: "905550000000:12@s.whatsapp.net" } }), true);
		assert.equal(isLoggedIn({ me: undefined }), false);
		assert.equal(isLoggedIn(undefined), false);
	});

	it("a normal drop after being connected reconnects instead of stopping", () => {
		// What onClose now passes for a socket that was open: pairing = false.
		assert.deepEqual(decideOnClose({ statusCode: CODES.connectionClosed, attempt: 0, pairing: false, random: () => 0.5 }), {
			action: "reconnect",
			delayMs: 5000,
		});
	});
});

describe("group addressing", () => {
	const self = { phone: "905550000000", lid: "100000000000001" };
	const parse = (message: object, contextInfo: object) =>
		parseMessage({
			key: { id: "M1", remoteJid: "120363000000000001@g.us", participant: "905551234567@s.whatsapp.net", fromMe: false },
			messageTimestamp: 1,
			message: { ...message, ...Object.fromEntries(Object.entries(message).map(([k, v]) => [k, { ...(v as object), contextInfo }])) },
		} as never)!;

	it("finds an @mention in an image caption, by phone or hidden id", () => {
		const byPhone = parse({ imageMessage: { caption: "@Pi bu ne?" } }, { mentionedJid: ["905550000000@s.whatsapp.net"] });
		assert.equal(byPhone.kind, "image");
		assert.deepEqual(addressedToSelf(byPhone, self, () => false), { mentioned: true, repliedTo: false });
		const byLid = parse({ extendedTextMessage: { text: "@Pi?" } }, { mentionedJid: ["100000000000001@lid"] });
		assert.equal(addressedToSelf(byLid, self, () => false).mentioned, true);
	});

	it("knows a reply to Pi, by author or by a message id Pi sent", () => {
		const byAuthor = parse({ extendedTextMessage: { text: "ok" } }, { stanzaId: "X", participant: "905550000000@s.whatsapp.net" });
		assert.equal(addressedToSelf(byAuthor, self, () => false).repliedTo, true);
		const byId = parse({ extendedTextMessage: { text: "ok" } }, { stanzaId: "SENT1", participant: "someone@lid" });
		assert.equal(addressedToSelf(byId, self, (id) => id === "SENT1").repliedTo, true);
		const other = parse({ extendedTextMessage: { text: "ok" } }, { stanzaId: "Y", participant: "4477001122@s.whatsapp.net" });
		assert.deepEqual(addressedToSelf(other, self, () => false), { mentioned: false, repliedTo: false });
	});

	it("keeps the replied-to image so it can be downloaded", () => {
		const reply = parse({ extendedTextMessage: { text: "@Pi bu ne?" } }, { stanzaId: "IMG", participant: "4477001122@s.whatsapp.net", quotedMessage: { imageMessage: { mimetype: "image/png" } } });
		assert.deepEqual(reply.quotedImage, { mimetype: "image/png" });
		assert.equal(reply.quotedId, "IMG");
	});
});
