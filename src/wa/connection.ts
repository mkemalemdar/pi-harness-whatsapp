// The WhatsApp connection: one Baileys socket with saved login, QR pairing,
// automatic reconnects and a single-instance lock. This is the only file that
// talks to Baileys' socket directly, so a Baileys upgrade stays contained.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { makePrivate } from "../paths.ts";
import makeWASocket, {
	type AnyMessageContent,
	Browsers,
	downloadMediaMessage,
	fetchLatestWaWebVersion,
	generateMessageIDV2,
	makeCacheableSignalKeyStore,
	type proto,
	useMultiFileAuthState,
	type WAMessage,
	type WAMessageKey,
	type WASocket,
} from "baileys";
import { createBaileysLogger, createLogger } from "../log.ts";
import { isRemoved } from "../removed.ts";
import { isIgnoredJid, jidUser, normalizeJid } from "./jid.ts";
import { installConsoleGuard } from "./console-guard.ts";
import { ConnectionLock, type LockHolder } from "./lock.ts";
import { decideOnClose } from "./reconnect.ts";

const log = createLogger("connection");
const LOCK_RETRY_MS = 30_000;

export type ConnectionState =
	| { kind: "stopped" }
	| { kind: "connecting"; attempt: number }
	| { kind: "qr"; qr: string }
	| { kind: "open"; phone?: string; name?: string }
	| { kind: "waiting"; delayMs: number; attempt: number; reason: string }
	| { kind: "needs-pairing"; reason: string }
	| { kind: "failed"; reason: string }
	| { kind: "locked"; holder: LockHolder };

export interface HistoryBatch {
	chats: Array<{ id: string; name?: string | null; conversationTimestamp?: unknown }>;
	contacts: Array<{ id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }>;
	lidPnMappings: Array<{ lid: string; pn: string }>;
}

export interface ConnectionEvents {
	onState(state: ConnectionState): void;
	onMessages(messages: WAMessage[], type: string): void;
	onHistory?(batch: HistoryBatch): void;
	onLidMapping?(lid: string, pn: string): void;
}

export interface SendResult {
	id: string;
	key: WAMessageKey;
}

/** Messages we sent, kept briefly so WhatsApp's retry requests can be answered. */
class SentStore {
	private readonly messages = new Map<string, proto.IMessage>();

	add(id: string, message: proto.IMessage | null | undefined): void {
		if (!message) return;
		this.messages.set(id, message);
		if (this.messages.size > 500) {
			const oldest = this.messages.keys().next().value;
			if (oldest !== undefined) this.messages.delete(oldest);
		}
	}

	get(id: string | null | undefined): proto.IMessage | undefined {
		return id ? this.messages.get(id) : undefined;
	}
}

/** True once WhatsApp has assigned this device to an account (set after a QR scan). */
export function isLoggedIn(creds: { me?: { id?: string } | null } | undefined): boolean {
	return !!creds?.me?.id;
}

