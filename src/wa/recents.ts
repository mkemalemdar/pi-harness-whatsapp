/**
 * Recent chats, for picking allowed contacts. Filled from the history
 * WhatsApp sends right after pairing and from messages seen while connected.
 * Only ids, names and times are kept — never message text.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RecentChat } from "../contacts-flow.ts";
import { isGroupJid, isIgnoredJid, isLidJid, isPhoneJid, jidUser, normalizeJid } from "./jid.ts";

const MAX_CHATS = 200;

export interface ChatSighting {
	jid: string;
	/** Phone JID for the same person when `jid` is a LID. */
	altJid?: string;
	name?: string;
	at: number;
}

export class RecentsStore {
	private chats = new Map<string, RecentChat>();
	/** LID digits → phone digits. */
	private readonly lidToPhone = new Map<string, string>();
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly file: string) {}

	load(): void {
		try {
			const data = JSON.parse(readFileSync(this.file, "utf8")) as { chats?: RecentChat[]; lids?: [string, string][] };
			for (const chat of data.chats ?? []) {
				if (typeof chat.id === "string" && typeof chat.lastMessageAt === "number") this.chats.set(chat.id, chat);
			}
			for (const [lid, phone] of data.lids ?? []) this.lidToPhone.set(lid, phone);
		} catch {
			// No recents yet.
		}
	}

	rememberLid(lidJid: string, phoneJid: string): void {
		const lid = jidUser(lidJid);
		const phone = jidUser(phoneJid);
		if (!lid || !phone || !isLidJid(lidJid) || !isPhoneJid(phoneJid)) return;
		this.lidToPhone.set(lid, phone);
		// A chat first seen under its LID can now be listed under the phone number.
		const old = this.chats.get(lid);
		if (old) {
			this.chats.delete(lid);
			const { lid: _hidden, ...rest } = old;
			this.upsert({ ...rest, id: phone });
		}
		this.scheduleSave();
	}

	phoneForLid(lidDigits: string): string | undefined {
		return this.lidToPhone.get(lidDigits);
	}

	/** Records that a chat was active. */
	see(sighting: ChatSighting): void {
		const jid = normalizeJid(sighting.jid);
		if (isIgnoredJid(jid)) return;
		if (sighting.altJid) {
			if (isLidJid(jid)) this.rememberLid(jid, normalizeJid(sighting.altJid));
			else if (isLidJid(sighting.altJid)) this.rememberLid(normalizeJid(sighting.altJid), jid);
		}
		const id = this.idFor(jid);
		if (!id) return;
		const lidOnly = isLidJid(jid) && id === jidUser(jid);
		this.upsert({
			id,
			isGroup: isGroupJid(jid),
			...(lidOnly ? { lid: id } : {}),
			lastMessageAt: sighting.at,
			...(sighting.name ? { name: sighting.name } : {}),
		});
		this.scheduleSave();
	}

	/** The name known for a chat id (phone digits or group JID). */
	nameOf(id: string): string | undefined {
		return this.chats.get(id)?.name;
	}

	/** Most recent first. */
	list(): RecentChat[] {
		return [...this.chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
	}

	flush(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			const data = { chats: this.list().slice(0, MAX_CHATS), lids: [...this.lidToPhone] };
			writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
			renameSync(temporary, this.file);
		} catch {
			// Recents are a convenience; losing them is fine.
		}
	}

	/** Contact id for a chat: phone digits, group JID, or LID digits if the phone is unknown. */
	private idFor(jid: string): string | undefined {
		if (isGroupJid(jid)) return jid;
		const user = jidUser(jid);
		if (!user) return undefined;
		if (isLidJid(jid)) return this.lidToPhone.get(user) ?? user;
		return isPhoneJid(jid) ? user : undefined;
	}

	private upsert(chat: RecentChat): void {
		const existing = this.chats.get(chat.id);
		this.chats.set(chat.id, {
			...existing,
			...chat,
			name: chat.name ?? existing?.name,
			lastMessageAt: Math.max(chat.lastMessageAt, existing?.lastMessageAt ?? 0),
		} as RecentChat);
		if (this.chats.size > MAX_CHATS * 1.5) {
			this.chats = new Map(this.list().slice(0, MAX_CHATS).map((entry) => [entry.id, entry]));
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => this.flush(), 2000);
		this.saveTimer.unref?.();
	}
}
