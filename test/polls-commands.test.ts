import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aesEncryptGCM, hmacSign, proto } from "baileys";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatCompaction, formatTokens } from "../src/commands/session.ts";
import { CommandRouter, parseCommand } from "../src/commands/router.ts";
import type { CommandEnv } from "../src/commands/types.ts";
import { SettingsStore } from "../src/settings.ts";
import type { InboundMessage } from "../src/wa/inbound.ts";
import { SendQueue } from "../src/wa/outbound.ts";
import { MAX_POLL_OPTIONS, type Menu, paginate, PollMenus } from "../src/wa/polls.ts";

const SELF = "905550000000@s.whatsapp.net";
const CHAT = "905551234567@s.whatsapp.net";

/** Encrypts a vote the way the voter's phone does. */
function encryptVote(options: string[], pollId: string, secret: Uint8Array, voterJid: string, creatorJid = SELF) {
	const payload = proto.Message.PollVoteMessage.encode({
		selectedOptions: options.map((option) => createHash("sha256").update(option).digest()),
	}).finish();
	const sign = Buffer.concat([
		Buffer.from(pollId),
		Buffer.from(creatorJid),
		Buffer.from(voterJid),
		Buffer.from("Poll Vote"),
		new Uint8Array([1]),
	]);
	const key0 = hmacSign(secret, new Uint8Array(32), "sha256");
	const decKey = hmacSign(sign, key0, "sha256");
	const iv = randomBytes(12);
	const encPayload = aesEncryptGCM(payload, decKey, iv, Buffer.from(`${pollId}\u0000${voterJid}`));
	return { encPayload, encIv: iv };
}

class PollHarness {
	sentPolls: Array<{ chatJid: string; id: string; name: string; values: string[]; secret: Uint8Array; selectableCount: number }> = [];
	texts: string[] = [];
	menus = new PollMenus(
		{
			sendPoll: async (chatJid, poll) => {
				const id = `POLL${this.sentPolls.length + 1}`;
				this.sentPolls.push({ chatJid, id, name: poll.name, values: poll.values, secret: poll.messageSecret, selectableCount: poll.selectableCount });
				return id;
			},
			sendText: async (_chatJid, text) => {
				this.texts.push(text);
			},
		},
		() => ["905550000000@lid".replace("@lid", "@s.whatsapp.net"), "999888777@lid"],
	);

	vote(pollIndex: number, options: string[], voterJid = CHAT, creatorJid = SELF): InboundMessage {
		const poll = this.sentPolls[pollIndex]!;
		return {
			id: `V${Math.random()}`,
			chatJid: CHAT,
			senderJid: voterJid,
			isGroup: false,
			fromMe: false,
			timestamp: Date.now(),
			kind: "poll-vote",
			text: "",
			pollUpdate: {
				pollCreationMessageKey: { id: poll.id, remoteJid: CHAT, fromMe: true },
				vote: encryptVote(options, poll.id, poll.secret, voterJid, creatorJid),
			},
			raw: {} as never,
		};
	}

	text(text: string): InboundMessage {
		return { id: "T", chatJid: CHAT, senderJid: CHAT, isGroup: false, fromMe: false, timestamp: Date.now(), kind: "text", text, raw: {} as never };
	}
}

const colorMenu = (picked: string[][]): Menu => ({
	kind: "color",
	title: "Pick a color",
	options: [
		{ label: "Red", value: "red" },
		{ label: "Green", value: "green" },
	],
	onPick: async (values) => {
		picked.push(values);
		return `chose ${values.join(",")}`;
	},
});

describe("paginate", () => {
	it("keeps small menus on one page", () => {
		const { labels, pages } = paginate([{ label: "a", value: "1" }], 0);
		assert.deepEqual(labels, ["a"]);
		assert.equal(pages, 1);
	});

	it("pages long menus with More and First entries and unique labels", () => {
		const options = Array.from({ length: 25 }, (_, index) => ({ label: index === 3 ? "x0" : `x${index}`, value: String(index) }));
		const first = paginate(options, 0);
		assert.equal(first.labels.length, MAX_POLL_OPTIONS);
		assert.equal(first.labels.at(-1), "More ▸");
		assert.ok(first.labels.includes("x0 (2)"));
		const last = paginate(options, 2);
		assert.equal(last.labels.at(-1), "◂ First page");
		assert.equal(last.pages, 3);
	});
});

