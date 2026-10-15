/**
 * Pi ↔ WhatsApp: turns allowed WhatsApp messages into Pi prompts and sends
 * Pi's answers back — automatically, without the model calling a tool.
 *
 * Only runs started (or continued) by a WhatsApp message reply to WhatsApp;
 * prompts typed in the terminal stay in the terminal.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WAMessage } from "baileys";
import { contactLabel } from "./contacts-flow.ts";
import { languageLabel } from "./languages.ts";
import { createLogger } from "./log.ts";
import { formatActivity, formatTouchedFiles, RunReport } from "./run-report.ts";
import { type Contact, MIRROR, type SettingsStore } from "./settings.ts";
import type { WhatsAppConnection } from "./wa/connection.ts";
import { type Access, checkAccess, type InboundMessage, parseMessage, SeenIds, senderIdentity } from "./wa/inbound.ts";
import { isLidJid, jidUser, phoneJid } from "./wa/jid.ts";
import type { SendQueue } from "./wa/outbound.ts";
import type { RecentsStore } from "./wa/recents.ts";

const log = createLogger("bridge");

/** Messages older than this (relative to turning WhatsApp on) are treated as "arrived while off". */
const OFFLINE_GRACE_MS = 120_000;
const TYPING_REFRESH_MS = 15_000;
const ACTIVITY_EDIT_INTERVAL_MS = 2_500;
const ACTIVITY_FALLBACK_INTERVAL_MS = 20_000;
const ACTIVITY_STEPS_SHOWN = 8;

type PromptContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/** What a prompt built from a WhatsApp message carries besides its content. */
export interface PreparedPrompt {
	content: PromptContent;
	/** The user sent a voice note (for "mirror me" voice replies). */
	voice: boolean;
	/** Language Whisper detected in the voice note. */
	language?: string;
}

/** Commands and poll votes (filled in by the commands step). */
export interface CommandHandler {
	/** Returns true when the message was a command and is fully handled. */
	handle(message: InboundMessage, access: Access): Promise<boolean>;
	handleVote(message: InboundMessage, access: Access): Promise<void>;
}

/** Turns media into prompt content and delivers replies (voice, when enabled). */
export interface MediaHandler {
	prepare(message: InboundMessage, header: string): Promise<PreparedPrompt>;
	/** Sends the final reply; may turn it into a voice note. */
	deliverReply(chatJid: string, text: string, context: { voiceIn: boolean; language?: string }): Promise<void>;
}

interface Run {
	chatJid: string;
	report: RunReport;
	voiceIn: boolean;
	language?: string;
	/** Final text of a turn, sent when the run settles (or when another turn follows). */
	pendingFinal?: string;
	lastText?: string;
	activity: {
		key?: import("baileys").WAMessageKey;
		lastEdit: number;
		timer?: ReturnType<typeof setTimeout>;
		failed: boolean;
	};
	typingTimer?: ReturnType<typeof setInterval>;
}

export interface BridgeDeps {
	pi: ExtensionAPI;
	settings: SettingsStore;
	connection: WhatsAppConnection;
	queue: SendQueue;
	recents: RecentsStore;
	getCtx(): ExtensionContext | undefined;
	commands?: CommandHandler;
	media?: MediaHandler;
}

export class Bridge {
	private readonly seen = new SeenIds();
	private run: Run | undefined;
	/** WhatsApp prompts sent to Pi that have not started a run yet. */
	private pending: { chatJid: string; voice: boolean; language?: string } | undefined;
	private enabledAt = Date.now();
	private skippedWhileOff = new Map<string, number>();
	private skippedNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly ignoredNotified = new Set<string>();
	private onboarding = false;

	constructor(private readonly deps: BridgeDeps) {}

	/** Called whenever WhatsApp is turned on. */
	markEnabled(now = Date.now()): void {
		this.enabledAt = now;
		this.skippedWhileOff.clear();
	}

	/** Called when WhatsApp is turned off or the session ends. */
	reset(): void {
		this.finishRun();
		this.pending = undefined;
		if (this.skippedNoticeTimer) clearTimeout(this.skippedNoticeTimer);
		this.skippedNoticeTimer = undefined;
	}

	/** The chat Pi is currently answering, if any. */
	activeChat(): string | undefined {
		return this.run?.chatJid ?? this.pending?.chatJid;
	}

	// ── Inbound ────────────────────────────────────────────────────────────

	async handleUpsert(messages: WAMessage[], type: string): Promise<void> {
		for (const raw of messages) {
			try {
				await this.handleOne(raw, type);
			} catch (error) {
				log.error("failed to handle an incoming message", error);
			}
		}
	}

