import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyMessageContent, WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "../src/bridge.ts";
import { SettingsStore } from "../src/settings.ts";
import { SendQueue } from "../src/wa/outbound.ts";
import { RecentsStore } from "../src/wa/recents.ts";

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
beforeEach(() => {
	h = new Harness();
	h.settings.update((draft) => {
		draft.contacts = [{ id: OWNER_PHONE, name: "Alex", owner: true }];
	});
	h.bridge.markEnabled();
});
afterEach(() => h.cleanup());

describe("Bridge routing", () => {
	it("forwards an allowed message and sends only the final answer back", async () => {
		await h.bridge.handleUpsert([incoming("fix the bug")], "notify");
		expect(h.prompts).toEqual([{ content: "[WhatsApp · Alex · your reply goes to Alex] fix the bug", options: { deliverAs: "followUp" } }]);

		start(0);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "Looking…" }, { type: "toolCall" }] });
		h.bridge.onToolStart("t1", "edit", { path: "/work/a.ts" });
		h.bridge.onToolEnd("t1", false);
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "**Fixed** it." }] });
		await h.bridge.onSettled(false);
		await flush();

		expect(h.texts()).toEqual(["*Fixed* it."]);
		expect(h.sent[0]?.jid).toBe(`${OWNER_PHONE}@s.whatsapp.net`);
	});

	it("does not reply to runs started in the terminal", async () => {
		h.bridge.onAgentStart();
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "terminal answer" }] });
		await h.bridge.onSettled(false);
		expect(h.sent).toEqual([]);
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
		expect(texts[0]).toBe("Step one");
		expect(texts[1]).toBe("All done");
		expect(texts[2]).toMatch(/^📝 Files changed:\n• notes\.md\n\n⚠️ 1\/2 tool calls ok · ⏱ \d+s$/);
	});

	it("reports a stop and falls back to 'Done' when the model wrote nothing", async () => {
		await h.bridge.handleUpsert([incoming("a")], "notify");
		start(0);
		await h.bridge.onSettled(true);
		await h.bridge.handleUpsert([incoming("b")], "notify");
		start(1);
		await h.bridge.onSettled(false);
		await flush();
		expect(h.texts()).toEqual(["⏹ Stopped.", "✅ Done."]);
	});

	it("queues messages that arrive while Pi is busy and answers each turn", async () => {
		await h.bridge.handleUpsert([incoming("first")], "notify");
		start(0);
		h.idle = false;
		await h.bridge.handleUpsert([incoming("second")], "notify");
		expect(h.prompts[1]?.options).toEqual({ deliverAs: "followUp" });

		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "answer one" }] });
		h.bridge.onTurnStart();
		start(1, { agentStart: false });
		h.bridge.onAssistantMessage({ content: [{ type: "text", text: "answer two" }] });
		await h.bridge.onSettled(false);
		await flush();
		expect(h.texts()).toEqual(["answer one", "answer two"]);
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
		expect(h.texts()).toEqual(["phone answer"]);
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
		expect(h.texts()).toEqual(['💻 Terminal: "run the tests"\n\nAll green.']);
		expect(h.sent[0]?.jid).toBe(`${OWNER_PHONE}@s.whatsapp.net`);
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
		expect(h.sent.map((entry) => [entry.jid.split("@")[0], (entry.content as { text: string }).text])).toEqual([
			[OWNER_PHONE, "for Alex"],
			[OTHER, "for Sam"],
		]);
	});

	it("tells the chat when Pi never starts on its message", async () => {
		vi.useFakeTimers();
		try {
			await h.bridge.handleUpsert([incoming("hello?")], "notify");
			await vi.advanceTimersByTimeAsync(9000);
			expect(h.texts()).toEqual(["⚠️ Pi couldn't start on your message. Check the terminal (model or login problem?)."]);
		} finally {
			vi.useRealTimers();
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
		expect(deliveries).toEqual([]);
		expect(h.texts()).toEqual(["⚠️ The model hit its output limit before writing an answer. Try again, or raise the model's output limit."]);
	});

	it("labels voice notes with where the spoken reply goes", async () => {
		let label = "";
		(h.bridge as unknown as { deps: { media: unknown } }).deps.media = {
			prepare: async (_message: unknown, header: (voiceTag?: string) => string) => {
				label = header("voice note · Türkçe");
				return { content: `${label} merhaba`, voice: true };
			},
			deliverReply: async () => {},
		};
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		expect(label).toBe("[WhatsApp · Alex · voice note · Türkçe · your reply is spoken to Alex]");
		start(0);
		await h.bridge.onSettled(false);
		h.settings.update((draft) => {
			draft.voiceMode = "off";
		});
		await h.bridge.handleUpsert([incoming("voice")], "notify");
		expect(label).toBe("[WhatsApp · Alex · voice note · Türkçe · your reply goes to Alex]");
	});

	it("ignores duplicates, non-live messages and strangers", async () => {
		const message = incoming("once");
		await h.bridge.handleUpsert([message], "notify");
		await h.bridge.handleUpsert([message], "notify");
		await h.bridge.handleUpsert([incoming("history")], "append");
		await h.bridge.handleUpsert([incoming("who?", { from: "4477001122" })], "notify");
		expect(h.prompts).toHaveLength(1);
		expect(h.notices.some((notice) => notice.includes("ignored a message from Alex"))).toBe(true);
		expect(h.recents.list().map((chat) => chat.id)).toContain("4477001122");
	});

	it("skips messages from before WhatsApp was turned on and tells the chat", async () => {
		vi.useFakeTimers();
		try {
			await h.bridge.handleUpsert([incoming("old", { at: Date.now() - 10 * 60_000 })], "notify");
			expect(h.prompts).toEqual([]);
			await vi.advanceTimersByTimeAsync(9000);
			expect(h.notices.some((notice) => notice.includes("1 message arrived while off"))).toBe(true);
			expect(h.texts()[0]).toMatch(/^⏸ 1 message arrived while Pi's WhatsApp was off/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers to allow the first person who writes when nobody is allowed", async () => {
		h.settings.update((draft) => {
			draft.contacts = [];
		});
		await h.bridge.handleUpsert([incoming("hi pi")], "notify");
		expect(h.settings.get().contacts).toEqual([{ id: OWNER_PHONE, name: "Alex", owner: true }]);
		expect(h.prompts).toHaveLength(1);

		h.confirmAnswer = false;
		await h.bridge.handleUpsert([incoming("me too", { from: "4477001122" })], "notify");
		expect(h.prompts).toHaveLength(1);
	});
});
