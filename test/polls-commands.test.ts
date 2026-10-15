import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aesEncryptGCM, hmacSign, proto } from "baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		expect(labels).toEqual(["a"]);
		expect(pages).toBe(1);
	});

	it("pages long menus with More and First entries and unique labels", () => {
		const options = Array.from({ length: 25 }, (_, index) => ({ label: index === 3 ? "x0" : `x${index}`, value: String(index) }));
		const first = paginate(options, 0);
		expect(first.labels).toHaveLength(MAX_POLL_OPTIONS);
		expect(first.labels.at(-1)).toBe("More ▸");
		expect(first.labels).toContain("x0 (2)");
		const last = paginate(options, 2);
		expect(last.labels.at(-1)).toBe("◂ First page");
		expect(last.pages).toBe(3);
	});
});

describe("PollMenus", () => {
	it("decrypts a vote and applies the choice", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Green"]), true);
		expect(picked).toEqual([["green"]]);
		expect(h.texts).toEqual(["chose green"]);
	});

	it("works when WhatsApp addresses the poll by LID", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"], CHAT, "999888777@lid"), true);
		expect(picked).toEqual([["red"]]);
	});

	it("applies a changed vote and ignores an unchanged one", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		await h.menus.handleVote(h.vote(0, ["Green"]), true);
		expect(picked).toEqual([["red"], ["green"]]);
	});

	it("only the newest menu of a kind reacts", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.show(CHAT, colorMenu(picked));
		await h.menus.handleVote(h.vote(0, ["Red"]), true);
		expect(picked).toEqual([]);
		await h.menus.handleVote(h.vote(1, ["Red"]), true);
		expect(picked).toEqual([["red"]]);
	});

	it("accepts number replies and checks permission on gated menus", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, { ...colorMenu(picked), gated: true });
		expect(await h.menus.handleNumberReply(h.text("2"), false)).toBe(true);
		expect(h.texts.at(-1)).toMatch(/Only the owner/);
		expect(await h.menus.handleNumberReply(h.text("9"), true)).toBe(true);
		expect(h.texts.at(-1)).toBe("Pick a number from 1 to 2.");
		expect(await h.menus.handleNumberReply(h.text("hello"), true)).toBe(false);
		expect(await h.menus.handleNumberReply(h.text("2"), true)).toBe(true);
		expect(picked).toEqual([["green"]]);
		// Answered: the next bare number is for Pi.
		expect(await h.menus.handleNumberReply(h.text("1"), true)).toBe(false);
	});

	it("in a group, takes a number only as a reply to the menu", async () => {
		const h = new PollHarness();
		const picked: string[][] = [];
		await h.menus.show(CHAT, colorMenu(picked));
		const inGroup = (quotedId?: string) => ({ ...h.text("1"), isGroup: true, ...(quotedId ? { quotedId } : {}) });
		expect(await h.menus.handleNumberReply(inGroup(), true)).toBe(false);
		expect(await h.menus.handleNumberReply(inGroup("other"), true)).toBe(false);
		expect(await h.menus.handleNumberReply(inGroup(h.sentPolls[0]!.id), true)).toBe(true);
		expect(picked).toEqual([["red"]]);
	});

	it("stops taking number replies once the chat talks to Pi", async () => {
		const h = new PollHarness();
		await h.menus.show(CHAT, colorMenu([]));
		h.menus.endNumberReplies(CHAT);
		expect(await h.menus.handleNumberReply(h.text("2"), true)).toBe(false);
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
		expect(h.sentPolls[0]?.selectableCount).toBe(2);
		await h.menus.handleVote(h.vote(0, ["A"]), true);
		await h.menus.handleVote(h.vote(0, ["A", "B"]), true);
		await h.menus.handleVote(h.vote(0, ["B"]), true);
		expect(seen).toEqual([
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
		expect(h.sentPolls[1]?.name).toMatch(/\(2\/2\)/);
		expect(h.sentPolls[1]?.values).toContain("m14");
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
		expect(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "pi-whatsapp" }, active)).toEqual({ name: "pi-whatsapp", scope: [] });
		expect(seen).toEqual(["--user:pi-whatsapp", ":pi-whatsapp"]);
		expect(detectService({}, active)).toBeUndefined();
		expect(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "x; rm -rf /" }, active)).toBeUndefined();
		expect(detectService({ PI_HARNESS_WHATSAPP_SERVICE: "pi-whatsapp" }, () => false)).toBeUndefined();
	});
});

describe("command helpers", () => {
	it("parses commands", () => {
		expect(parseCommand("/Model  example")).toEqual({ name: "model", args: "example" });
		expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
		expect(parseCommand("hello /help")).toBeUndefined();
		expect(parseCommand("/")).toBeUndefined();
	});

	it("formats compaction results", () => {
		expect(formatTokens(142_300)).toBe("142k");
		expect(formatTokens(2_500)).toBe("2.5k");
		expect(formatCompaction({ tokensBefore: 142_000, estimatedTokensAfter: 23_000 }, 18_000, 200_000)).toBe(
			"✅ Compacted in 18s · 142k → 23k tokens (−84%) · context 89% free",
		);
		expect(formatCompaction({ tokensBefore: 5000 }, 1000)).toBe("✅ Compacted in 1s · 5.0k tokens before");
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
		expect(await new CommandRouter(env).handle(msg("hello"), owner)).toBe(false);
	});

	it("answers /help and /status for anyone", async () => {
		const router = new CommandRouter(env);
		expect(await router.handle(msg("/help"), guest)).toBe(true);
		expect(sent[0]).toContain("example/example-model");
		expect(sent[0]).toContain("/compact");
		await router.handle(msg("/status"), guest);
		expect(sent[1]).toContain("WhatsApp: connected");
	});

	it("blocks settings commands for non-owners unless access is open", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/voice off"), guest);
		expect(sent.at(-1)).toMatch(/Only the owner/);
		expect(env.settings.get().voiceMode).toBe("mirror");
		env.settings.update((draft) => {
			draft.commandAccess = "allowed";
		});
		await router.handle(msg("/voice off"), guest);
		expect(env.settings.get().voiceMode).toBe("off");
	});

	it("sets values directly from arguments", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/speed 1,3"), owner);
		expect(env.settings.get().voiceSpeed).toBe(1.3);
		await router.handle(msg("/autocompact off"), owner);
		expect(autoCompact).toBe(false);
		await router.handle(msg("/think max"), owner);
		expect(sent.at(-1)).toBe("✅ Thinking → high (closest this model supports)");
	});

	it("replies to unknown commands and refuses /restart outside the loop", async () => {
		const router = new CommandRouter(env);
		await router.handle(msg("/frobnicate"), owner);
		expect(sent.at(-1)).toMatch(/Unknown command \/frobnicate/);
		await router.handle(msg("/restart"), owner);
		expect(sent.at(-1)).toMatch(/systemd service/);
		expect(enabled).toBe(true);
		await router.handle(msg("/new"), owner);
		expect(newSessions).toBe(1);
	});
});
