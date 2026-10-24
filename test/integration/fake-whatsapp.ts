// The real extension, talking to a fake WhatsApp instead of Baileys (see BaileysParts in src/wa/connection.ts).
// Loaded by pi in place of the extension: `pi -ne -e test/integration/fake-whatsapp.ts --whatsapp`.
//
//   - It is "logged in" as FAKE_WA_SELF (no QR) and opens at once. Like Baileys, it keeps the login in creds.json
//     in the auth folder (the extension reads that file to know a phone is linked).
//   - /fakewa {"chat": "...", "text": "...", ...} makes a message arrive, as WhatsApp's messages.upsert would.
//   - Everything sent to WhatsApp (messages, presence, read receipts, logout) is appended to FAKE_WA_LOG as JSON lines.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../../src/index.ts";
import type { BaileysParts } from "../../src/wa/connection.ts";

const SELF = process.env.FAKE_WA_SELF ?? "15550000001";
const SELF_LID = process.env.FAKE_WA_SELF_LID ?? "999000111";
const logFile = process.env.FAKE_WA_LOG;

const record = (entry: Record<string, unknown>) => {
	if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};

type Listener = (payload: unknown) => void;

/** The bits of a Baileys socket the extension uses. */
class FakeSocket {
	readonly user = { id: `${SELF}:7@s.whatsapp.net`, lid: `${SELF_LID}:7@lid`, name: "Me" };
	readonly signalRepository = { lidMapping: { getPNForLID: async () => undefined } };
	private readonly listeners = new Map<string, Set<Listener>>();
	readonly ev = {
		on: (event: string, listener: Listener) => {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set());
			this.listeners.get(event)!.add(listener);
		},
		removeAllListeners: (event: string) => this.listeners.delete(event),
	};

	constructor() {
		setImmediate(() => this.emit("connection.update", { connection: "open" }));
	}

	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}

	async sendMessage(jid: string, content: Record<string, unknown>, options: { messageId?: string } = {}) {
		const id = options.messageId ?? `FAKE${Date.now()}`;
		record({ type: "sent", jid, id, content });
		return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: typeof content.text === "string" ? content.text : "" } };
	}

	async sendPresenceUpdate(type: string, jid: string) {
		record({ type: "presence", jid, presence: type });
	}

	async readMessages(keys: unknown[]) {
		record({ type: "read", keys });
	}

	async groupMetadata(jid: string) {
		return { id: jid, subject: process.env.FAKE_WA_GROUP_NAME ?? "Team" };
	}

	async updateMediaMessage(message: unknown) {
		return message;
	}

	async logout() {
		record({ type: "logout" });
	}

	end() {
		record({ type: "end" });
	}
}

let socket: FakeSocket | undefined;
let messageNumber = 0;

const fake: BaileysParts = {
	makeWASocket: (() => {
		socket = new FakeSocket();
		record({ type: "socket" });
		return socket;
	}) as unknown as BaileysParts["makeWASocket"],
	useMultiFileAuthState: (async (dir: string) => {
		const creds = { me: { id: `${SELF}:7@s.whatsapp.net`, lid: `${SELF_LID}:7@lid` } };
		const file = join(dir, "creds.json");
		mkdirSync(dir, { recursive: true });
		if (!existsSync(file)) writeFileSync(file, JSON.stringify(creds));
		return { state: { creds, keys: {} }, saveCreds: async () => writeFileSync(file, JSON.stringify(creds)) };
	}) as unknown as BaileysParts["useMultiFileAuthState"],
	fetchLatestWaWebVersion: (async () => ({ version: [2, 3000, 1], isLatest: true })) as unknown as BaileysParts["fetchLatestWaWebVersion"],
	makeCacheableSignalKeyStore: ((keys: unknown) => keys) as unknown as BaileysParts["makeCacheableSignalKeyStore"],
	browser: (name) => ["Ubuntu", name, "1"],
	downloadMediaMessage: (async () => Buffer.from("fake media")) as unknown as BaileysParts["downloadMediaMessage"],
	generateMessageIDV2: () => `OUT${++messageNumber}`,
};

interface Incoming {
	/** The chat: digits (a person), digits@g.us (a group), or "self" (the "Message yourself" chat). */
	chat: string;
	text: string;
	/** Sent from this account (the user typing on their phone). */
	fromMe?: boolean;
	/** In a group: who wrote it (digits); "self" for this account. */
	from?: string;
	name?: string;
	/** In a group: @mentions this account. */
	mention?: boolean;
}

function upsert(m: Incoming): void {
	if (!socket) throw new Error("fake WhatsApp isn't connected yet");
	const group = m.chat.endsWith("@g.us");
	const person = (digits: string) => (digits === "self" ? `${SELF}@s.whatsapp.net` : `${digits}@s.whatsapp.net`);
	const remoteJid = group ? m.chat : person(m.chat);
	const id = `IN${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const contextInfo = m.mention ? { mentionedJid: [`${SELF}@s.whatsapp.net`, `${SELF_LID}@lid`] } : undefined;
	const message = contextInfo ? { extendedTextMessage: { text: m.text, contextInfo } } : { conversation: m.text };
	socket.emit("messages.upsert", {
		type: "notify",
		messages: [
			{
				key: { remoteJid, fromMe: !!m.fromMe || m.chat === "self", id, ...(group ? { participant: person(m.from ?? "self") } : {}) },
				message,
				messageTimestamp: Math.floor(Date.now() / 1000),
				...(m.name ? { pushName: m.name } : {}),
			},
		],
	});
	record({ type: "received", id, chat: remoteJid });
}

export default function (pi: ExtensionAPI) {
	createExtension(fake)(pi);
	pi.registerCommand("fakewa", {
		description: "test: a WhatsApp message arrives",
		handler: async (args) => upsert(JSON.parse(args) as Incoming),
	});
}