	private async handleOne(raw: WAMessage, type: string): Promise<void> {
		const message = parseMessage(raw);
		if (!message) return;
		if (!message.fromMe || message.isGroup) {
			this.deps.recents.see({
				jid: message.chatJid,
				...(message.chatAltJid ? { altJid: message.chatAltJid } : {}),
				...(message.pushName && !message.isGroup ? { name: message.pushName } : {}),
				at: message.timestamp,
			});
		}
		// "append" are history/own-device messages; only live ones are handled.
		if (type !== "notify") return;
		if (message.fromMe && this.deps.connection.isOwnMessage(message.id)) return;
		if (!this.seen.add(message.id)) return;

		await this.resolveSenderPhone(message);
		const access = checkAccess(message, this.deps.settings.get().contacts, this.deps.connection.selfIds());
		if (access.learnedLid) this.rememberLid(access.learnedLid.contactId, access.learnedLid.lid);
		const arrivedWhileOff = message.timestamp < this.enabledAt - OFFLINE_GRACE_MS;
		if (!access.allowed) {
			// Old messages from strangers (offline backlog) are dropped without asking anything.
			if (!arrivedWhileOff) await this.onNotAllowed(message, access);
			return;
		}
		if (arrivedWhileOff) {
			this.noteSkipped(message.chatJid);
			return;
		}

		if (message.kind === "poll-vote") {
			await this.deps.commands?.handleVote(message, access);
			return;
		}

		void this.deps.connection.markRead(message.raw.key);
		// Commands, and number replies to menus, never reach the model.
		if (message.kind === "text" && this.deps.commands && (await this.deps.commands.handle(message, access))) return;
		await this.forwardToPi(message, access);
	}

	/** Fills in the phone number for LID-only senders when WhatsApp has told us the mapping. */
	private async resolveSenderPhone(message: InboundMessage): Promise<void> {
		if (message.senderAltJid || !isLidJid(message.senderJid)) return;
		const lid = jidUser(message.senderJid);
		const known = lid ? this.deps.recents.phoneForLid(lid) : undefined;
		const phone = known ? phoneJid(known) : await this.deps.connection.phoneForLid(message.senderJid);
		if (phone) message.senderAltJid = phone;
	}

	private rememberLid(contactId: string, lid: string): void {
		this.deps.settings.update((draft) => {
			const contact = draft.contacts.find((entry) => entry.id === contactId);
			if (contact) contact.lid = lid;
		});
	}

	private async onNotAllowed(message: InboundMessage, access: Access): Promise<void> {
		if (message.fromMe) return;
		const { phone, lid } = senderIdentity(message);
		const who = message.pushName ?? (phone ? `+${phone}` : "someone");
		log.info(`ignored message (${access.reason}) from ${who}`);
		const ctx = this.deps.getCtx();
		if (!ctx) return;

		// First run: nobody is allowed yet, so offer to allow the first person who writes.
		if (this.deps.settings.get().contacts.length === 0 && !message.isGroup && ctx.hasUI && !this.onboarding) {
			this.onboarding = true;
			try {
				const label = phone ? `${who} (+${phone})` : who;
				const yes = await ctx.ui.confirm(
					"Allow this contact?",
					`${label} just messaged Pi on WhatsApp. Allow them and make them the owner (may change Pi's settings from WhatsApp)?`,
				);
				if (yes) {
					const id = phone ?? lid;
					if (!id) return;
					const contact: Contact = { id, owner: true, ...(lid ? { lid } : {}), ...(message.pushName ? { name: message.pushName } : {}) };
					this.deps.settings.update((draft) => {
						draft.contacts.push(contact);
					});
					ctx.ui.notify(`Allowed ${contactLabel(contact)} as owner`, "info");
					await this.forwardToPi(message, { allowed: true, contact, isOwner: true });
				}
			} finally {
				this.onboarding = false;
			}
			return;
		}

		const key = message.isGroup ? message.chatJid : (phone ?? lid ?? who);
		if (!this.ignoredNotified.has(key)) {
			this.ignoredNotified.add(key);
			ctx.ui.notify(
				`WhatsApp: ignored a message from ${message.isGroup ? "a group" : who}. Allow it in /whatsapp → Allowed chats.`,
				"info",
			);
		}
	}