const errorStatus = (error: unknown): number | undefined =>
	(error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

export class WhatsAppConnection {
	private socket: WASocket | undefined;
	private state: ConnectionState = { kind: "stopped" };
	private readonly lock: ConnectionLock;
	private readonly sent = new SentStore();
	private readonly ownIds = new Set<string>();
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private attempt = 0;
	private generation = 0;
	private wantRunning = false;
	private showedQr = false;
	private version: [number, number, number] | undefined;
	/** Group names already asked from WhatsApp. */
	private readonly groupNames = new Map<string, string>();

	private readonly authDir: string;
	private readonly events: ConnectionEvents;

	constructor(
		authDir: string,
		lockFile: string,
		events: ConnectionEvents,
	) {
		this.authDir = authDir;
		this.events = events;
		this.lock = new ConnectionLock(lockFile);
	}

	getState(): ConnectionState {
		return this.state;
	}

	isOpen(): boolean {
		return this.state.kind === "open" && !!this.socket;
	}

	/** This account's phone and LID digits (for the "message yourself" chat). */
	selfIds(): { phone?: string; lid?: string } {
		const user = this.socket?.user;
		const phone = jidUser(user?.id);
		const lid = jidUser(user?.lid);
		return { ...(phone ? { phone } : {}), ...(lid ? { lid } : {}) };
	}

	/** True for ids of messages this process sent (so their echoes are ignored). */
	isOwnMessage(id: string): boolean {
		return this.ownIds.has(id);
	}

	async start(): Promise<void> {
		// libsignal prints session internals to the console, which breaks Pi's screen.
		installConsoleGuard();
		if (isRemoved()) return;
		this.wantRunning = true;
		if (this.socket || this.reconnectTimer) return;
		const lock = this.lock.acquire();
		if (!lock.ok) {
			this.setState({ kind: "locked", holder: lock.holder });
			// Take over by ourselves once the other Pi lets go.
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = undefined;
				if (this.wantRunning) void this.start();
			}, LOCK_RETRY_MS);
			this.reconnectTimer.unref?.();
			return;
		}
		this.attempt = 0;
		await this.connect();
	}

	async stop(): Promise<void> {
		this.wantRunning = false;
		this.clearTimer();
		this.closeSocket();
		this.lock.release();
		if (this.state.kind !== "stopped") this.setState({ kind: "stopped" });
	}

	/** Unlinks this device on the phone and forgets the saved login. Returns whether WhatsApp confirmed the unlink. */
	async logout(): Promise<boolean> {
		this.wantRunning = false;
		this.clearTimer();
		const socket = this.socket;
		let unlinked = false;
		if (socket && this.state.kind === "open") {
			try {
				await Promise.race([
					socket.logout(),
					new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no answer from WhatsApp")), 10_000).unref?.()),
				]);
				unlinked = true;
			} catch (error) {
				log.warn("logout failed (continuing)", error);
			}
		}
		this.closeSocket();
		this.forgetLogin();
		this.lock.release();
		this.setState({ kind: "stopped" });
		return unlinked;
	}

	/** Another running Pi holds the connection (and uses the saved login). */
	heldElsewhere(): LockHolder | undefined {
		return this.lock.otherHolder();
	}

	/** A login is saved on disk (a QR code was scanned and not logged out since). */
	hasSavedLogin(): boolean {
		try {
			const file = join(this.authDir, "creds.json");
			return existsSync(file) && isLoggedIn(JSON.parse(readFileSync(file, "utf8")) as { me?: { id?: string } });
		} catch {
			return false;
		}
	}

	/**
	 * Unlinks Pi from the phone, connecting first if needed, and forgets the login.
	 * "not-linked": there was no valid login; "failed": WhatsApp couldn't be reached.
	 */
	async unlinkPhone(timeoutMs = 30_000): Promise<"unlinked" | "not-linked" | "failed"> {
		if (!this.hasSavedLogin()) {
			await this.stop();
			this.forgetLogin();
			return "not-linked";
		}
		if (this.state.kind !== "open") {
			await this.stop();
			await this.start();
			const until = Date.now() + timeoutMs;
			const settled = () => ["open", "qr", "needs-pairing", "failed", "locked"].includes(this.state.kind);
			while (!settled() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		const kind = this.state.kind;
		if (kind === "open") return (await this.logout()) ? "unlinked" : "failed";
		// A QR code or "needs pairing": WhatsApp no longer accepts this login, so nothing is linked.
		const result = kind === "qr" || kind === "needs-pairing" ? "not-linked" : "failed";
		await this.stop();
		this.forgetLogin();
		return result;
	}

	/** Forgets the saved login and starts again, which shows a new QR code. */
	async repair(): Promise<void> {
		await this.logout();
		await this.start();
	}

	async send(jid: string, content: AnyMessageContent): Promise<SendResult> {
		const socket = this.socket;
		if (!socket || this.state.kind !== "open") throw new Error("WhatsApp is not connected");
		const messageId = generateMessageIDV2(socket.user?.id);
		this.rememberOwn(messageId);
		const message = await socket.sendMessage(jid, content, { messageId });
		const id = message?.key.id ?? messageId;
		this.rememberOwn(id);
		this.sent.add(id, message?.message);
		return { id, key: message?.key ?? { id, remoteJid: jid, fromMe: true } };
	}

	async presence(jid: string, type: "composing" | "recording" | "paused"): Promise<void> {
		if (!this.isOpen()) return;
		try {
			await this.socket!.sendPresenceUpdate(type, jid);
		} catch (error) {
			log.debug("presence failed", error);
		}
	}

	async markRead(key: WAMessageKey): Promise<void> {
		if (!this.isOpen()) return;
		try {
			await this.socket!.readMessages([key]);
		} catch (error) {
			log.debug("read receipt failed", error);
		}
	}

	async download(message: WAMessage): Promise<Buffer> {
		const socket = this.socket;
		if (!socket) throw new Error("WhatsApp is not connected");
		return (await downloadMediaMessage(
			message,
			"buffer",
			{},
			{ logger: createBaileysLogger("media"), reuploadRequest: socket.updateMediaMessage },
		)) as Buffer;
	}

	/** A group's name, asked from WhatsApp once (it only sends names with the history at pairing). */
	async groupName(jid: string): Promise<string | undefined> {
		const known = this.groupNames.get(jid);
		if (known) return known;
		const socket = this.socket;
		if (!socket || !this.isOpen()) return undefined;
		try {
			const subject = (await socket.groupMetadata(jid)).subject?.trim();
			if (subject) this.groupNames.set(jid, subject);
			return subject || undefined;
		} catch (error) {
			log.debug("group name lookup failed", error);
			return undefined;
		}
	}

	/** Phone JID for a LID JID, if WhatsApp has told us. */
	async phoneForLid(lidJid: string): Promise<string | undefined> {
		try {
			const phone = await this.socket?.signalRepository.lidMapping.getPNForLID(lidJid);
			return phone ? normalizeJid(phone) : undefined;
		} catch {
			return undefined;
		}
	}

	private async connect(): Promise<void> {
		const generation = ++this.generation;
		this.setState({ kind: "connecting", attempt: this.attempt });
		try {
			// The login lets anyone use the account: only this user may open its folder.
			mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
			makePrivate(dirname(this.authDir));
			makePrivate(this.authDir, true);
			const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
			if (generation !== this.generation || !this.wantRunning) return;
			this.version ??= await this.fetchVersion();
			const logger = createBaileysLogger();
			const socket = makeWASocket({
				auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
				logger,
				browser: Browsers.ubuntu("Pi"),
				...(this.version ? { version: this.version } : {}),
				// Keep notifications on the phone; this client never shows "online".
				markOnlineOnConnect: false,
				syncFullHistory: false,
				shouldIgnoreJid: (jid) => isIgnoredJid(jid),
				getMessage: async (key) => this.sent.get(key.id),
			});
			this.socket = socket;
			this.showedQr = false;
			// Not "registered": Baileys only sets that for pairing-code logins, never after a QR scan.
			const loggedIn = isLoggedIn(state.creds);
			let wasOpen = false;

			socket.ev.on("creds.update", saveCreds);
			socket.ev.on("connection.update", (update) => {
				if (generation !== this.generation) return;
				if (update.qr) {
					this.showedQr = true;
					this.setState({ kind: "qr", qr: update.qr });
				}
				if (update.connection === "open") {
					wasOpen = true;
					this.attempt = 0;
					const user = socket.user;
					const phone = jidUser(user?.id);
					this.setState({
						kind: "open",
						...(phone ? { phone } : {}),
						...(user?.name ? { name: user.name } : {}),
					});
				}
				if (update.connection === "close") {
					// Only a socket that never logged in and showed a QR is "waiting for a scan".
					const pairing = !wasOpen && (!loggedIn || this.showedQr);
					this.onClose(errorStatus(update.lastDisconnect?.error), pairing, update.lastDisconnect?.error);
				}
			});
			socket.ev.on("messages.upsert", ({ messages, type }) => {
				if (generation === this.generation) this.events.onMessages(messages, type);
			});
			socket.ev.on("messaging-history.set", ({ chats, contacts, lidPnMappings }) => {
				if (generation !== this.generation) return;
				this.events.onHistory?.({
					chats: chats
						.filter((chat) => !!chat.id)
						.map((chat) => ({ id: chat.id!, name: chat.name, conversationTimestamp: chat.conversationTimestamp })),
					contacts: contacts.map((contact) => ({
						id: contact.id,
						...(contact.lid ? { lid: contact.lid } : {}),
						...(contact.phoneNumber ? { phoneNumber: contact.phoneNumber } : {}),
						...(contact.name ? { name: contact.name } : {}),
						...(contact.notify ? { notify: contact.notify } : {}),
						...(contact.verifiedName ? { verifiedName: contact.verifiedName } : {}),
					})),
					lidPnMappings: lidPnMappings ?? [],
				});
			});
			socket.ev.on("lid-mapping.update", (mapping) => {
				if (generation === this.generation) this.events.onLidMapping?.(mapping.lid, mapping.pn);
			});
		} catch (error) {
			log.error("could not start the WhatsApp socket", error);
			this.onClose(undefined, false, error);
		}
	}

	private onClose(statusCode: number | undefined, pairing: boolean, error: unknown): void {
		this.closeSocket();
		if (!this.wantRunning) return;
		const decision = decideOnClose({ statusCode, attempt: this.attempt, pairing });
		log.info("connection closed", { statusCode, decision, error: error instanceof Error ? error.message : undefined });
		if (decision.action === "reconnect") {
			this.attempt++;
			if (decision.delayMs > 0) {
				this.setState({ kind: "waiting", delayMs: decision.delayMs, attempt: this.attempt, reason: `code ${statusCode ?? "?"}` });
			}
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = undefined;
				if (this.wantRunning) void this.connect();
			}, decision.delayMs);
			return;
		}
		this.wantRunning = false;
		this.lock.release();
		if (decision.action === "repair") {
			this.forgetLogin();
			this.setState({ kind: "needs-pairing", reason: decision.reason });
		} else {
			this.setState({ kind: "failed", reason: decision.reason });
		}
	}

	private async fetchVersion(): Promise<[number, number, number] | undefined> {
		// An outdated client version gets refused; fall back to Baileys' built-in one on any problem.
		try {
			const result = await Promise.race([
				fetchLatestWaWebVersion(),
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000).unref?.()),
			]);
			if (result && !result.error) return result.version;
		} catch {
			// Use the built-in version.
		}
		return undefined;
	}

	private rememberOwn(id: string): void {
		this.ownIds.add(id);
		if (this.ownIds.size > 1000) {
			const oldest = this.ownIds.values().next().value;
			if (oldest !== undefined) this.ownIds.delete(oldest);
		}
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = undefined;
		this.generation++;
		if (!socket) return;
		try {
			socket.ev.removeAllListeners("connection.update");
			socket.ev.removeAllListeners("messages.upsert");
			socket.ev.removeAllListeners("creds.update");
			socket.end(undefined);
		} catch {
			// Already closed.
		}
	}

	private forgetLogin(): void {
		rmSync(this.authDir, { recursive: true, force: true });
	}

	private clearTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private setState(state: ConnectionState): void {
		this.state = state;
		try {
			this.events.onState(state);
		} catch (error) {
			log.error("state listener failed", error);
		}
	}
}