describe("PollMenus", () => {
	it("decrypts a vote and applies the choice", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Green"]), true);
		assert.deepEqual(picked, [["green"]]);
		assert.deepEqual(h.texts, ["chose green"]);
	});

	it("works when WhatsApp addresses the poll by LID", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"], CHAT, "999888777@lid"), true);
		assert.deepEqual(picked, [["red"]]);
	});

	it("applies a changed vote and ignores an unchanged one", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		await h.menus.handleVote(h.vote(0, ["Green"]), true);
		assert.deepEqual(picked, [["red"], ["green"]]);
	});

	it("only the newest menu of a kind reacts", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		assert.equal(picked.length, 0);
		await h.menus.handleVote(h.vote(1, ["Red"]), true);
		assert.deepEqual(picked, [["red"]]);
	});

	it("accepts number replies and checks permission on gated menus", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, { ...colorMenu(picked), gated: true });
		assert.equal(await h.menus.handleNumberReply(h.text("2"), false), true);
		assert.match(h.texts.at(-1) ?? "", /Only the owner/);
		assert.equal(await h.menus.handleNumberReply(h.text("9"), true), true);
		assert.equal(h.texts.at(-1), "Pick a number from 1 to 2.");
		assert.equal(await h.menus.handleNumberReply(h.text("hello"), true), false);
		assert.equal(await h.menus.handleNumberReply(h.text("2"), true), true);
		assert.deepEqual(picked, [["green"]]);
		// Answered: the next bare number is for Pi.
		assert.equal(await h.menus.handleNumberReply(h.text("1"), true), false);
	});

	it("in a group, takes a number only as a reply to the menu", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		const inGroup = (quotedId?: string) => ({ ...h.text("1"), isGroup: true, ...(quotedId ? { quotedId } : {}) });
		assert.equal(await h.menus.handleNumberReply(inGroup(), true), false);
		assert.equal(await h.menus.handleNumberReply(inGroup("other"), true), false);
		assert.equal(await h.menus.handleNumberReply(inGroup(h.sentPolls[0]!.id), true), true);
		assert.deepEqual(picked, [["red"]]);
	});

	it("stops taking number replies once the chat talks to Pi", async () => {
		const h = new PollHarness();
		await h.menus.show(CHAT, colorMenu([]));
		h.menus.endNumberReplies(CHAT);
		assert.equal(await h.menus.handleNumberReply(h.text("2"), true), false);
	});

	it("reports ticks and unticks for multi-choice menus", async () => {
		const h = new PollHarness();
		const seen: Array<{ added: string[]; removed: string[] }> = [];
		await h.menus.show(CHAT, {
			kind: "multi",
			title: "Toggles",
			multi: true,
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			onPick: async (_values, { added, removed }) => {
				seen.push({ added, removed });
				return undefined;
			},
		});
		assert.equal(h.sentPolls[0]?.selectableCount, 2);
		await h.menus.handleVote(h.vote(0, ["A"]), true);
		await h.menus.handleVote(h.vote(0, ["A", "B"]), true);
		await h.menus.handleVote(h.vote(0, ["B"]), true);
		assert.deepEqual(seen, [
			{ added: ["a"], removed: [] },
			{ added: ["b"], removed: [] },
			{ added: [], removed: ["a"] },
		]);
	});

	it("pages to the next poll on More", async () => {
		const h = new PollHarness();
		const options = Array.from({ length: 15 }, (_, index) => ({ label: `m${index}`, value: String(index) }));
		await h.menus.show(CHAT, { kind: "big", title: "Big", options, onPick: async () => undefined });
		await h.menus.handleVote(h.vote(0, ["More ▸"]), true);
		assert.match(h.sentPolls[1]?.name, /\(2\/2\)/);
		assert.ok(h.sentPolls[1]?.values.includes("m14"));
	});
});

describe("detectService", () => {
	it("finds the unit named in the environment, user scope first", async () => {
		const { detectService } = await import("../src/commands/power.ts");
		const seen: string[] = [];
		const active = (scope: string[], name: string) => {
			seen.push(`${scope.join("")}:${name}`);
			return scope.length === 0;
		};
		assert.deepEqual(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "pi-whatsapp" }, active), { name: "pi-whatsapp", scope: [] });
		assert.deepEqual(seen, ["--user:pi-whatsapp", ":pi-whatsapp"]);
		assert.equal(detectService({}, active), undefined);
		assert.equal(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "x; rm -rf /" }, active), undefined);
		assert.equal(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "pi-whatsapp" }, () => false), undefined);
	});
});

describe("command helpers", () => {
	it("parses commands", () => {
		assert.deepEqual(parseCommand("/Model  example"), { name: "model", args: "example" });
		assert.deepEqual(parseCommand("/help"), { name: "help", args: "" });
		assert.equal(parseCommand("hello /help"), undefined);
		assert.equal(parseCommand("/"), undefined);
	});

	it("formats compaction results", () => {
		assert.equal(formatTokens(142_300), "142k");
		assert.equal(formatTokens(2_500), "2.5k");
		assert.equal(formatCompaction({ tokensBefore: 142_000, estimatedTokensAfter: 23_000 }, 18_000, 200_000), "✅ Compacted in 18s · 142k → 23k tokens (−84%) · context 89% free");
		assert.equal(formatCompaction({ tokensBefore: 5000 }, 1000), "✅ Compacted in 1s · 5.0k tokens before");
	});
});

