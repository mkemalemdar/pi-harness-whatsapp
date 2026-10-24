// Everything we send goes through one queue, in order, with retries. Sending
// waits a little for a dropped connection to come back instead of failing.

import type { AnyMessageContent, WAMessageKey } from "baileys";
import { markdownToWhatsApp, splitMessage } from "../core/format.ts";
import { createLogger } from "../log.ts";
import type { SendResult } from "./connection.ts";
import { isGroupJid } from "./jid.ts";

const log = createLogger("outbound");

export interface Sender {
	isOpen(): boolean;
	send(jid: string, content: AnyMessageContent): Promise<SendResult>;
}

export interface QueueOptions {
	/** How long to wait for the connection to come back before giving up. */
	offlineWaitMs?: number;
	retries?: number;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SendQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly offlineWaitMs: number;
	private readonly retries: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private closed = false;

	private readonly sender: Sender;

	constructor(
		sender: Sender,
		options: QueueOptions = {},
	) {
		this.sender = sender;
		this.offlineWaitMs = options.offlineWaitMs ?? 30_000;
		this.retries = options.retries ?? 3;
		this.sleep = options.sleep ?? defaultSleep;
	}

	/** Drops queued work (used when WhatsApp is turned off). */
	close(): void {
		this.closed = true;
	}

	reopen(): void {
		this.closed = false;
	}

	/** Sends one message after everything queued before it. Resolves with the result, or undefined on failure. */
	enqueue(jid: string, content: AnyMessageContent): Promise<SendResult | undefined> {
		const job = this.tail.then(() => this.sendWithRetry(jid, content));
		this.tail = job.catch(() => undefined);
		return job;
	}

	/** Markdown text → WhatsApp formatting, split into as many messages as needed. Returns the last key. */
	async sendText(jid: string, markdown: string): Promise<WAMessageKey | undefined> {
		let last: WAMessageKey | undefined;
		for (const chunk of splitMessage(markdownToWhatsApp(markdown))) {
			const result = await this.enqueue(jid, { text: chunk });
			if (result) last = result.key;
		}
		return last;
	}

	/** Replaces the text of a message we sent earlier. */
	async edit(jid: string, key: WAMessageKey, text: string): Promise<boolean> {
		const result = await this.enqueue(jid, { text, edit: key });
		return !!result;
	}

	private async sendWithRetry(jid: string, content: AnyMessageContent): Promise<SendResult | undefined> {
		// Group sends can fail a few times while encryption sessions are set up.
		const attempts = isGroupJid(jid) ? this.retries + 2 : this.retries;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			if (this.closed) return undefined;
			if (!(await this.waitUntilOpen())) {
				log.warn("dropping message: WhatsApp stayed offline");
				return undefined;
			}
			try {
				return await this.sender.send(jid, content);
			} catch (error) {
				log.warn(`send attempt ${attempt}/${attempts} failed`, error);
				if (attempt < attempts) await this.sleep(1000 * 2 ** (attempt - 1));
			}
		}
		return undefined;
	}

	private async waitUntilOpen(): Promise<boolean> {
		const deadline = Date.now() + this.offlineWaitMs;
		while (!this.sender.isOpen()) {
			if (this.closed || Date.now() >= deadline) return false;
			await this.sleep(500);
		}
		return true;
	}
}
