// Dialog flow for "Allowed chats": pick from recent chats, add a number,
// rename, remove, and mark the owner.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Contact, normalizeContactId, type SettingsStore } from "./settings.ts";

export interface RecentChat {
	id: string;
	name?: string;
	lastMessageAt: number;
	isGroup: boolean;
	/** Set when WhatsApp only revealed the hidden id (LID), not the phone number. */
	lid?: string;
}

const BACK = "← Back";
const ADD_RECENT = "+ Pick from recent chats";
const ADD_NUMBER = "+ Add number manually";

export function contactLabel(contact: Pick<Contact, "id" | "name" | "lid">): string {
	const address = contact.id.endsWith("@g.us")
		? "group"
		: contact.lid === contact.id
			? "number hidden by WhatsApp"
			: `+${contact.id}`;
	return contact.name ? `${contact.name} (${address})` : address;
}

/** Makes labels unique ("group", "group (2)"), so picking one picks the right chat. */
function distinct(labels: string[]): string[] {
	const seen = new Map<string, number>();
	return labels.map((label) => {
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return count === 1 ? label : `${label} (${count})`;
	});
}

export async function contactsFlow(
	ctx: ExtensionContext,
	store: SettingsStore,
	recentChats: () => RecentChat[],
): Promise<void> {
	for (;;) {
		const contacts = store.get().contacts;
		const rows = distinct(contacts.map((contact) => `${contact.owner ? "★ " : "  "}${contactLabel(contact)}`));
		const choice = await ctx.ui.select("Allowed chats (★ = owner)", [...rows, ADD_RECENT, ADD_NUMBER, BACK]);
		if (choice === undefined || choice === BACK) return;

		if (choice === ADD_RECENT) {
			await addFromRecents(ctx, store, recentChats());
			continue;
		}
		if (choice === ADD_NUMBER) {
			await addManually(ctx, store);
			continue;
		}
		const contact = contacts[rows.indexOf(choice)];
		if (contact) await editContact(ctx, store, contact);
	}
}

async function addFromRecents(ctx: ExtensionContext, store: SettingsStore, chats: RecentChat[]): Promise<void> {
	const allowed = new Set(store.get().contacts.map((contact) => contact.id));
	const candidates = chats.filter((chat) => !allowed.has(chat.id)).slice(0, 30);
	if (candidates.length === 0) {
		ctx.ui.notify("No recent chats to add yet. Connect WhatsApp and let someone message this number.", "info");
		return;
	}
	const labels = distinct(candidates.map((chat) => `${chat.isGroup ? "👥 " : ""}${contactLabel(chat)}`));
	const picked = await ctx.ui.select("Allow which chat?", [...labels, BACK]);
	const chat = picked === undefined ? undefined : candidates[labels.indexOf(picked)];
	if (!chat) return;
	store.update((draft) => {
		draft.contacts.push({
			id: chat.id,
			...(chat.name ? { name: chat.name } : {}),
			...(chat.lid ? { lid: chat.lid } : {}),
			...(draft.contacts.length === 0 && !chat.isGroup ? { owner: true } : {}),
		});
	});
	ctx.ui.notify(`Allowed ${contactLabel(chat)}`, "info");
}

async function addManually(ctx: ExtensionContext, store: SettingsStore): Promise<void> {
	const raw = await ctx.ui.input("Phone number with country code", "+90 555 123 45 67");
	if (raw === undefined || !raw.trim()) return;
	const id = normalizeContactId(raw);
	if (!id) {
		ctx.ui.notify("That doesn't look like a phone number (6–15 digits, with country code).", "error");
		return;
	}
	if (store.get().contacts.some((contact) => contact.id === id)) {
		ctx.ui.notify("That number is already allowed.", "info");
		return;
	}
	const name = (await ctx.ui.input("Name (optional)", ""))?.trim();
	const isFirst = store.get().contacts.length === 0;
	store.update((draft) => {
		draft.contacts.push({ id, ...(name ? { name } : {}), ...(isFirst ? { owner: true } : {}) });
	});
	ctx.ui.notify(`Allowed ${contactLabel({ id, name })}${isFirst ? " as owner" : ""}`, "info");
}

async function editContact(ctx: ExtensionContext, store: SettingsStore, contact: Contact): Promise<void> {
	// The owner is a person: groups can't be owner.
	const makeOwner = contact.owner || contact.id.endsWith("@g.us") ? undefined : "★ Make owner";
	const options = [makeOwner, "Rename", "Remove", BACK].filter((option): option is string => !!option);
	const action = await ctx.ui.select(contactLabel(contact), options);
	if (action === makeOwner) {
		store.update((draft) => {
			for (const entry of draft.contacts) entry.owner = entry.id === contact.id ? true : undefined;
		});
	} else if (action === "Rename") {
		const name = await ctx.ui.input("New name", contact.name ?? "");
		if (name === undefined) return;
		store.update((draft) => {
			const entry = draft.contacts.find((existing) => existing.id === contact.id);
			if (entry) entry.name = name.trim() || undefined;
		});
	} else if (action === "Remove") {
		const sure = await ctx.ui.confirm("Remove contact?", `${contactLabel(contact)} will no longer reach Pi.`);
		if (!sure) return;
		store.update((draft) => {
			draft.contacts = draft.contacts.filter((existing) => existing.id !== contact.id);
		});
	}
}
