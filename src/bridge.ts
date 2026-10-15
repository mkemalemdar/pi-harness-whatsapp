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
import { type Access, addressedToSelf, checkAccess, type InboundMessage, parseMessage, SeenIds, senderIdentity } from "./wa/inbound.ts";
import { contactJid, isLidJid, jidUser, phoneJid } from "./wa/jid.ts";
import type { SendQueue } from "./wa/outbound.ts";
import type { RecentsStore } from "./wa/recents.ts";

const log = createLogger("bridge");

/** Messages older than this (relative to turning WhatsApp on) are treated as "arrived while off". */
const OFFLINE_GRACE_MS = 120_000;
const TYPING_REFRESH_MS = 15_000;
const ACTIVITY_EDIT_INTERVAL_MS = 2_500;
const ACTIVITY_FALLBACK_INTERVAL_MS = 20_000;
const ACTIVITY_STEPS_SHOWN = 8;
/** How long a prompt may take to start before the chat is told it didn't (no model, expired login…). */
const START_TIMEOUT_MS = 8_000;
const BUSY_POLL_MS = 500;
/** Group messages not meant for Pi that are kept as context for when it is addressed. */
const GROUP_CONTEXT_MESSAGES = 20;
const CUT_OFF_NOTICE = "⚠️ The model hit its output limit before writing an answer. Try again, or raise the model's output limit.";

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
	/** The text is a known command (e.g. "/status"), not just something starting with "/". */
	isCommand(text: string): boolean;
	handleVote(message: InboundMessage, access: Access): Promise<void>;
}

/** Turns media into prompt content and delivers replies (voice, when enabled). */
export interface MediaHandler {
	/** `header(voiceTag)` builds the label in front of the message; voice notes pass "voice note". */
	prepare(message: InboundMessage, header: (voiceTag?: string) => string): Promise<PreparedPrompt>;
	/** Sends the final reply; may turn it into a voice note. */
	deliverReply(chatJid: string, text: string, context: { voiceIn: boolean; language?: string }): Promise<void>;
}

/** A WhatsApp prompt handed to Pi that hasn't shown up in the conversation yet. */
interface Expected {
	text: string;
	chatJid: string;
	voice: boolean;
	language?: string;
}

interface Run {
	chatJid: string;
	/** False while Pi works on a prompt typed in the terminal: that part stays in the terminal. */
	active: boolean;
	/** The chat already got an answer for its latest prompt. */
	answered: boolean;
	/** "Terminal answers": the prompt was typed in the terminal (a short preview of it). */
	fromTerminal?: string;
	report: RunReport;
	voiceIn: boolean;
	language?: string;
	/** Final text of a turn, sent when the run settles (or when another turn follows). */
	pendingFinal?: string;
	lastText?: string;
	/** `lastText` is an error from the model, not an answer. */
	lastIsError?: boolean;
	/** The model stopped at its output limit before writing any text. */
	cutOff?: boolean;
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

/** Puts a block of text in front of a prompt (before the label of a text part, or as a new text part). */
function prependText(content: PromptContent, prefix: string): PromptContent {
	if (typeof content === "string") return `${prefix}\n${content}`;
	const [first, ...rest] = content;
	if (first?.type === "text") return [{ type: "text", text: `${prefix}\n${first.text}` }, ...rest];
	return [{ type: "text", text: prefix }, ...content];
}

/** The text of a prompt, as Pi stores it in the user message. */
function promptText(content: PromptContent | undefined): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export class Bridge {
	private readonly seen = new SeenIds();
	private run: Run | undefined;
	/** WhatsApp prompts sent to Pi, oldest first, until they appear as user messages. */
	private expected: Expected[] = [];
	/** Pi is in an agent run (between agent_start and agent_settled). */
	private agentActive = false;
	/** Prompts go to Pi one at a time, in the order they arrived. */
	private sendChain: Promise<void> = Promise.resolve();
	/** Per allowed group: recent messages Pi didn't answer (text only, in memory). */
	private readonly groupContext = new Map<string, Array<{ name: string; text: string }>>();
	private readonly groupNameAsked = new Set<string>();
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
		this.expected = [];
		if (this.skippedNoticeTimer) clearTimeout(this.skippedNoticeTimer);
		this.skippedNoticeTimer = undefined;
	}