	private noteSkipped(chatJid: string): void {
		this.skippedWhileOff.set(chatJid, (this.skippedWhileOff.get(chatJid) ?? 0) + 1);
		if (this.skippedNoticeTimer) return;
		// WhatsApp delivers offline messages in a burst; report once it settles.
		this.skippedNoticeTimer = setTimeout(() => {
			this.skippedNoticeTimer = undefined;
			const total = [...this.skippedWhileOff.values()].reduce((sum, count) => sum + count, 0);
			if (total === 0) return;
			this.deps.getCtx()?.ui.notify(`WhatsApp: ${total} message${total === 1 ? "" : "s"} arrived while off and ${total === 1 ? "was" : "were"} skipped.`, "info");
			for (const [chat, count] of this.skippedWhileOff) {
				void this.deps.queue.sendText(
					chat,
					`⏸ ${count} message${count === 1 ? "" : "s"} arrived while Pi's WhatsApp was off and ${count === 1 ? "was" : "were"} skipped. Send again if still needed.`,
				);
			}
			this.skippedWhileOff.clear();
		}, 8000);
		this.skippedNoticeTimer.unref?.();
	}

	/** Header the model sees in front of each WhatsApp message. */
	private header(message: InboundMessage, access: Access): string {
		const sender =
			(!message.isGroup && access.contact?.name) ||
			message.pushName ||
			(senderIdentity(message).phone ? `+${senderIdentity(message).phone}` : "WhatsApp user");
		if (message.isGroup) return `[WhatsApp group "${access.contact?.name ?? "group"}" · ${sender}]`;
		return `[WhatsApp · ${sender}]`;
	}

	private async forwardToPi(message: InboundMessage, access: Access): Promise<void> {
		const ctx = this.deps.getCtx();
		if (!ctx) return;
		void this.deps.connection.presence(message.chatJid, "composing");
		const header = this.header(message, access);
		const prepared = this.deps.media
			? await this.deps.media.prepare(message, header)
			: { content: `${header} ${message.text || `(sent ${message.kind})`}`, voice: false };
		// Message text stays out of the log on purpose.
		log.info(`→ Pi: ${message.kind} message from ${header}`);

		if (ctx.isIdle() && !this.run) {
			this.pending = {
				chatJid: message.chatJid,
				voice: prepared.voice,
				...(prepared.language ? { language: prepared.language } : {}),
			};
			this.deps.pi.sendUserMessage(prepared.content as never);
		} else {
			// Pi is busy: queue it; the current run now answers this chat.
			this.adoptRun(message.chatJid, prepared);
			this.deps.pi.sendUserMessage(prepared.content as never, { deliverAs: "followUp" });
		}
	}

	private adoptRun(chatJid: string, prepared: PreparedPrompt): void {
		const ctx = this.deps.getCtx();
		if (!this.run) this.run = this.newRun(chatJid, ctx?.cwd ?? process.cwd());
		this.run.chatJid = chatJid;
		this.run.voiceIn = prepared.voice;
		if (prepared.language) this.run.language = prepared.language;
		this.startTyping();
	}

	// ── Pi events ──────────────────────────────────────────────────────────

	/** Text for the system prompt while WhatsApp is on (kept stable so prompt caching keeps working). */
	systemPromptSection(): string {
		const settings = this.deps.settings.get();
		const language =
			settings.replyLanguage === MIRROR
				? "Reply in the language the user wrote or spoke in."
				: `Always reply in ${languageLabel(settings.replyLanguage)}.`;
		return [
			"Some user messages arrive from WhatsApp; they start with a header like `[WhatsApp · Name]`.",
			"Your final answer to such a message is sent back to WhatsApp automatically — do not use a tool just to reply.",
			"Keep WhatsApp answers short and chat-friendly; long code is better summarized, with files written to disk.",
			"Voice notes arrive already transcribed and tagged like `[voice note · Turkish]`.",
			language,
		].join("\n");
	}

