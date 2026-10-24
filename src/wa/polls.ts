// Menus as WhatsApp polls. Normal accounts can't send list or button
// messages, but polls work everywhere: we keep each poll's secret, decrypt the
// vote when you tap an option, and apply it right away. Replying with the
// option's number works too.
//
// Only the newest menu of each kind in a chat is active.

import { createHash, randomBytes } from "node:crypto";
import { decryptPollVote, type proto } from "baileys";
import { createLogger } from "../log.ts";
import type { InboundMessage } from "./inbound.ts";
import { jidUser, normalizeJid } from "./jid.ts";

const log = createLogger("polls");

/** WhatsApp allows at most 12 options per poll. */
export const MAX_POLL_OPTIONS = 12;
const MORE = "More ▸";
const FIRST = "◂ First page";
/** Menus stop reacting after this long. */
export const MENU_TTL_MS = 30 * 60_000;
/** A bare number only counts as a menu answer shortly after the menu was sent. */
export const NUMBER_REPLY_TTL_MS = 5 * 60_000;

export interface MenuOption {
	label: string;
	value: string;
}

export interface PickContext {
	chatJid: string;
	/** For multi-choice menus: options ticked / unticked by this vote. */
	added: string[];
	removed: string[];
}

export interface Menu {
	kind: string;
	title: string;
	options: MenuOption[];
	multi?: boolean;
	/** Only users allowed to change Pi may answer. */
	gated?: boolean;
	/** Applies the choice; returns the confirmation to send back. */
	onPick(values: string[], context: PickContext): Promise<string | undefined>;
}

export interface PollSender {
	sendPoll(chatJid: string, poll: { name: string; values: string[]; selectableCount: number; messageSecret: Uint8Array }): Promise<string | undefined>;
	sendText(chatJid: string, text: string): Promise<unknown>;
}

interface ActivePoll {
	id: string;
	chatJid: string;
	menu: Menu;
	page: number;
	/** Labels exactly as sent, in order. */
	labels: string[];
	/** Label → option value; MORE/FIRST map to paging. */
	values: Map<string, string>;
	secret: Uint8Array;
	createdAt: number;
	/** Last selection per voter (multi-choice diffing). */
	selections: Map<string, Set<string>>;
	/** A bare number no longer answers this menu (it was answered, or the chat moved on). */
	numbersDone?: boolean;
}

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** Splits options into poll pages, adding paging entries. Pure for tests. */
export function paginate(options: readonly MenuOption[], page: number): { labels: string[]; values: Map<string, string>; pages: number } {
	const unique = uniqueLabels(options);
	if (unique.length <= MAX_POLL_OPTIONS) {
		return { labels: unique.map((option) => option.label), values: new Map(unique.map((option) => [option.label, option.value])), pages: 1 };
	}
	const perPage = MAX_POLL_OPTIONS - 1;
	const pages = Math.ceil(unique.length / perPage);
	const current = Math.min(Math.max(0, page), pages - 1);
	const slice = unique.slice(current * perPage, current * perPage + perPage);
	const values = new Map(slice.map((option) => [option.label, option.value]));
	const labels = slice.map((option) => option.label);
	const paging = current < pages - 1 ? MORE : FIRST;
	labels.push(paging);
	values.set(paging, paging);
	return { labels, values, pages };
}

function uniqueLabels(options: readonly MenuOption[]): MenuOption[] {
	const seen = new Map<string, number>();
	return options.map((option) => {
		let label = option.label.slice(0, 90);
		const count = seen.get(label) ?? 0;
		seen.set(label, count + 1);
		if (count > 0) label = `${label} (${count + 1})`;
		return { label, value: option.value };
	});
}

export class PollMenus {
	private readonly polls = new Map<string, ActivePoll>();

	private readonly sender: PollSender;
	private readonly selfJids: () => string[];
	private readonly now: () => number;

	constructor(
		sender: PollSender,
		selfJids: () => string[],
		now: () => number = Date.now,
	) {
		this.sender = sender;
		this.selfJids = selfJids;
		this.now = now;
	}

	async show(chatJid: string, menu: Menu, page = 0): Promise<void> {
		const { labels, values, pages } = paginate(menu.options, page);
		if (labels.length === 0) {
			await this.sender.sendText(chatJid, `${menu.title}\n(nothing to choose from)`);
			return;
		}
		const pageNote = pages > 1 ? ` (${page + 1}/${pages})` : "";
		const hint = menu.multi ? "tick to switch" : `tap, or reply 1–${labels.length}`;
		const secret = new Uint8Array(randomBytes(32));
		const id = await this.sender.sendPoll(chatJid, {
			name: `${menu.title}${pageNote} · ${hint}`,
			values: labels,
			selectableCount: menu.multi ? labels.length : 1,
			messageSecret: secret,
		});
		if (!id) return;
		// Only the newest menu of a kind in a chat stays active.
		for (const [existingId, poll] of this.polls) {
			if (poll.chatJid === chatJid && poll.menu.kind === menu.kind) this.polls.delete(existingId);
		}
		this.polls.set(id, { id, chatJid, menu, page, labels, values, secret, createdAt: this.now(), selections: new Map() });
		this.prune();
	}

