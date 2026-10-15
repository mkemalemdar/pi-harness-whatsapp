/**
 * Owns the extension's state for the current session: settings, the
 * per-session on/off state, the WhatsApp connection, the footer status and
 * the QR widget. index.ts only wires Pi events to this class.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Bridge } from "./bridge.ts";
import { CommandRouter } from "./commands/router.ts";
import type { CommandEnv } from "./commands/types.ts";
import { contactsFlow, type RecentChat } from "./contacts-flow.ts";
import { createLogger, logFilePath } from "./log.ts";
import { cleanInbox, Media } from "./media.ts";
import type { SpeechInfo } from "./panel-model.ts";
import { getLanguage } from "./languages.ts";
import { type ConnectionCommand, type PanelHost, type SpeechFile, showPanel } from "./panel.ts";
import { paths } from "./paths.ts";
import {
	restoreSessionState,
	SESSION_ENTRY_TYPE,
	type SessionState,
	SettingsStore,
} from "./settings.ts";
import { type ConnectionState, WhatsAppConnection } from "./wa/connection.ts";
import { contactJid, phoneJid } from "./wa/jid.ts";
import { SendQueue } from "./wa/outbound.ts";
import { PollMenus } from "./wa/polls.ts";
import { RecentsStore } from "./wa/recents.ts";
import { type ModelSpec, RUNTIME_SPEC, SUPERTONIC_SPEC } from "./voice/models.ts";
import { VoiceService } from "./voice/service.ts";

export const STATUS_KEY = "whatsapp";
/** Hidden argument of /whatsapp; dispatching it gives a real command context for ctx.newSession(). */
export const NEW_SESSION_ARG = "__new-session";
const QR_WIDGET_KEY = "whatsapp-qr";
const log = createLogger("controller");

/** Renders a QR code as terminal lines. */
function qrLines(qr: string): string[] {
	let output = "";
	qrcode.generate(qr, { small: true }, (rendered) => {
		output = rendered;
	});
	return output.split("\n").filter((line) => line.length > 0);
}

export class Controller implements PanelHost, CommandEnv {
	readonly settings = new SettingsStore(paths.config());
	readonly recents = new RecentsStore(paths.recents());
	readonly connection: WhatsAppConnection;
	readonly queue: SendQueue;
	readonly bridge: Bridge;
	readonly menus: PollMenus;
	readonly commands: CommandRouter;
	readonly voice: VoiceService;
	private readonly downloads = new Map<string, { spec: ModelSpec; fraction: number }>();
	private session: SessionState = { enabled: false, autoCompact: true };
	private ctx: ExtensionContext | undefined;
	private lastState: ConnectionState["kind"] = "stopped";

	constructor(readonly pi: ExtensionAPI) {
		this.connection = new WhatsAppConnection(paths.auth(), paths.lock(), {
			onState: (state) => this.onConnectionState(state),
			onMessages: (messages, type) => void this.bridge.handleUpsert(messages, type),
			onHistory: (batch) => this.onHistory(batch),
			onLidMapping: (lid, pn) => this.recents.rememberLid(lid, pn),
		});
		this.queue = new SendQueue(this.connection);
		this.menus = new PollMenus(
			{
				sendPoll: async (chatJid, poll) => (await this.queue.enqueue(chatJid, { poll }))?.id,
				sendText: (chatJid, text) => this.queue.sendText(chatJid, text),
			},
			() => {
				const { phone, lid } = this.connection.selfIds();
				return [...(phone ? [phoneJid(phone)] : []), ...(lid ? [`${lid}@lid`] : [])];
			},
		);
		this.commands = new CommandRouter(this);
		this.voice = new VoiceService(this.settings, paths.models(), {
			onDownload: (spec, fraction) => this.onDownload(spec, fraction),
		});
		const media = new Media({
			settings: this.settings,
			connection: this.connection,
			queue: this.queue,
			voice: this.voice,
			inboxDir: paths.inbox(),
		});
		this.bridge = new Bridge({
			pi,
			settings: this.settings,
			connection: this.connection,
			queue: this.queue,
			recents: this.recents,
			getCtx: () => this.ctx,
			commands: this.commands,
			media,
		});
	}

	getCtx(): ExtensionContext | undefined {
		return this.ctx;
	}