	onAgentStart(): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) return;
		const ctx = this.deps.getCtx();
		this.run = this.newRun(pending.chatJid, ctx?.cwd ?? process.cwd());
		this.run.voiceIn = pending.voice;
		if (pending.language) this.run.language = pending.language;
		this.startTyping();
	}

	onTurnStart(): void {
		const run = this.run;
		if (run?.pendingFinal) {
			// Another turn follows (a queued message): the previous final answer is complete.
			const text = run.pendingFinal;
			run.pendingFinal = undefined;
			void this.deliver(run, text);
		}
	}

	onAssistantMessage(message: { content?: unknown; stopReason?: string; errorMessage?: string }): void {
		const run = this.run;
		if (!run) return;
		const parts = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
		const text = parts
			.filter((part) => part.type === "text" && part.text)
			.map((part) => part.text!)
			.join("\n")
			.trim();
		const hasToolCalls = parts.some((part) => part.type === "toolCall");

		if (message.stopReason === "error" && message.errorMessage) {
			run.lastText = `⚠️ ${message.errorMessage}`;
		}
		if (!text) return;
		run.lastText = text;
		if (hasToolCalls) {
			if (this.deps.settings.get().replies.interim) void this.deps.queue.sendText(run.chatJid, text);
			return;
		}
		run.pendingFinal = text;
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		const run = this.run;
		if (!run) return;
		run.report.toolStarted(toolCallId, toolName, args);
		this.updateActivity(run);
	}

	onToolEnd(toolCallId: string, isError: boolean): void {
		const run = this.run;
		if (!run) return;
		run.report.toolEnded(toolCallId, isError);
		this.updateActivity(run);
	}

	async onSettled(aborted: boolean): Promise<void> {
		const run = this.run;
		if (!run) return;
		this.finishRun();
		const settings = this.deps.settings.get();
		let text = run.pendingFinal ?? (aborted ? undefined : run.lastText);
		if (aborted) text = text ? `${text}\n\n⏹ Stopped.` : "⏹ Stopped.";
		const extras: string[] = [];
		if (settings.replies.touchedFiles) {
			const files = formatTouchedFiles(run.report.touchedFiles());
			if (files) extras.push(files);
		}
		if (settings.replies.summary) extras.push(run.report.summary());
		await this.deliver(run, text ?? "✅ Done.", extras);
	}

	/** Sends images a tool produced (e.g. browser screenshots) to the chat Pi is answering. */
	async forwardImages(content: ReadonlyArray<{ type: string; data?: string; mimeType?: string }>, toolName: string): Promise<void> {
		const run = this.run;
		if (!run) return;
		for (const part of content) {
			if (part.type !== "image" || !part.data) continue;
			const image = Buffer.from(part.data, "base64");
			if (image.length === 0 || image.length > 15 * 1024 * 1024) continue;
			log.info(`forwarding an image from ${toolName}`);
			await this.deps.queue.enqueue(run.chatJid, { image, mimetype: part.mimeType ?? "image/png", caption: `🖼 from ${toolName}` });
		}
	}

	// ── Sending ────────────────────────────────────────────────────────────

	private async deliver(run: Run, text: string, extras: string[] = []): Promise<void> {
		try {
			if (this.deps.media) {
				await this.deps.media.deliverReply(run.chatJid, text, {
					voiceIn: run.voiceIn,
					...(run.language ? { language: run.language } : {}),
				});
			} else {
				await this.deps.queue.sendText(run.chatJid, text);
			}
			// Summary and file list stay text so they are easy to read.
			if (extras.length > 0) await this.deps.queue.sendText(run.chatJid, extras.join("\n\n"));
		} catch (error) {
			log.error("failed to deliver a reply", error);
			this.deps.getCtx()?.ui.notify("WhatsApp: could not send the reply (see log).", "error");
		}
	}

	private updateActivity(run: Run): void {
		if (!this.deps.settings.get().replies.toolActivity) return;
		const activity = run.activity;
		if (activity.timer) return;
		const interval = activity.failed ? ACTIVITY_FALLBACK_INTERVAL_MS : ACTIVITY_EDIT_INTERVAL_MS;
		const wait = Math.max(0, activity.lastEdit + interval - Date.now());
		activity.timer = setTimeout(() => {
			activity.timer = undefined;
			void this.flushActivity(run);
		}, activity.key ? wait : 0);
	}

	private async flushActivity(run: Run): Promise<void> {
		const activity = run.activity;
		const text = formatActivity(run.report.recentSteps(ACTIVITY_STEPS_SHOWN), run.report.toolCount);
		if (!text) return;
		activity.lastEdit = Date.now();
		if (activity.key && !activity.failed) {
			if (await this.deps.queue.edit(run.chatJid, activity.key, text)) return;
			activity.failed = true;
		}
		const result = await this.deps.queue.enqueue(run.chatJid, { text });
		if (result && !activity.failed) activity.key = result.key;
	}

	private newRun(chatJid: string, cwd: string): Run {
		return { chatJid, report: new RunReport(cwd), voiceIn: false, activity: { lastEdit: 0, failed: false } };
	}

	private startTyping(): void {
		const run = this.run;
		if (!run || run.typingTimer) return;
		void this.deps.connection.presence(run.chatJid, "composing");
		run.typingTimer = setInterval(() => {
			if (this.run === run) void this.deps.connection.presence(run.chatJid, "composing");
		}, TYPING_REFRESH_MS);
		run.typingTimer.unref?.();
	}

	private finishRun(): void {
		const run = this.run;
		this.run = undefined;
		if (!run) return;
		if (run.typingTimer) clearInterval(run.typingTimer);
		if (run.activity.timer) {
			clearTimeout(run.activity.timer);
			run.activity.timer = undefined;
			// Show the final state of the tool steps.
			if (this.deps.settings.get().replies.toolActivity) void this.flushActivity(run);
		}
		void this.deps.connection.presence(run.chatJid, "paused");
	}
}
