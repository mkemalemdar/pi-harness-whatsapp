// The bridge between WhatsApp and pi: which messages reach pi, where answers go, queues, groups and notices.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyMessageContent, WAMessage } from "baileys";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Bridge, VOICE_OFF_NOTICE } from "../src/bridge.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { SendQueue } from "../src/wa/outbound.ts";
import { RecentsStore } from "../src/wa/recents.ts";

// Fake time (setTimeout, setInterval, Date) starting now; advance() moves it in small steps and lets the work each
// timer starts run in between, as real time would.
const fakeTime = () => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
const advance = async (ms: number) => {
	for (let done = 0; done < ms; done += 100) {
		mock.timers.tick(100);
		await new Promise((resolve) => setImmediate(resolve));
	}
};

const OWNER_PHONE = "905551234567";

class Harness {
	dir = mkdtempSync(join(tmpdir(), "phw-bridge-"));
	settings = new SettingsStore(join(this.dir, "config.json"));
	recents = new RecentsStore(join(this.dir, "recents.json"));
	sent: Array<{ jid: string; content: AnyMessageContent }> = [];
	prompts: Array<{ content: unknown; options?: unknown }> = [];
	notices: string[] = [];
	idle = true;
	confirmAnswer = true;
	connection = {
		isOpen: () => true,
		isOwnMessage: (_id: string) => false,
		selfIds: () => ({ phone: "905550000000" }),
		markRead: async () => {},
		presence: async () => {},
		phoneForLid: async () => undefined,
	};
	queue = new SendQueue(
		{
			isOpen: () => true,
			send: async (jid, content) => {
				this.sent.push({ jid, content });
				const id = `out${this.sent.length}`;
				return { id, key: { id, remoteJid: jid, fromMe: true } };
			},
		},
		{ sleep: async () => {} },
	);
	ctx = {
		cwd: "/work",
		hasUI: true,
		isIdle: () => this.idle,
		ui: {
			notify: (text: string) => this.notices.push(text),
			confirm: async () => this.confirmAnswer,
		},
	};
	bridge = new Bridge({
		pi: {
			sendUserMessage: (content: unknown, options?: unknown) => this.prompts.push({ content, options }),
		} as never,
		settings: this.settings,
		connection: this.connection as never,
		queue: this.queue,
		recents: this.recents,
		getCtx: () => this.ctx as never,
	});

	constructor() {
		this.settings.load();
	}

	texts(): string[] {
		return this.sent.map((entry) => (entry.content as { text?: string }).text ?? "<media>");
	}