	/** The chat Pi is currently answering, if any. */
	activeChat(): string | undefined {
		return this.run?.active ? this.run.chatJid : this.expected[0]?.chatJid;
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
		if (message.isGroup && !this.deps.recents.nameOf(message.chatJid)) void this.learnGroupName(message.chatJid, message.timestamp);
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

		if (message.isGroup) {
			// WhatsApp writes a mention as "@<number>"; the model reads "@Pi" better.
			message.text = this.namePi(message.text);
			if (!this.isForPi(message)) {
				// Not meant for Pi: keep it as context for the next time Pi is addressed.
				this.rememberGroupMessage(message);
				return;
			}
		}

		void this.deps.connection.markRead(message.raw.key);
		// Commands, and number replies to menus, never reach the model.
		if (message.kind === "text" && this.deps.commands && (await this.deps.commands.handle(message, access))) return;
		await this.forwardToPi(message, access);
	}

	/** In a group: does this message ask Pi something (per "In groups, answer")? Commands and menu answers always do. */
	private isForPi(message: InboundMessage): boolean {
		const mode = this.deps.settings.get().groupReplies;
		if (mode === "all") return true;
		if (message.kind === "text" && this.deps.commands?.isCommand(message.text)) return true;
		const { mentioned, repliedTo } = addressedToSelf(message, this.deps.connection.selfIds(), (id) => this.deps.connection.isOwnMessage(id));
		// A number replying to one of Pi's menus picks an option, whatever the mode.
		if (repliedTo && /^\s*\d{1,2}\s*$/.test(message.text)) return true;
		return ((mode === "replies" || mode === "both") && repliedTo) || ((mode === "mentions" || mode === "both") && mentioned);
	}

	/** Replaces "@<this account's number or LID>" with "@Pi". */
	private namePi(text: string): string {
		const { phone, lid } = this.deps.connection.selfIds();
		let named = text;
		for (const id of [phone, lid]) if (id) named = named.replaceAll(`@${id}`, "@Pi");
		return named;
	}

	private rememberGroupMessage(message: InboundMessage): void {
		const placeholder: Partial<Record<InboundMessage["kind"], string>> = {
			image: "[sent an image]",
			video: "[sent a video]",
			audio: "[sent a voice note]",
			document: "[sent a file]",
			sticker: "[sent a sticker]",
			other: "[sent a message Pi can't read]",
		};
		// Files never go into the context: only a short note that one was sent, plus its caption.
		const text = [placeholder[message.kind], message.text.trim()].filter(Boolean).join(" ");
		if (!text) return;
		const name = message.pushName ?? (senderIdentity(message).phone ? `+${senderIdentity(message).phone}` : "someone");
		const history = this.groupContext.get(message.chatJid) ?? [];
		history.push({ name, text: text.length > 500 ? `${text.slice(0, 500)}…` : text });
		this.groupContext.set(message.chatJid, history.slice(-GROUP_CONTEXT_MESSAGES));
	}

	/** The group's messages since Pi was last addressed, as a context block (and forgets them). */
	private takeGroupContext(message: InboundMessage, access: Access): string | undefined {
		const history = this.groupContext.get(message.chatJid);
		this.groupContext.delete(message.chatJid);
		if (!history?.length) return undefined;
		const lines = history.map((entry) => `${entry.name}: ${entry.text}`);
		return [`[WhatsApp group "${access.contact?.name ?? "group"}" · earlier messages, for context]`, ...lines].join("\n");
	}