	/**
	 * A reply like "2" picks option 2 of the newest single-choice menu in that chat.
	 * Returns true when the text was used as a menu answer.
	 */
	async handleNumberReply(message: InboundMessage, mayChange: boolean): Promise<boolean> {
		const match = /^\s*(\d{1,2})\s*$/.exec(message.text);
		if (!match) return false;
		// In a group, a number only answers the menu it replies to (people send numbers to each other).
		const poll = message.isGroup ? this.repliedPoll(message) : this.newestIn(message.chatJid);
		if (!poll) return false;
		const label = poll.labels[Number(match[1]) - 1];
		if (!label) {
			await this.sender.sendText(message.chatJid, `Pick a number from 1 to ${poll.labels.length}.`);
			return true;
		}
		// Once answered, a later bare number is meant for Pi.
		if (!poll.menu.gated || mayChange) poll.numbersDone = true;
		await this.apply(poll, [label], [label], [], mayChange);
		return true;
	}

	/**
	 * The chat sent Pi a normal message: from now on a bare number is an answer
	 * to Pi (e.g. "option 2"), not to an older menu. Tapping the poll still works.
	 */
	endNumberReplies(chatJid: string): void {
		for (const poll of this.polls.values()) if (poll.chatJid === chatJid) poll.numbersDone = true;
	}

	/** Decrypts a poll vote and applies it. */
	async handleVote(message: InboundMessage, mayChange: boolean): Promise<void> {
		const update = message.pollUpdate;
		const pollId = update?.pollCreationMessageKey?.id;
		if (!update?.vote || !pollId) return;
		const poll = this.polls.get(pollId);
		if (!poll || this.isExpired(poll)) {
			log.info("vote on an old or unknown menu ignored");
			return;
		}
		const selected = this.decrypt(poll, update.vote, message);
		if (!selected) return;
		const voter = normalizeJid(message.senderAltJid ?? message.senderJid);
		const previous = poll.selections.get(voter) ?? new Set<string>();
		poll.selections.set(voter, new Set(selected));
		const added = selected.filter((label) => !previous.has(label));
		const removed = [...previous].filter((label) => !selected.includes(label));
		if (poll.menu.multi) {
			if (added.length + removed.length > 0) await this.apply(poll, selected, added, removed, mayChange);
		} else if (added.length > 0) {
			poll.numbersDone = true;
			// Single choice: the newly tapped option (changing a vote applies the new one).
			await this.apply(poll, added, added, [], mayChange);
		}
	}

	private async apply(poll: ActivePoll, labels: string[], added: string[], removed: string[], mayChange: boolean): Promise<void> {
		if (poll.menu.gated && !mayChange) {
			await this.sender.sendText(poll.chatJid, "🔒 Only the owner can change Pi's settings from WhatsApp.");
			return;
		}
		const paging = added.find((label) => label === MORE || label === FIRST);
		if (paging) {
			await this.show(poll.chatJid, poll.menu, paging === MORE ? poll.page + 1 : 0);
			return;
		}
		const toValues = (list: string[]) =>
			list.map((label) => poll.values.get(label)).filter((value): value is string => !!value && value !== MORE && value !== FIRST);
		try {
			const reply = await poll.menu.onPick(toValues(labels), {
				chatJid: poll.chatJid,
				added: toValues(added),
				removed: toValues(removed),
			});
			if (reply) await this.sender.sendText(poll.chatJid, reply);
		} catch (error) {
			log.error("menu action failed", error);
			await this.sender.sendText(poll.chatJid, `⚠️ ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private decrypt(poll: ActivePoll, vote: proto.Message.IPollEncValue, message: InboundMessage): string[] | undefined {
		if (!vote.encPayload || !vote.encIv) return undefined;
		// WhatsApp may address the poll by phone number or by LID; try each pairing.
		const creators = this.selfJids();
		const voters = [message.senderJid, message.senderAltJid].filter((jid): jid is string => !!jid);
		for (const pollCreatorJid of creators) {
			for (const voterJid of voters) {
				try {
					const decrypted = decryptPollVote(
						{ encPayload: vote.encPayload, encIv: vote.encIv },
						{ pollCreatorJid, pollMsgId: poll.id, pollEncKey: poll.secret, voterJid },
					);
					const hashes = new Set((decrypted.selectedOptions ?? []).map((option) => Buffer.from(option).toString("hex")));
					return poll.labels.filter((label) => hashes.has(sha256Hex(label)));
				} catch {
					// Wrong pairing; try the next.
				}
			}
		}
		log.warn("could not decrypt a poll vote", { creators: creators.map(jidUser), voters: voters.map(jidUser) });
		return undefined;
	}

	/** The single-choice menu a message replies to, if it is still active. */
	private repliedPoll(message: InboundMessage): ActivePoll | undefined {
		const poll = message.quotedId ? this.polls.get(message.quotedId) : undefined;
		return poll && poll.chatJid === message.chatJid && !poll.menu.multi && !this.isExpired(poll) ? poll : undefined;
	}

	private newestIn(chatJid: string): ActivePoll | undefined {
		let newest: ActivePoll | undefined;
		for (const poll of this.polls.values()) {
			if (poll.chatJid !== chatJid || poll.menu.multi || poll.numbersDone || this.now() - poll.createdAt > NUMBER_REPLY_TTL_MS) continue;
			if (!newest || poll.createdAt >= newest.createdAt) newest = poll;
		}
		return newest;
	}

	private isExpired(poll: ActivePoll): boolean {
		return this.now() - poll.createdAt > MENU_TTL_MS;
	}

	private prune(): void {
		for (const [id, poll] of this.polls) if (this.isExpired(poll)) this.polls.delete(id);
	}
}