	/** Restores this session's state and applies it. */
	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const settings = this.settings.load();
		this.recents.load();
		cleanInbox(paths.inbox());
		const forcedOn = this.pi.getFlag("whatsapp") === true;
		// Only interactive and RPC sessions use WhatsApp unless the flag asks for it.
		const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
		const fallback: SessionState = {
			enabled: interactive && settings.lastEnabled,
			autoCompact: true,
		};
		const restored = restoreSessionState(ctx.sessionManager.getBranch(), fallback);
		if (forcedOn) restored.enabled = true;
		this.session = restored;
		this.renderStatus();
		if (this.session.enabled) await this.applyEnabled(true);
		else this.onToolsChanged?.(false);

		if (settings.askAtSessionStart && ctx.hasUI && event.reason !== "reload") {
			// Let Pi finish starting the session before showing a dialog.
			setTimeout(() => void this.askAtSessionStart(ctx), 0);
		}
	}

	/** After /tree navigation: adopt the state saved on the new branch, if it differs. */
	async onBranchChange(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const restored = restoreSessionState(ctx.sessionManager.getBranch(), this.session);
		const wasEnabled = this.session.enabled;
		this.session = restored;
		if (restored.enabled !== wasEnabled) await this.applyEnabled(restored.enabled);
		this.renderStatus();
	}

	async onSessionShutdown(): Promise<void> {
		await this.applyEnabled(false);
		await this.voice.shutdown();
		this.recents.flush();
		this.ctx = undefined;
	}

	isEnabled(): boolean {
		return this.session.enabled;
	}

	isAutoCompactEnabled(): boolean {
		return this.session.autoCompact;
	}

	/** Turns WhatsApp on or off for this session and remembers it. */
	async setEnabled(on: boolean): Promise<void> {
		if (this.session.enabled === on) return;
		this.session = { ...this.session, enabled: on };
		this.persistSession();
		this.settings.update((draft) => {
			draft.lastEnabled = on;
		});
		await this.applyEnabled(on);
		this.renderStatus();
	}

	setAutoCompact(on: boolean): void {
		this.session = { ...this.session, autoCompact: on };
		this.persistSession();
	}

	connectionLabel(): string {
		if (!this.session.enabled) return "off";
		const state = this.connection.getState();
		switch (state.kind) {
			case "open": {
				const chats = this.settings.get().contacts.length;
				return `connected${state.phone ? ` as +${state.phone}` : ""} · ${chats === 0 ? "no allowed chats" : `${chats} chat${chats === 1 ? "" : "s"}`}`;
			}
			case "qr":
				return "scan the QR code";
			case "connecting":
				return state.attempt > 0 ? `reconnecting (${state.attempt})…` : "connecting…";
			case "waiting":
				return `offline, retrying in ${Math.round(state.delayMs / 1000)}s`;
			case "needs-pairing":
				return "needs a new QR scan";
			case "failed":
				return "stopped (see /whatsapp → Connection)";
			case "locked":
				return `in use by Pi #${state.holder.pid}`;
			case "stopped":
				return "on (not connected)";
		}
	}

	isShowingQr(): boolean {
		return this.session.enabled && this.connection.getState().kind === "qr";
	}

	recentChats(): RecentChat[] {
		return this.recents.list();
	}

	/** /whatsapp: the settings panel; reopened after the "Allowed chats" dialogs. */
	async openSettings(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The WhatsApp settings panel needs the interactive terminal.", "error");
			return;
		}
		const missingBefore = new Set(this.voice.missingModels().map((spec) => spec.name));
		let focus: string | undefined;
		for (;;) {
			const action = await showPanel(ctx, this, focus);
			this.renderStatus();
			// The QR code appeared: the panel closed so it's visible; don't cover it with dialogs.
			if (action === "qr") return;
			if (action === "contacts") {
				await contactsFlow(ctx, this.settings, () => this.recentChats());
				focus = "contacts";
				continue;
			}
			await this.offerDownloads(ctx, missingBefore);
			return;
		}
	}

	/** After the panel closes: if the new choices need files, ask once whether to download them now. */
	private async offerDownloads(ctx: ExtensionContext, missingBefore: ReadonlySet<string>): Promise<void> {
		const needed = this.voice.missingModels().filter((spec) => !missingBefore.has(spec.name) && !this.voice.models.isDownloading(spec));
		if (needed.length === 0) return;
		const megabytes = needed.reduce((sum, spec) => sum + spec.approxMB, 0);
		const choice = await ctx.ui.select(
			`Download speech files? Your settings need: ${needed.map((spec) => this.voice.describe(spec)).join(", ")} (~${megabytes} MB)`,
			["Now", "Later (downloads automatically when first needed)"],
		);
		if (choice === "Now") {
			for (const spec of needed) {
				void this.voice.models.ensure(spec).catch((error) => log.warn(`download of ${spec.name} failed`, error));
			}
		}
	}

	// ── PanelHost: things the panel's submenus do ──────────────────────────

	logFile(): string {
		return logFilePath();
	}

	async connectionCommand(command: ConnectionCommand): Promise<void> {
		if (command === "connect") {
			if (!this.session.enabled) {
				await this.setEnabled(true);
				return;
			}
			await this.connection.stop();
			await this.connection.start();
		} else if (command === "repair") {
			if (!this.session.enabled) await this.setEnabled(true);
			await this.connection.repair();
		} else {
			await this.connection.logout();
		}
		this.renderStatus();
	}

	speechInfo(): SpeechInfo {
		return {
			installed: new Set(this.voice.models.installedNames()),
			missingCount: this.voice.missingModels().length,
			unusedCount: this.voice.unusedModels().length,
			diskMB: Math.round(this.voice.models.diskUsage() / 1e6),
		};
	}

	missingFiles(): SpeechFile[] {
		return this.voice.missingModels().map((spec) => this.voice.file(spec, false));
	}

	unusedFiles(): SpeechFile[] {
		return this.voice.unusedModels().map((spec) => this.voice.file(spec, true));
	}

	isInstalled(name: string): boolean {
		return this.voice.models.installedNames().includes(name);
	}

	downloadMissing(): void {
		this.voice.prefetch();
	}

	deleteFiles(names: readonly string[]): void {
		for (const spec of this.voice.unusedModels()) {
			if (names.includes(spec.name)) this.voice.models.remove(spec);
		}
	}

	async sendVoiceSample(language: string, voiceId: string, onStatus: (text: string) => void): Promise<void> {
		const owner = this.settings.get().contacts.find((contact) => contact.owner);
		if (!owner) throw new Error("No owner set yet: add yourself in Allowed chats first.");
		if (!this.session.enabled || !this.connection.isOpen()) throw new Error("WhatsApp isn't connected, so the sample can't be sent.");
		const missing = [RUNTIME_SPEC, SUPERTONIC_SPEC].filter((spec) => !this.voice.models.isInstalled(spec));
		if (missing.length > 0) onStatus(`Downloading the voices (~${missing.reduce((sum, spec) => sum + spec.approxMB, 0)} MB)…`);
		const note = await this.voice.speakWith(getLanguage(language)?.sample ?? "Hello!", language, voiceId);
		onStatus("Sending the sample…");
		const jid = contactJid(owner);
		const result = await this.queue.enqueue(jid, { audio: note.audio, ptt: true, seconds: note.seconds, mimetype: "audio/ogg; codecs=opus" });
		if (!result) throw new Error("WhatsApp didn't accept the sample (see the log).");
	}

	private async askAtSessionStart(ctx: ExtensionContext): Promise<void> {
		if (this.ctx !== ctx) return;
		const current = this.session.enabled ? "on" : "off";
		const choice = await ctx.ui.select(`WhatsApp for this session? (now ${current})`, ["On", "Off", "Open settings"]);
		if (this.ctx !== ctx || choice === undefined) return;
		if (choice === "Open settings") await this.openSettings(ctx);
		else await this.setEnabled(choice === "On");
	}

	private persistSession(): void {
		this.pi.appendEntry(SESSION_ENTRY_TYPE, { ...this.session });
	}

	/** Starts or stops everything WhatsApp-related. */
	private async applyEnabled(on: boolean): Promise<void> {
		if (on) {
			this.queue.reopen();
			this.bridge.markEnabled();
			await this.connection.start();
		} else {
			this.queue.close();
			this.bridge.reset();
			await this.connection.stop();
			this.ctx?.ui.setWidget(QR_WIDGET_KEY, undefined);
		}
		this.onToolsChanged?.(on);
	}

	/** Set by index.ts: hides or shows the WhatsApp tools. */
	onToolsChanged: ((on: boolean) => void) | undefined;

	private onConnectionState(state: ConnectionState): void {
		const ctx = this.ctx;
		const previous = this.lastState;
		this.lastState = state.kind;
		log.info(`state: ${state.kind}`);
		if (ctx) {
			if (state.kind === "qr") {
				// A component (not a string list) so Pi doesn't cut the QR code to 10 lines.
				const lines = ["WhatsApp → Settings → Linked devices → Link a device, then scan:", ...qrLines(state.qr)];
				ctx.ui.setWidget(QR_WIDGET_KEY, () => ({ render: () => lines, invalidate() {} }));
			} else if (previous === "qr" || state.kind === "open" || state.kind === "stopped") {
				ctx.ui.setWidget(QR_WIDGET_KEY, undefined);
			}
			if (state.kind === "open" && previous !== "open") {
				this.announcePending();
				ctx.ui.notify(`WhatsApp connected${state.phone ? ` as +${state.phone}` : ""}`, "info");
				if (this.settings.get().contacts.length === 0) {
					ctx.ui.notify("Nobody is allowed yet: message this number from your phone and Pi will ask to allow you.", "info");
				}
			} else if (state.kind === "needs-pairing") {
				ctx.ui.notify(`WhatsApp: ${state.reason}. Open /whatsapp → Connection to scan a new QR code.`, "warning");
			} else if (state.kind === "failed") {
				ctx.ui.notify(`WhatsApp stopped: ${state.reason}.`, "error");
			} else if (state.kind === "locked" && previous !== "locked") {
				ctx.ui.notify(
					`WhatsApp is in use by another Pi (pid ${state.holder.pid}). Turn it off there (or /off from WhatsApp) to use it here.`,
					"warning",
				);
			}
		}
		this.renderStatus();
	}

	private onHistory(batch: import("./wa/connection.ts").HistoryBatch): void {
		for (const mapping of batch.lidPnMappings) this.recents.rememberLid(mapping.lid, mapping.pn);
		const names = new Map<string, string>();
		for (const contact of batch.contacts) {
			if (contact.lid && contact.phoneNumber) this.recents.rememberLid(contact.lid, contact.phoneNumber);
			const name = contact.name ?? contact.notify ?? contact.verifiedName;
			if (name) names.set(contact.id, name);
		}
		for (const chat of batch.chats) {
			const seconds = Number(chat.conversationTimestamp ?? 0);
			if (!seconds) continue;
			const name = chat.name ?? names.get(chat.id);
			this.recents.see({ jid: chat.id, at: seconds * 1000, ...(name ? { name } : {}) });
		}
	}

	/**
	 * Leaves a note for the next Pi runtime (after /restart or /new) so it can
	 * tell the chat that asked once WhatsApp is connected again.
	 */
	leaveAnnouncement(chatJid: string, text: string): void {
		try {
			writeFileSync(paths.announceMarker(), JSON.stringify({ chatJid, text, at: Date.now() }), { mode: 0o600 });
		} catch (error) {
			log.warn("could not write the announcement note", error);
		}
	}

	markRestartRequested(chatJid: string): void {
		this.leaveAnnouncement(chatJid, "✅ Pi is back.");
	}

	/** /new from WhatsApp: runs "/whatsapp __new-session", which replaces the session. */
	startNewSession(chatJid: string): void {
		this.leaveAnnouncement(chatJid, "🆕 New session started.");
		this.pi.sendUserMessage(`/whatsapp ${NEW_SESSION_ARG}`, { expandPromptTemplates: true });
	}

	private announcePending(): void {
		const file = paths.announceMarker();
		if (!existsSync(file)) return;
		try {
			const { chatJid, text, at } = JSON.parse(readFileSync(file, "utf8")) as { chatJid?: string; text?: string; at?: number };
			if (chatJid && text && typeof at === "number" && Date.now() - at < 10 * 60_000) void this.queue.sendText(chatJid, text);
		} catch {
			// A broken note is just dropped.
		}
		rmSync(file, { force: true });
	}

	voiceStatus(): string {
		return this.voice.statusLine();
	}

	private onDownload(spec: ModelSpec, fraction: number | undefined): void {
		if (fraction === undefined) {
			this.downloads.delete(spec.name);
			if (this.voice.models.isInstalled(spec)) this.ctx?.ui.notify(`WhatsApp: ${this.voice.describe(spec)} is ready`, "info");
		} else {
			if (!this.downloads.has(spec.name)) this.ctx?.ui.notify(`WhatsApp: downloading ${this.voice.describe(spec)} (~${spec.approxMB} MB)…`, "info");
			this.downloads.set(spec.name, { spec, fraction });
		}
		this.renderStatus();
	}

	private renderStatus(): void {
		const downloads = [...this.downloads.values()];
		const progress =
			downloads.length > 0
				? ` · downloading voice models ${Math.round((downloads.reduce((sum, entry) => sum + entry.fraction, 0) / downloads.length) * 100)}%`
				: "";
		this.ctx?.ui.setStatus(STATUS_KEY, `WA: ${this.connectionLabel()}${progress}`);
	}
}