	/** Asks WhatsApp for a group's name, for "Pick from recent chats" and an allowed group without a name. */
	private async learnGroupName(jid: string, at: number): Promise<void> {
		// Once per group: WhatsApp doesn't like many lookups.
		if (this.groupNameAsked.has(jid)) return;
		this.groupNameAsked.add(jid);
		try {
			const name = await this.deps.connection.groupName(jid);
			if (!name) return;
			this.deps.recents.see({ jid, name, at });
			const contact = this.deps.settings.get().contacts.find((entry) => entry.id === jid);
			if (contact && !contact.name) {
				this.deps.settings.update((draft) => {
					const entry = draft.contacts.find((existing) => existing.id === jid);
					if (entry && !entry.name) entry.name = name;
				});
			}
		} catch (error) {
			log.debug("could not learn a group name", error);
		}
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

	/**
	 * The label the model sees in front of each WhatsApp message. It repeats, right
	 * next to the message, who is talking and where the answer goes, so even small
	 * models answer the sender directly:
	 *   [WhatsApp · Alex · your reply goes to Alex]
	 *   [WhatsApp · Alex · voice note · your reply is spoken to Alex]
	 */
	private header(message: InboundMessage, access: Access): (voiceTag?: string) => string {
		const sender =
			(!message.isGroup && access.contact?.name) ||
			message.pushName ||
			(senderIdentity(message).phone ? `+${senderIdentity(message).phone}` : "WhatsApp user");
		const from = message.isGroup ? `WhatsApp group "${access.contact?.name ?? "group"}" · ${sender}` : `WhatsApp · ${sender}`;
		const to = message.isGroup ? "the group" : sender;
		return (voiceTag) => {
			const mode = this.deps.settings.get().voiceMode;
			const spoken = mode === "voice" || mode === "voice+text" || (mode === "mirror" && !!voiceTag);
			return `[${[from, voiceTag, spoken ? `your reply is spoken to ${to}` : `your reply goes to ${to}`].filter(Boolean).join(" · ")}]`;
		};
	}

	private async forwardToPi(message: InboundMessage, access: Access): Promise<void> {
		if (!this.deps.getCtx()) return;
		void this.deps.connection.presence(message.chatJid, "composing");
		const header = this.header(message, access);
		const context = message.isGroup ? this.takeGroupContext(message, access) : undefined;
		// Prepared right away (downloads, transcription), but handed to Pi in the order
		// messages arrived: a text sent after a voice note doesn't overtake it.
		const preparing = (async (): Promise<PreparedPrompt> => {
			const prepared = this.deps.media
				? await this.deps.media.prepare(message, header)
				: { content: `${header()} ${message.text || `(sent ${message.kind})`}`, voice: false };
			if (context) prepared.content = prependText(prepared.content, context);
			return prepared;
		})();
		// Its failure is handled in the chain; this only stops an "unhandled rejection" before then.
		preparing.catch(() => {});
		// Resolves once the prompt is handed to Pi; waiting for it to start happens in the chain.
		await new Promise<void>((sent) => {
			this.sendChain = this.sendChain
				.then(async () => {
					const prepared = await preparing;
					// Message text stays out of the log on purpose.
					log.info(`→ Pi: ${message.kind} message from ${header()}`);
					const entry: Expected = {
						text: promptText(prepared.content),
						chatJid: message.chatJid,
						voice: prepared.voice,
						...(prepared.language ? { language: prepared.language } : {}),
					};
					await this.submit(entry, prepared.content, sent);
				})
				.catch((error) => {
					sent();
					log.error("failed to hand a message to Pi", error);
				});
		});
	}

	/** Hands one prompt to Pi, then waits until it has started so the next one can be queued behind it. */
	private async submit(entry: Expected, content: PromptContent, sent: () => void): Promise<void> {
		// Pi is busy with something that isn't a run (e.g. compacting): prompts are refused then, so wait.
		const ctx = await this.waitUntil(() => {
			const current = this.deps.getCtx();
			return !current || current.isIdle() || this.agentActive;
		}, 15 * 60_000);
		if (!ctx) {
			sent();
			return;
		}
		this.expected.push(entry);
		// While a run is going, this waits for it as a follow-up; otherwise it starts a run.
		this.deps.pi.sendUserMessage(content as never, { deliverAs: "followUp" });
		sent();
		if (this.agentActive) return;
		const started = await this.waitUntil(() => this.agentActive || !this.deps.getCtx()?.isIdle() || !this.expected.includes(entry), START_TIMEOUT_MS);
		if (!started && this.expected.includes(entry)) {
			this.expected = this.expected.filter((other) => other !== entry);
			void this.deps.queue.sendText(entry.chatJid, "⚠️ Pi couldn't start on your message. Check the terminal (model or login problem?).");
		}
	}

	/** Polls until `ready()` is true (returns the context) or the time runs out (returns undefined). */
	private async waitUntil(ready: () => boolean, timeoutMs: number): Promise<ExtensionContext | undefined> {
		const until = Date.now() + timeoutMs;
		while (!ready()) {
			if (Date.now() >= until) return undefined;
			await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS).unref?.());
		}
		return this.deps.getCtx();
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
			"Some user messages come from WhatsApp. They start with a label like `[WhatsApp · Name · your reply goes to Name]`.",
			"- Name is talking to you directly from their phone. Answer Name directly, as \"you\" — don't describe their message to someone else or ask what to reply to them.",
			"- Your final answer is sent to them automatically. Don't use a tool just to reply.",
			"- Keep answers short and chat-friendly. Summarize long code, and write files to disk instead.",
			"- Voice notes arrive already transcribed, e.g. `[WhatsApp · Name · voice note · your reply is spoken to Name]`. Transcripts can contain misheard words.",
			"- When the label says \"your reply is spoken\", your answer becomes voice notes automatically (long answers are split into parts). Write it exactly as it should be said: no symbols, units or abbreviations (\"13 derece\", not \"13°C\"; \"yüzde 40\", not \"%40\"; \"25 kilometers\", not \"25 km\"), and no code, tables, links or emoji.",
			"- Group labels look like `[WhatsApp group \"Team\" · Name · your reply goes to the group]`: answer the group. You only get group messages that mention or reply to you; the ones before it may come first as `earlier messages, for context`. Use them to understand the question, but answer only the last message.",
			`- ${language}`,
		].join("\n");
	}

	onAgentStart(): void {
		this.agentActive = true;
	}

	onTurnStart(): void {
		const run = this.run;
		if (run?.pendingFinal) {
			// Another turn follows (a queued message): the previous final answer is complete.
			const text = run.pendingFinal;
			run.pendingFinal = undefined;
			run.answered = true;
			void this.deliver(run, text);
		}
	}

	/**
	 * A user message entered the conversation. If it's one of ours, the turns that
	 * follow answer that chat; otherwise it was typed in the terminal and its
	 * answer stays there.
	 */
	onUserMessage(message: { content?: unknown }): void {
		const text = promptText(message.content as PromptContent);
		let index = this.expected.findIndex((entry) => entry.text === text);
		// Another extension may have changed the text on the way; the order still tells.
		if (index < 0 && text.startsWith("[WhatsApp") && this.expected.length > 0) index = 0;
		if (index >= 0) {
			const entry = this.expected[index]!;
			this.expected.splice(0, index + 1);
			this.activate(entry.chatJid, entry.voice, entry.language);
			return;
		}
		// Typed in the terminal: sent to the owner only with "Terminal answers" on.
		const owner = this.terminalAnswersTo();
		if (owner) {
			const preview = text.replace(/\s+/g, " ").trim();
			this.activate(owner, false, undefined, preview.length > 100 ? `${preview.slice(0, 100)}…` : preview || "…");
			return;
		}
		const run = this.run;
		if (run?.active) {
			run.active = false;
			this.stopTyping(run);
		}
	}

	/** The owner's chat when "Terminal answers" is on and WhatsApp is connected. */
	private terminalAnswersTo(): string | undefined {
		const settings = this.deps.settings.get();
		if (!settings.replies.terminal || !this.deps.connection.isOpen()) return undefined;
		const owner = settings.contacts.find((contact) => contact.owner);
		return owner ? contactJid(owner) : undefined;
	}

	/** The turns that follow answer `chatJid`. */
	private activate(chatJid: string, voice: boolean, language: string | undefined, fromTerminal?: string): void {
		const cwd = this.deps.getCtx()?.cwd ?? process.cwd();
		const run = this.run;
		const current = run ?? this.newRun(chatJid, cwd);
		this.run = current;
		if (current.chatJid !== chatJid) {
			// The previous chat's prompt was never answered: tell it why.
			if (run?.active && !run.answered && !run.fromTerminal) {
				void this.deps.queue.sendText(run.chatJid, "↪ Pi moved on to another prompt.");
			}
			// Another chat's turn: its stats and tool log start fresh.
			this.stopTyping(current);
			if (current.activity.timer) clearTimeout(current.activity.timer);
			current.report = new RunReport(cwd);
			current.activity = { lastEdit: 0, failed: false };
		}
		current.chatJid = chatJid;
		delete current.lastText;
		delete current.lastIsError;
		delete current.cutOff;
		current.active = true;
		current.answered = false;
		current.voiceIn = voice;
		if (language) current.language = language;
		else delete current.language;
		if (fromTerminal) current.fromTerminal = fromTerminal;
		else delete current.fromTerminal;
		this.startTyping();
	}

	onAssistantMessage(message: { content?: unknown; stopReason?: string; errorMessage?: string }): void {
		const run = this.run;
		if (!run?.active) return;
		const parts = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
		const text = parts
			.filter((part) => part.type === "text" && part.text)
			.map((part) => part.text!)
			.join("\n")
			.trim();
		const hasToolCalls = parts.some((part) => part.type === "toolCall");

		if (message.stopReason === "error" && message.errorMessage) {
			run.lastText = `⚠️ ${message.errorMessage}`;
			run.lastIsError = true;
		}
		if (!text) {
			if (message.stopReason === "length") run.cutOff = true;
			return;
		}
		run.lastText = text;
		run.lastIsError = false;
		if (hasToolCalls) {
			if (this.deps.settings.get().replies.interim) void this.deps.queue.sendText(run.chatJid, text);
			return;
		}
		run.pendingFinal = text;
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		const run = this.run;
		if (!run?.active) return;
		run.report.toolStarted(toolCallId, toolName, args);
		this.updateActivity(run);
	}

	onToolEnd(toolCallId: string, isError: boolean): void {
		const run = this.run;
		if (!run?.active) return;
		run.report.toolEnded(toolCallId, isError);
		this.updateActivity(run);
	}

	async onSettled(aborted: boolean): Promise<void> {
		this.agentActive = false;
		const run = this.run;
		if (!run) return;
		this.finishRun();
		if (!run.active) {
			// Pi moved on to a prompt typed in the terminal before answering this chat.
			if (!run.answered && !run.fromTerminal) await this.deliver(run, "↪ Pi moved on to a prompt typed in the terminal.", [], true);
			return;
		}
		const settings = this.deps.settings.get();
		const answer = run.pendingFinal ?? (aborted ? undefined : run.lastText);
		// Status lines ("Done", "Stopped", errors) are always sent as text, never spoken.
		const status = !answer || (!run.pendingFinal && !!run.lastIsError);
		let text = answer;
		if (aborted) text = answer ? `${answer}\n\n⏹ Stopped.` : "⏹ Stopped.";
		text ??= run.cutOff ? CUT_OFF_NOTICE : "✅ Done.";
		const extras: string[] = [];
		if (settings.replies.touchedFiles) {
			const files = formatTouchedFiles(run.report.touchedFiles());
			if (files) extras.push(files);
		}
		if (settings.replies.summary) extras.push(run.report.summary());
		await this.deliver(run, text, extras, status);
	}

	/** Sends images a tool produced (e.g. browser screenshots) to the chat Pi is answering. */
	async forwardImages(content: ReadonlyArray<{ type: string; data?: string; mimeType?: string }>, toolName: string): Promise<void> {
		const run = this.run;
		if (!run?.active) return;
		for (const part of content) {
			if (part.type !== "image" || !part.data) continue;
			const image = Buffer.from(part.data, "base64");
			if (image.length === 0 || image.length > 15 * 1024 * 1024) continue;
			log.info(`forwarding an image from ${toolName}`);
			await this.deps.queue.enqueue(run.chatJid, { image, mimetype: part.mimeType ?? "image/png", caption: `🖼 from ${toolName}` });
		}
	}

	// ── Sending ────────────────────────────────────────────────────────────

	private async deliver(run: Run, text: string, extras: string[] = [], plain = false): Promise<void> {
		try {
			if (plain && !run.fromTerminal) {
				await this.deps.queue.sendText(run.chatJid, text);
			} else if (run.fromTerminal) {
				// Always text, with the prompt so the answer makes sense on the phone.
				await this.deps.queue.sendText(run.chatJid, `💻 Terminal: "${run.fromTerminal}"\n\n${text}`);
			} else if (this.deps.media) {
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
		return {
			chatJid,
			active: true,
			answered: false,
			report: new RunReport(cwd),
			voiceIn: false,
			activity: { lastEdit: 0, failed: false },
		};
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

	private stopTyping(run: Run): void {
		if (!run.typingTimer) return;
		clearInterval(run.typingTimer);
		run.typingTimer = undefined;
		void this.deps.connection.presence(run.chatJid, "paused");
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
