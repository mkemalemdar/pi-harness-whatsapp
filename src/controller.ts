// Owns the extension's state for the current session: settings, the
// per-session on/off state, the WhatsApp connection, the footer status and
// the QR widget. src/index.ts only wires Pi events to this class.

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanNpmCache } from "./cleanup/npm-cache.ts";
import { describeItem, readSetupRecord, removeItem, type SetupItem } from "./cleanup/setup-record.ts";
import { Bridge } from "./bridge.ts";
import { CommandRouter } from "./commands/router.ts";
import type { CommandEnv } from "./commands/types.ts";
import { contactsFlow, type RecentChat } from "./contacts-flow.ts";
import { createLogger, logFilePath } from "./log.ts";
import { cleanInbox, Media } from "./media.ts";
import type { SpeechInfo } from "./panel-model.ts";
import { getLanguage } from "./languages.ts";
import { type ConnectionCommand, type PanelHost, showPanel } from "./panel.ts";
import { dataDir, makePrivate, paths, removeDataDir } from "./paths.ts";
import { isRemoved, markRemoved } from "./removed.ts";
import { detectService } from "./commands/power.ts";
import {
	type GlobalSettings,
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
import { KNOWN_SPECS, type ModelSpec, RUNTIME_SPEC, SUPERTONIC_SPEC, WHISPER_SPEC } from "./voice/models.ts";
import { VoiceService } from "./voice/service.ts";

export const STATUS_KEY = "whatsapp";
/** Hidden argument of /whatsapp; dispatching it gives a real command context for ctx.newSession(). */
export const NEW_SESSION_ARG = "__new-session";
const QR_WIDGET_KEY = "whatsapp-qr";
const UNINSTALL_HINT = "quit Pi and run `pi uninstall npm:pi-harness-whatsapp` (or the source `pi list` shows).";
const REMOVED_STATUS = "WA: removed · quit Pi and run pi uninstall npm:pi-harness-whatsapp";
const log = createLogger("controller");

/** Renders a QR code as terminal lines. */
function qrLines(qr: string): string[] {
	let output = "";
	qrcode.generate(qr, { small: true }, (rendered) => {
		output = rendered;
	});
	return output.split("\n").filter((line) => line.length > 0);
}

/** This extension's own folder (where its package.json is). */
function packageRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..");
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
	/** What "Remove everything" uses to clean up outside the data folder (replaced in tests). */
	readonly cleanup = { npmCache: (dir: string) => cleanNpmCache(dir), removeItem: (item: SetupItem) => removeItem(item) };
	private session: SessionState = { enabled: false, autoCompact: true };
	private ctx: ExtensionContext | undefined;
	private lastState: ConnectionState["kind"] = "stopped";

	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
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
		if (isRemoved()) {
			// "Remove everything" ran in this Pi: stay inert until the package is uninstalled.
			this.onToolsChanged?.(false);
			ctx.ui.setStatus(STATUS_KEY, REMOVED_STATUS);
			return;
		}
		// Installs from before 0.1.2 left the data folder (and the login in it) readable by other users.
		makePrivate(dataDir());
		makePrivate(paths.auth(), true);
		let settings = this.settings.load();
		this.recents.load();
		cleanInbox(paths.inbox());
		settings = this.migrateVoice();
		this.voice.removeLeftovers();
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

	/**
	 * Settings from before voice became optional: keep the parts whose files are
	 * already on disk, so an existing setup keeps working. New installs start with voice off.
	 */
	private migrateVoice(): Readonly<GlobalSettings> {
		if (!this.settings.isFromOlderVersion()) return this.settings.get();
		const understand = this.voice.models.isInstalled(WHISPER_SPEC);
		const reply = this.voice.models.isInstalled(SUPERTONIC_SPEC);
		log.info(`voice settings migrated: understand ${understand}, reply ${reply}`);
		return this.settings.update((draft) => {
			draft.voice = { understand, reply };
		});
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
		if (this.session.enabled === on || isRemoved()) return;
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
		if (isRemoved()) {
			ctx.ui.notify(`WhatsApp's files were removed. ${UNINSTALL_HINT}`, "info");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The WhatsApp settings panel needs the interactive terminal.", "error");
			return;
		}
		let focus: string | undefined;
		for (;;) {
			const action = await showPanel(ctx, this, focus);
			this.renderStatus();
			// The QR code appeared: the panel closed so it's visible; don't cover it with dialogs.
			if (action === "qr") return;
			if (action === "remove") {
				await this.removeEverything(ctx);
				return;
			}
			if (action === "contacts") {
				await contactsFlow(ctx, this.settings, () => this.recentChats());
				focus = "contacts";
				continue;
			}
			return;
		}
	}

	/**
	 * "Remove everything", the step before `pi uninstall`: unlinks Pi from the
	 * phone, stops everything, and deletes every file the extension made. After
	 * this, the extension writes nothing more in this Pi process.
	 */
	async removeEverything(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		if (isRemoved()) {
			ctx.ui.notify(`WhatsApp's files were already removed. ${UNINSTALL_HINT}`, "info");
			return;
		}
		const holder = this.connection.heldElsewhere();
		if (holder) {
			ctx.ui.notify(`Another Pi (pid ${holder.pid}) is using WhatsApp. Quit that Pi first, then try again here.`, "error");
			return;
		}
		const dir = dataDir();
		const service = detectService();
		const programs = readSetupRecord(dir);
		const yes = await ctx.ui.confirm(
			"Remove everything?",
			[
				"This can't be undone. It:",
				"• unlinks Pi from your phone (WhatsApp → Linked devices)",
				`• deletes ${dir}: the WhatsApp login, speech files, settings, allowed chats, recent chats, log and received files`,
				"• deletes this extension's copies from npm's download cache",
				...(programs.length > 0 ? ["• then asks about each program that was installed for it"] : []),
				"",
				"Close any other Pi windows first, so they can't write files again.",
				...(service ? [`Pi runs as the systemd service "${service.name}": stop and disable it right after this, or it starts Pi again.`] : []),
				`Afterwards: ${UNINSTALL_HINT}`,
			].join("\n"),
		);
		if (!yes) return;
		// Programs installed just for the extension (recorded in setup.json): ask about each one.
		const toRemove: SetupItem[] = [];
		for (const item of programs) {
			const remove = await ctx.ui.confirm(
				`Also remove ${item.what}?`,
				`It was installed for this extension: ${describeItem(item)}.\nOnly these packages are removed; if something installed later needs them, they're kept.`,
			);
			if (remove) toRemove.push(item);
		}
		ctx.ui.notify("WhatsApp: unlinking from the phone and deleting files…", "info");

		const unlink = await this.connection.unlinkPhone();
		this.queue.close();
		this.bridge.reset();
		await this.connection.stop();
		await this.voice.models.cancelDownloads();
		await this.voice.shutdown();
		// From here on nothing writes files (log, settings, recent chats, login, speech files).
		markRemoved();
		this.session = { enabled: false, autoCompact: true };
		this.onToolsChanged?.(false);
		ctx.ui.setWidget(QR_WIDGET_KEY, undefined);
		const left = removeDataDir(dir);
		ctx.ui.setStatus(STATUS_KEY, REMOVED_STATUS);

		let cacheLine: string;
		try {
			const removed = await this.cleanup.npmCache(packageRoot());
			cacheLine = removed > 0 ? `✓ Removed ${removed} cached download${removed === 1 ? "" : "s"} from npm's cache.` : "✓ Nothing of it in npm's cache.";
		} catch (error) {
			cacheLine = `⚠ Couldn't clean npm's cache (${error instanceof Error ? error.message : String(error)}).`;
		}
		const programLines: string[] = [];
		for (const item of toRemove) {
			ctx.ui.notify(`WhatsApp: removing ${item.what}…`, "info");
			const result = await this.cleanup.removeItem(item);
			programLines.push(result.ok ? `✓ ${result.message[0]!.toUpperCase()}${result.message.slice(1)}.` : `⚠ ${item.what}: ${result.message}. Run: ${result.command}`);
		}
		for (const item of programs.filter((entry) => !toRemove.includes(entry))) programLines.push(`• Kept ${item.what}.`);

		const lines = [
			unlink === "unlinked"
				? "✓ Unlinked from your phone."
				: unlink === "not-linked"
					? "✓ No WhatsApp login was linked."
					: "⚠ Couldn't reach WhatsApp to unlink: on your phone, remove Pi under WhatsApp → Settings → Linked devices.",
			left.length === 0 ? `✓ Deleted ${dir}.` : `⚠ Couldn't delete: ${left.join(", ")}. Quit Pi and delete it by hand.`,
			cacheLine,
			...programLines,
			...(service ? [`Stop the service: systemctl ${service.scope.join(" ")} disable --now ${service.name}`.replace(/\s+/g, " ")] : []),
			`Last step: ${UNINSTALL_HINT}`,
		];
		const warn = left.length > 0 || unlink === "failed" || lines.some((line) => line.startsWith("⚠"));
		ctx.ui.notify(`WhatsApp removed.\n${lines.join("\n")}`, warn ? "warning" : "info");
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
		const installed = new Set(this.voice.models.installedNames());
		const sizesMB: Record<string, number> = {};
		for (const spec of KNOWN_SPECS) if (installed.has(spec.name)) sizesMB[spec.name] = Math.round(this.voice.models.sizeOf(spec) / 1e6);
		return {
			installed,
			downloading: new Set(KNOWN_SPECS.filter((spec) => this.voice.models.isDownloading(spec)).map((spec) => spec.name)),
			sizesMB,
		};
	}

	isInstalled(name: string): boolean {
		return this.voice.models.installedNames().includes(name);
	}

	downloadMissing(): void {
		this.voice.prefetch();
	}

	async removeSpeechFiles(names: readonly string[]): Promise<void> {
		await this.voice.removeFiles(names);
		this.renderStatus();
	}

	async sendVoiceSample(language: string, voiceId: string, onStatus: (text: string) => void): Promise<void> {
		const owner = this.settings.get().contacts.find((contact) => contact.owner);
		if (!owner) throw new Error("No owner set yet: add yourself in Allowed chats first.");
		if (!this.settings.get().voice.reply) throw new Error("Voice replies are off: tick “Reply with voice notes” in Voice notes first.");
		if (!this.session.enabled || !this.connection.isOpen()) throw new Error("WhatsApp isn't connected, so the sample can't be sent.");
		const problem = await this.voice.unavailable();
		if (problem) throw new Error(`Can't make voice notes here: ${problem}.`);
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

	/** Set by src/index.ts: hides or shows the WhatsApp tools. */
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