	cleanup() {
		// A save still waiting on its timer would make the folder again after it's gone.
		this.recents.flush();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

let counter = 0;
function incoming(text: string, overrides: { from?: string; at?: number } = {}): WAMessage {
	counter++;
	return {
		key: { id: `IN${counter}`, remoteJid: `${overrides.from ?? OWNER_PHONE}@s.whatsapp.net`, fromMe: false },
		messageTimestamp: Math.floor((overrides.at ?? Date.now()) / 1000),
		pushName: "Alex",
		message: { conversation: text },
	} as WAMessage;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Pi starts a run and the prompt with this index shows up in the conversation. */
function start(index: number, { agentStart = true } = {}) {
	if (agentStart) h.bridge.onAgentStart();
	h.bridge.onUserMessage({ content: h.prompts[index]!.content });
}

let h: Harness;
// The bridge waits for Pi with unref'd timers (they must never keep Pi running on their own); here nothing else keeps
// the test process alive while a test waits on them, so a timer does for the length of each test.
let keepAlive: ReturnType<typeof setInterval> | undefined;
beforeEach(() => {
	keepAlive = setInterval(() => {}, 1000);
	h = new Harness();
	h.settings.update((draft) => {
		draft.contacts = [{ id: OWNER_PHONE, name: "Alex", owner: true }];
	});
	h.bridge.markEnabled();
});
afterEach(() => {
	clearInterval(keepAlive);
	h.cleanup();
});

describe("Bridge routing", () => {
	it("forwards an allowed message and sends only the final answer back", async () => {
		await h.bridge.handleUpsert([incoming("fix the bug")], "notify");
		assert.deepEqual(h.prompts, [{ content: "[WhatsApp · Alex · your reply goes to Alex] fix the bug", options: { deliverAs: "followUp" } }]);

		start(0);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "Looking…" }, { type: "toolCall" }] });
		h.bridge.onToolStart("t1", "edit", { path: "/work/a.ts" });
		h.bridge.onToolEnd("t1", false);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "**Fixed** it." }] });
		await h.bridge.onSettled(false);
		await flush();

		assert.deepEqual(h.texts(), ["*Fixed* it."]);
		assert.equal(h.sent[0]?.jid, `${OWNER_PHONE}@s.whatsapp.net`);
	});

	it("does not reply to runs started in the terminal", async () => {
		h.bridge.onAgentStart();
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "terminal answer" }] });
		await h.bridge.onSettled(false);
		assert.equal(h.sent.length, 0);
	});

	it("adds in-between messages, touched files and the summary when toggled on", async () => {
		h.settings.update((draft) => {
			draft.replies = { summary: true, interim: true, touchedFiles: true, toolActivity: false, terminal: false };
		});
		await h.bridge.handleUpsert([incoming("go")], "notify");
		start(0);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "Step one" }, { type: "toolCall" }] });
		h.bridge.onToolStart("t1", "write", { path: "/work/notes.md" });
		h.bridge.onToolEnd("t1", false);
		h.bridge.onToolStart("t2", "bash", { command: "false" });
		h.bridge.onToolEnd("t2", true);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "All done" }] });
		await h.bridge.onSettled(false);
		await flush();

		const texts = h.texts();
		assert.equal(texts[0], "Step one");
		assert.equal(texts[1], "All done");
		assert.match(texts[2], /^📝 Files changed:\n• notes\.md\n\n⚠️ 1\/2 tool calls ok · ⏱ \d+s$/);
	});

	it("reports a stop and falls back to 'Done' when the model wrote nothing", async () => {
		await h.bridge.handleUpsert([incoming("a")], "notify");
		start(0);
		await h.bridge.onSettled(true);
		await h.bridge.handleUpsert([incoming("b")], "notify");
		start(1);
		await h.bridge.onSettled(false);
		await flush();
		assert.deepEqual(h.texts(), ["⏹ Stopped.", "✅ Done."]);
	});

	it("queues messages that arrive while Pi is busy and answers each turn", async () => {
		await h.bridge.handleUpsert([incoming("first")], "notify");
		start(0);
		h.idle = false;
		await h.bridge.handleUpsert([incoming("second")], "notify");
		assert.deepEqual(h.prompts[1]?.options, { deliverAs: "followUp" });

		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "answer one" }] });
		h.bridge.onTurnStart();
		start(1, { agentStart: false });
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "answer two" }] });
		await h.bridge.onSettled(false);
		await flush();
		assert.deepEqual(h.texts(), ["answer one", "answer two"]);
	});

	it("keeps the answer to a terminal prompt in the terminal when WhatsApp queues behind it", async () => {
		// The terminal started a run; a WhatsApp message arrives meanwhile.
		h.bridge.onAgentStart();
		h.bridge.onUserMessage({ content: "typed in the terminal" });
		h.idle = false;
		await h.bridge.handleUpsert([incoming("from the phone")], "notify");
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "terminal answer" }] });
		h.bridge.onTurnStart();
		start(0, { agentStart: false });
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "phone answer" }] });
		await h.bridge.onSettled(false);
		await flush();
		assert.deepEqual(h.texts(), ["phone answer"]);
	});

	it("sends the owner answers to terminal prompts when Terminal answers is on", async () => {
		h.settings.update((draft) => {
			draft.replies.terminal = true;
		});
		h.bridge.onAgentStart();
		h.bridge.onUserMessage({ content: "  run the\n tests " });
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "All green." }] });
		await h.bridge.onSettled(false);
		await flush();
		assert.deepEqual(h.texts(), ['💻 Terminal: "run the tests"\n\nAll green.']);
		assert.equal(h.sent[0]?.jid, `${OWNER_PHONE}@s.whatsapp.net`);
	});

	it("sends each queued chat its own answer", async () => {
		const OTHER = "4477001122";
		h.settings.update((draft) => {
			draft.contacts.push({ id: OTHER, name: "Sam" });
		});
		await h.bridge.handleUpsert([incoming("from Alex")], "notify");
		start(0);
		h.idle = false;
		await h.bridge.handleUpsert([incoming("from Sam", { from: OTHER })], "notify");
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "for Alex" }] });
		h.bridge.onTurnStart();
		start(1, { agentStart: false });
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "for Sam" }] });
		await h.bridge.onSettled(false);
		await flush();
		assert.deepEqual(h.sent.map((entry) => [entry.jid.split("@")[0], (entry.content as { text: string }).text]), [
			[OWNER_PHONE, "for Alex"],
			[OTHER, "for Sam"],
		]);
	});

	it("tells the chat when Pi never starts on its message", async () => {
		fakeTime();
		try {
			await h.bridge.handleUpsert([incoming("hello?")], "notify");
			await advance(9000);
			assert.deepEqual(h.texts(), ["⚠️ Pi couldn't start on your message. Check the terminal (model or login problem?)."]);
		} finally {
			mock.timers.reset();
		}
	});

	it("sends status lines as text and explains a cut-off answer", async () => {
		const deliveries: Array<{ text: string; voiceIn: boolean }> = [];
		(h.bridge as unknown as { deps: { media: unknown } }).deps.media = {
			prepare: async (_message: unknown, header: (voiceTag?: string) => string) => ({ content: `${header("voice note")} hi`, voice: true }),
			deliverReply: async (_jid: string, text: string, context: { voiceIn: boolean }) => {
				deliveries.push({ text, voiceIn: context.voiceIn });
			},
		};
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		start(0);
		h.bridge.onAssistantMessage({ content: [{ type: "thinking" }], stopReason: "length" });
		await h.bridge.onSettled(false);
		await flush();
		assert.equal(deliveries.length, 0);
		assert.deepEqual(h.texts(), ["⚠️ The model hit its output limit before writing an answer. Try again, or raise the model's output limit."]);
	});

	it("labels voice notes with where the spoken reply goes", async () => {
		h.settings.update((draft) => {
			draft.voice = { understand: true, reply: true };
		});
		let label = "";
		(h.bridge as unknown as { deps: { media: unknown } }).deps.media = {
			prepare: async (_message: unknown, header: (voiceTag?: string) => string) => {
				label = header("voice note");
				return { content: `${label} merhaba`, voice: true };
			},
			deliverReply: async () => {},
		};
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		assert.equal(label, "[WhatsApp · Alex · voice note · your reply is spoken to Alex]");
		start(0);
		await h.bridge.onSettled(false);
		h.settings.update((draft) => {
			draft.voiceMode = "off";
		});
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		assert.equal(label, "[WhatsApp · Alex · voice note · your reply goes to Alex]");
		// Voice replies off: never "spoken", whatever the reply type says.
		start(1);
		await h.bridge.onSettled(false);
		h.settings.update((draft) => {
			draft.voiceMode = "voice";
			draft.voice.reply = false;
		});
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		assert.equal(label, "[WhatsApp · Alex · voice note · your reply goes to Alex]");
	});

	it("answers voice notes with 'please type' while voice notes are off, without bothering Pi", async () => {
		const voiceNote = (extra: Record<string, unknown> = {}): WAMessage => {
			counter++;
			return {
				key: { id: `V${counter}`, remoteJid: `${OWNER_PHONE}@s.whatsapp.net`, fromMe: false },
				messageTimestamp: Math.floor(Date.now() / 1000),
				pushName: "Alex",
				message: { audioMessage: { seconds: 3, ptt: true, mimetype: "audio/ogg; codecs=opus" } },
				...extra,
			} as WAMessage;
		};
		await h.bridge.handleUpsert([voiceNote()], "notify");
		await h.bridge.handleUpsert([voiceNote()], "notify");
		assert.equal(h.prompts.length, 0);
		assert.deepEqual(h.texts(), [VOICE_OFF_NOTICE, VOICE_OFF_NOTICE]);
		// The first message of someone new, allowed in the terminal, gets the same answer.
		h.settings.update((draft) => {
			draft.contacts = [];
		});
		await h.bridge.handleUpsert([voiceNote({ key: { id: "NEW1", remoteJid: "4477001122@s.whatsapp.net", fromMe: false } })], "notify");
		assert.equal(h.prompts.length, 0);
		assert.equal(h.texts().at(-1), VOICE_OFF_NOTICE);
		assert.ok(!h.bridge.systemPromptSection().includes("Voice notes arrive"));
		assert.ok(!h.bridge.systemPromptSection().includes("your reply is spoken"));
	});

	it("hands messages to Pi in the order they arrived, even when one takes longer to prepare", async () => {
		let release!: () => void;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		(h.bridge as unknown as { deps: { media: unknown } }).deps.media = {
			prepare: async (message: { text: string }, header: () => string) => {
				if (message.text === "first") await slow;
				return { content: `${header()} ${message.text}`, voice: false };
			},
			deliverReply: async () => {},
		};
		const first = h.bridge.handleUpsert([incoming("first")], "notify");
		const second = h.bridge.handleUpsert([incoming("second")], "notify");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(h.prompts.length, 0);
		release();
		await first;
		start(0);
		await second;
		assert.deepEqual(h.prompts.map((prompt) => String(prompt.content).split("] ")[1]), ["first", "second"]);
	});

	describe("groups", () => {
		const GROUP = "120363000000000001@g.us";
		const BOT = "905550000000";
		let n = 0;
		function groupMessage(text: string, extra: { mention?: boolean; replyToBot?: boolean; image?: boolean } = {}): WAMessage {
			n++;
			const contextInfo = {
				...(extra.mention ? { mentionedJid: [`${BOT}@s.whatsapp.net`] } : {}),
				...(extra.replyToBot ? { stanzaId: "OUT1", participant: `${BOT}@s.whatsapp.net`, quotedMessage: { conversation: "Pi's earlier answer" } } : {}),
			};
			return {
				key: { id: `G${n}`, remoteJid: GROUP, participant: `${OWNER_PHONE}@s.whatsapp.net`, fromMe: false },
				messageTimestamp: Math.floor(Date.now() / 1000),
				pushName: "Alex",
				message: extra.image
					? { imageMessage: { caption: text, mimetype: "image/jpeg", contextInfo } }
					: { extendedTextMessage: { text, contextInfo } },
			} as WAMessage;
		}
		beforeEach(() => {
			h.settings.update((draft) => {
				draft.contacts.push({ id: GROUP, name: "Team" });
			});
		});

		it("answers replies and @mentions by default, with the messages before as context", async () => {
			await h.bridge.handleUpsert([groupMessage("deploy tomorrow?")], "notify");
			await h.bridge.handleUpsert([groupMessage("caption text", { image: true })], "notify");
			assert.equal(h.prompts.length, 0);
			await h.bridge.handleUpsert([groupMessage("@Pi what do you think?", { mention: true })], "notify");
			assert.equal(h.prompts.length, 1);
			assert.equal(h.prompts[0]!.content, '[WhatsApp group "Team" · earlier messages, for context]\nAlex: deploy tomorrow?\nAlex: [sent an image] caption text\n' +
					'[WhatsApp group "Team" · Alex · your reply goes to the group] @Pi what do you think?');
			start(0);
			await h.bridge.onSettled(false);
			await h.bridge.handleUpsert([groupMessage("and now?", { replyToBot: true })], "notify");
			// A reply to Pi counts too; the context was used up by the previous question.
			assert.equal(h.prompts[1]!.content, '[WhatsApp group "Team" · Alex · your reply goes to the group] and now?');
		});

		it("follows the setting", async () => {
			h.settings.update((draft) => {
				draft.groupReplies = "mentions";
			});
			await h.bridge.handleUpsert([groupMessage("thanks", { replyToBot: true })], "notify");
			assert.equal(h.prompts.length, 0);
			h.settings.update((draft) => {
				draft.groupReplies = "all";
			});
			await h.bridge.handleUpsert([groupMessage("hello everyone")], "notify");
			assert.equal(h.prompts.length, 1);
		});

		it("with voice notes off, answers only a voice note that replies to Pi", async () => {
			const groupVoice = (replyToBot: boolean): WAMessage => {
				n++;
				const contextInfo = replyToBot ? { stanzaId: "OUT1", participant: `${BOT}@s.whatsapp.net`, quotedMessage: { conversation: "earlier" } } : {};
				return {
					key: { id: `GV${n}`, remoteJid: GROUP, participant: `${OWNER_PHONE}@s.whatsapp.net`, fromMe: false },
					messageTimestamp: Math.floor(Date.now() / 1000),
					pushName: "Alex",
					message: { audioMessage: { seconds: 2, ptt: true, contextInfo } },
				} as WAMessage;
			};
			h.settings.update((draft) => {
				draft.groupReplies = "all";
			});
			await h.bridge.handleUpsert([groupVoice(false)], "notify");
			assert.equal(h.texts().length, 0);
			await h.bridge.handleUpsert([groupVoice(true)], "notify");
			assert.deepEqual(h.texts(), [VOICE_OFF_NOTICE]);
			await h.bridge.handleUpsert([groupMessage("so?", { mention: true })], "notify");
			// The first voice note is context, as a note only.
			assert.ok(String(h.prompts[0]!.content).includes("Alex: [sent a voice note]"));
		});

		it("asks WhatsApp once for the name of a group it doesn't know", async () => {
			const asked: string[] = [];
			(h.connection as unknown as { groupName: (jid: string) => Promise<string> }).groupName = async (jid) => {
				asked.push(jid);
				return "Weekend Trip";
			};
			h.settings.update((draft) => {
				draft.contacts = draft.contacts.map((contact) => (contact.id === GROUP ? { id: GROUP } : contact));
			});
			await h.bridge.handleUpsert([groupMessage("hi")], "notify");
			await h.bridge.handleUpsert([groupMessage("hi again")], "notify");
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.deepEqual(asked, [GROUP]);
			assert.equal(h.settings.get().contacts.find((contact) => contact.id === GROUP)?.name, "Weekend Trip");
			assert.equal(h.recents.nameOf(GROUP), "Weekend Trip");
		});

		it("takes known commands and menu numbers, and calls the mention @Pi", async () => {
			const handled: string[] = [];
			(h.bridge as unknown as { deps: { commands: unknown } }).deps.commands = {
				isCommand: (text: string) => text.startsWith("/status"),
				handle: async (message: { text: string }) => {
					handled.push(message.text);
					return message.text.startsWith("/") || /^\d+$/.test(message.text);
				},
				handleVote: async () => {},
			};
			h.settings.update((draft) => {
				draft.groupReplies = "mentions";
			});
			await h.bridge.handleUpsert([groupMessage("/home/alex is full")], "notify");
			await h.bridge.handleUpsert([groupMessage("/status")], "notify");
			await h.bridge.handleUpsert([groupMessage("2", { replyToBot: true })], "notify");
			await h.bridge.handleUpsert([groupMessage(`@${BOT} look`, { mention: true })], "notify");
			assert.deepEqual(handled, ["/status", "2", "@Pi look"]);
			assert.equal(h.prompts[0]!.content, '[WhatsApp group "Team" · earlier messages, for context]\nAlex: /home/alex is full\n[WhatsApp group "Team" · Alex · your reply goes to the group] @Pi look');
		});
	});

	it("ignores duplicates, non-live messages and strangers", async () => {
		const message = incoming("once");
		await h.bridge.handleUpsert([message], "notify");
		await h.bridge.handleUpsert([message], "notify");
		await h.bridge.handleUpsert([incoming("history")], "append");
		await h.bridge.handleUpsert([incoming("who?", { from: "4477001122" })], "notify");
		assert.equal(h.prompts.length, 1);
		assert.equal(h.notices.some((notice) => notice.includes("ignored a message from Alex")), true);
		assert.ok(h.recents.list().map((chat) => chat.id).includes("4477001122"));
	});

	it("skips messages from before WhatsApp was turned on and tells the chat", async () => {
		fakeTime();
		try {
			await h.bridge.handleUpsert([incoming("old", { at: Date.now() - 10 * 60_000 })], "notify");
			assert.equal(h.prompts.length, 0);
			await advance(9000);
			assert.equal(h.notices.some((notice) => notice.includes("1 message arrived while off")), true);
			assert.match(h.texts()[0], /^⏸ 1 message arrived while Pi's WhatsApp was off/);
		} finally {
			mock.timers.reset();
		}
	});

	it("offers to allow the first person who writes when nobody is allowed", async () => {
		h.settings.update((draft) => {
			draft.contacts = [];
		});
		await h.bridge.handleUpsert([incoming("hi pi")], "notify");
		assert.deepEqual(h.settings.get().contacts, [{ id: OWNER_PHONE, name: "Alex", owner: true }]);
		assert.equal(h.prompts.length, 1);

		h.confirmAnswer = false;
		await h.bridge.handleUpsert([incoming("me too", { from: "4477001122" })], "notify");
		assert.equal(h.prompts.length, 1);
	});
});
