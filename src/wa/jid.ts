// Small helpers for WhatsApp ids ("JIDs"):
//   person (phone):  905551234567@s.whatsapp.net   (may carry a device suffix, ":12")
//   person (hidden): 100000000000001@lid
//   group:           120363000000000001@g.us

export const isGroupJid = (jid: string | undefined | null): boolean => !!jid?.endsWith("@g.us");
export const isLidJid = (jid: string | undefined | null): boolean => !!jid?.endsWith("@lid");
export const isPhoneJid = (jid: string | undefined | null): boolean => !!jid?.endsWith("@s.whatsapp.net");

/** The user part without device suffix: "905551234567:3@s.whatsapp.net" → "905551234567". */
export function jidUser(jid: string | undefined | null): string | undefined {
	if (!jid) return undefined;
	const at = jid.indexOf("@");
	const user = at >= 0 ? jid.slice(0, at) : jid;
	return user.split(":")[0] || undefined;
}

export function phoneJid(digits: string): string {
	return `${digits}@s.whatsapp.net`;
}

/** Where to send to an allowed contact: the group, the hidden id when that's all we have, or the phone number. */
export function contactJid(contact: { id: string; lid?: string }): string {
	if (isGroupJid(contact.id)) return contact.id;
	return contact.lid === contact.id ? `${contact.id}@lid` : phoneJid(contact.id);
}

/** Drops the device suffix so ids compare equal: "x:3@lid" → "x@lid". */
export function normalizeJid(jid: string): string {
	const at = jid.indexOf("@");
	if (at < 0) return jid;
	return `${jid.slice(0, at).split(":")[0]}${jid.slice(at)}`;
}

/** Chats the extension never handles: status updates, channels, broadcasts. */
export function isIgnoredJid(jid: string | undefined | null): boolean {
	if (!jid) return true;
	return jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}