describe("CommandRouter", () => {
	let dir: string;
	let env: CommandEnv;
	let sent: string[];
	let autoCompact: boolean;
	let enabled: boolean;
	let newSessions = 0;
	const thinking = { level: "medium" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-cmd-"));
		sent = [];
		autoCompact = true;
		enabled = true;
		const settings = new SettingsStore(join(dir, "config.json"));
		settings.load();
		settings.update((draft) => {
			draft.voice = { understand: true, reply: true };
		});
		const queue = new SendQueue(
			{
				isOpen: () => true,
				send: async (_jid, content) => {
					sent.push((content as { text?: string }).text ?? "<poll>");
					return { id: "x", key: { id: "x" } };
				},
			},
			{ sleep: async () => {} },
		);
		const h = new PollHarness();
		env = {
			pi: {
				getThinkingLevel: () => thinking.level,
				setThinkingLevel: (level: string) => {
					thinking.level = level === "max" ? "high" : level;
				},
			} as never,
			getCtx: () =>
				({
					isIdle: () => true,
					ui: { notify: () => {} },
					model: { provider: "example", id: "example-model", reasoning: true, contextWindow: 1_000_000 },
					getContextUsage: () => ({ tokens: 3400, contextWindow: 1_000_000, percent: 0.3 }),
				}) as never,
			settings,
			queue,
			menus: h.menus,
			connectionLabel: () => "connected",
			isAutoCompactEnabled: () => autoCompact,
			setAutoCompact: (on) => {
				autoCompact = on;
			},
			setEnabled: async (on) => {
				enabled = on;
			},
			markRestartRequested: () => {},
			startNewSession: () => {
				newSessions++;
			},
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const msg = (text: string): InboundMessage => ({
		id: "c",
		chatJid: CHAT,
		senderJid: CHAT,
		isGroup: false,
		fromMe: false,
		timestamp: Date.now(),
		kind: "text",
		text,
		raw: {} as never,
	});
	const owner = { allowed: true, isOwner: true };
	const guest = { allowed: true, isOwner: false };

	it("does not treat normal text as a command", async () => {
		assert.equal(await new CommandRouter(env).handle(msg("hello"), owner), false);
	});

	it("answers /help and /status for anyone", async () => {
		const router = new CommandRouter(env);
		assert.equal(await router.handle(msg("/help"), guest), true);
		assert.ok(sent[0].includes("example/example-model"));
		assert.ok(sent[0].includes("/compact"));
		await router.handle(msg("/status"), guest);
		assert.ok(sent[1].includes("WhatsApp: connected"));
	});

	it("blocks settings commands for non-owners unless access is open", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/voice off"), guest);
		assert.match(sent.at(-1) ?? "", /Only the owner/);
		assert.equal(env.settings.get().voiceMode, "mirror");
		env.settings.update((draft) => {
			draft.commandAccess = "allowed";
		});
		await router.handle(msg("/voice off"), guest);
		assert.equal(env.settings.get().voiceMode, "off");
	});

	it("sets values directly from arguments", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/speed 1,3"), owner);
		assert.equal(env.settings.get().voiceSpeed, 1.3);
		await router.handle(msg("/autocompact off"), owner);
		assert.equal(autoCompact, false);
		await router.handle(msg("/think max"), owner);
		assert.equal(sent.at(-1), "✅ Thinking → high (closest this model supports)");
	});

	it("won't change voice from WhatsApp while voice replies are off", async () => {
		const router = new CommandRouter(env);
		env.settings.update((draft) => {
			draft.voice = { understand: false, reply: false };
		});
		await router.handle(msg("/voice voice"), owner);
		assert.match(sent.at(-1) ?? "", /^Voice replies are off\. Turn them on in the terminal/);
		await router.handle(msg("/speed 1.2"), owner);
		assert.match(sent.at(-1) ?? "", /^Voice replies are off/);
		assert.partialDeepStrictEqual(env.settings.get(), { voiceMode: "mirror", voiceSpeed: 1 });
		env.settings.update((draft) => {
			draft.voice = { understand: false, reply: true };
		});
		await router.handle(msg("/help"), owner);
		assert.ok(sent.at(-1)!.includes("Voice notes: understand ✗ · reply ✓"));
	});

	it("replies to unknown commands and refuses /restart outside the loop", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/frobnicate"), owner);
		assert.match(sent.at(-1) ?? "", /Unknown command \/frobnicate/);
		await router.handle(msg("/restart"), owner);
		assert.match(sent.at(-1) ?? "", /systemd service/);
		assert.equal(enabled, true);
		await router.handle(msg("/new"), owner);
		assert.equal(newSessions, 1);
	});
});
