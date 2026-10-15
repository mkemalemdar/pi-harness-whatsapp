/**
 * Turns raw Baileys messages into one simple shape, decides who may reach Pi,
 * and remembers which message ids were already handled.
 */

import { extractMessageContent, type proto, toNumber, type WAMessage } from "baileys";
import type { Contact } from "../settings.ts";
import { isGroupJid, isIgnoredJid, isLidJid, isPhoneJid, jidUser, normalizeJid } from "./jid.ts";

export type InboundKind =
	| "text"
	| "image"
	| "audio"
	| "video"
	| "document"
	| "sticker"
	| "location"
	| "contact"
	| "poll-vote"
	| "other";

export interface InboundMessage {
	id: string;
	/** The chat: a person or a group. */
	chatJid: string;
	/** WhatsApp's alternative id for the chat (phone ↔ LID), when it sends one. */
	chatAltJid?: string;
	/** Who wrote it: the participant in groups, the chat itself otherwise. */
	senderJid: string;
	senderAltJid?: string;
	isGroup: boolean;
	fromMe: boolean;
	pushName?: string;
	/** Milliseconds since epoch. */
	timestamp: number;
	kind: InboundKind;
	/** Text, or the caption of media. */
	text: string;
	/** Text of the message this one replies to, if any. */
	quotedText?: string;
	/** Id and author of the message this one replies to. */
	quotedId?: string;
	quotedAuthorJid?: string;
	/** The image this message replies to (so it can be downloaded), if any. */
	quotedImage?: proto.Message.IImageMessage;
	/** People @mentioned in the text or caption. */
	mentionedJids?: string[];
	mimeType?: string;
	fileName?: string;
	/** Duration of audio/video in seconds. */
	seconds?: number;
	/** Set for poll votes. */
	pollUpdate?: proto.Message.IPollUpdateMessage;
	raw: WAMessage;
}

/** Reply and mention details; WhatsApp puts them on whichever message type was sent (text or a caption). */
function contextOf(content: proto.IMessage): proto.IContextInfo | undefined {
	return (
		content.extendedTextMessage?.contextInfo ??
		content.imageMessage?.contextInfo ??
		content.videoMessage?.contextInfo ??
		content.audioMessage?.contextInfo ??
		content.documentMessage?.contextInfo ??
		content.stickerMessage?.contextInfo ??
		undefined
	);
}

function quoteDetails(info: proto.IContextInfo | undefined): Partial<InboundMessage> {
	if (!info) return {};
	const quotedImage = info.quotedMessage ? extractMessageContent(info.quotedMessage)?.imageMessage : undefined;
	const mentions = (info.mentionedJid ?? []).filter((jid): jid is string => !!jid).map(normalizeJid);
	return {
		...(info.stanzaId ? { quotedId: info.stanzaId } : {}),
		...(info.participant ? { quotedAuthorJid: normalizeJid(info.participant) } : {}),
		...(quotedImage ? { quotedImage } : {}),
		...(mentions.length > 0 ? { mentionedJids: mentions } : {}),
	};
}

function quotedTextOf(info: proto.IContextInfo | undefined): string | undefined {
	const quoted = info?.quotedMessage;
	if (!quoted) return undefined;
	const inner = extractMessageContent(quoted);
	return (
		inner?.conversation ??
		inner?.extendedTextMessage?.text ??
		inner?.imageMessage?.caption ??
		inner?.videoMessage?.caption ??
		inner?.documentMessage?.caption ??
		undefined
	) || undefined;
}

/** Returns undefined for things that are not user messages (receipts, edits, deletions, reactions…). */
export function parseMessage(raw: WAMessage): InboundMessage | undefined {
	const key = raw.key;
	const chatJid = key.remoteJid ? normalizeJid(key.remoteJid) : undefined;
	if (!chatJid || !key.id || isIgnoredJid(chatJid)) return undefined;
	const content = extractMessageContent(raw.message);
	const onlyKeyDistribution = !!content?.senderKeyDistributionMessage && Object.keys(content).length === 1;
	if (!content || content.protocolMessage || content.reactionMessage || onlyKeyDistribution) {
		return undefined;
	}

	const isGroup = isGroupJid(chatJid);
	const senderJid = normalizeJid(isGroup ? (key.participant ?? "") : chatJid);
	const senderAltRaw = isGroup ? key.participantAlt : key.remoteJidAlt;
	const timestampSeconds = toNumber(raw.messageTimestamp as number | null | undefined);
	const base = {
		id: key.id,
		chatJid,
		...(key.remoteJidAlt ? { chatAltJid: normalizeJid(key.remoteJidAlt) } : {}),
		senderJid,
		...(senderAltRaw ? { senderAltJid: normalizeJid(senderAltRaw) } : {}),
		isGroup,
		fromMe: !!key.fromMe,
		...(raw.pushName ? { pushName: raw.pushName } : {}),
		timestamp: timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now(),
		raw,
	};
	const info = contextOf(content);
	const quotedText = quotedTextOf(info);
	const withQuote = { ...(quotedText ? { quotedText } : {}), ...quoteDetails(info) };

	if (content.conversation != null || content.extendedTextMessage) {
		return { ...base, ...withQuote, kind: "text", text: content.conversation ?? content.extendedTextMessage?.text ?? "" };
	}
	if (content.imageMessage) {
		const image = content.imageMessage;
		return { ...base, ...withQuote, kind: "image", text: image.caption ?? "", mimeType: image.mimetype ?? "image/jpeg" };
	}
	if (content.audioMessage) {
		const audio = content.audioMessage;
		return {
			...base,
			...withQuote,
			kind: "audio",
			text: "",
			mimeType: audio.mimetype ?? "audio/ogg",
			...(audio.seconds ? { seconds: audio.seconds } : {}),
		};
	}
	if (content.videoMessage) {
		const video = content.videoMessage;
		return {
			...base,
			...withQuote,
			kind: "video",
			text: video.caption ?? "",
			mimeType: video.mimetype ?? "video/mp4",
			...(video.seconds ? { seconds: video.seconds } : {}),
		};
	}
	if (content.documentMessage) {
		const document = content.documentMessage;
		return {
			...base,
			...withQuote,
			kind: "document",
			text: document.caption ?? "",
			mimeType: document.mimetype ?? "application/octet-stream",
			...(document.fileName ? { fileName: document.fileName } : {}),
		};
	}
	if (content.stickerMessage) return { ...base, ...withQuote, kind: "sticker", text: "" };
	if (content.locationMessage || content.liveLocationMessage) {
		const location = content.locationMessage ?? content.liveLocationMessage!;
		const name = "name" in location && location.name ? ` (${location.name})` : "";
		return { ...base, kind: "location", text: `📍 ${location.degreesLatitude}, ${location.degreesLongitude}${name}` };
	}
	if (content.contactMessage || content.contactsArrayMessage) {
		const names = content.contactMessage
			? [content.contactMessage.displayName]
			: (content.contactsArrayMessage?.contacts ?? []).map((contact) => contact.displayName);
		return { ...base, kind: "contact", text: `👤 Shared contact: ${names.filter(Boolean).join(", ")}` };
	}
	if (content.pollUpdateMessage) return { ...base, kind: "poll-vote", text: "", pollUpdate: content.pollUpdateMessage };
	return { ...base, kind: "other", text: "" };
}

/**
 * Whether a group message is meant for Pi: it @mentions this account, or it
 * replies to one of Pi's messages (by author, or by an id Pi sent).
 */
export function addressedToSelf(
	message: InboundMessage,
	self: SelfIds,
	isOwnMessage: (id: string) => boolean,
): { mentioned: boolean; repliedTo: boolean } {
	const isSelf = (jid: string | undefined) => {
		const user = jidUser(jid);
		return !!user && (user === self.phone || user === self.lid);
	};
	return {
		mentioned: (message.mentionedJids ?? []).some(isSelf),
		repliedTo: isSelf(message.quotedAuthorJid) || (!!message.quotedId && isOwnMessage(message.quotedId)),
	};
}

export interface SelfIds {
	/** Digits of this account's phone number. */
	phone?: string;
	/** Digits of this account's LID. */
	lid?: string;
}

export interface Access {
	allowed: boolean;
	/** Allowed contact entry the message matched (the group for group chats). */
	contact?: Contact;
	/** The sender is the owner (or this account itself, in the "message yourself" chat). */
	isOwner: boolean;
	/** A phone-number contact was matched and WhatsApp revealed its LID: remember it. */
	learnedLid?: { contactId: string; lid: string };
	/** Short reason for logs when not allowed. */
	reason?: string;
}

/** Phone digits and LID digits that identify the sender. */
export function senderIdentity(message: Pick<InboundMessage, "senderJid" | "senderAltJid">): { phone?: string; lid?: string } {
	const identity: { phone?: string; lid?: string } = {};
	for (const jid of [message.senderJid, message.senderAltJid]) {
		if (isPhoneJid(jid)) identity.phone ??= jidUser(jid);
		else if (isLidJid(jid)) identity.lid ??= jidUser(jid);
	}
	return identity;
}

function matchPerson(contacts: readonly Contact[], phone?: string, lid?: string): Contact | undefined {
	return contacts.find(
		(contact) => !isGroupJid(contact.id) && ((phone && contact.id === phone) || (lid && contact.lid === lid)),
	);
}

export function checkAccess(message: InboundMessage, contacts: readonly Contact[], self: SelfIds): Access {
	const { phone, lid } = senderIdentity(message);

	if (message.fromMe) {
		// Only the "message yourself" chat counts; everything else we send is outgoing.
		const chatUser = jidUser(message.chatJid);
		const altUser = jidUser(message.chatAltJid);
		const selfChat =
			!message.isGroup &&
			[chatUser, altUser].some((user) => !!user && (user === self.phone || user === self.lid));
		return selfChat ? { allowed: true, isOwner: true } : { allowed: false, isOwner: false, reason: "own message" };
	}

	const owner = contacts.find((contact) => contact.owner);
	const senderIsOwner = !!owner && ((phone && owner.id === phone) || (lid && owner.lid === lid)) ? true : false;

	if (message.isGroup) {
		const group = contacts.find((contact) => contact.id === message.chatJid);
		if (!group) return { allowed: false, isOwner: false, reason: "group not allowed" };
		return { allowed: true, contact: group, isOwner: senderIsOwner };
	}

	const contact = matchPerson(contacts, phone, lid);
	if (!contact) return { allowed: false, isOwner: false, reason: "contact not allowed" };
	const access: Access = { allowed: true, contact, isOwner: !!contact.owner };
	if (lid && contact.id === phone && contact.lid !== lid) access.learnedLid = { contactId: contact.id, lid };
	return access;
}

/** Remembers recently handled message ids (WhatsApp can deliver a message twice around reconnects). */
export class SeenIds {
	private readonly ids = new Set<string>();

	constructor(private readonly capacity = 2000) {}

	/** True the first time an id is seen. */
	add(id: string): boolean {
		if (this.ids.has(id)) return false;
		this.ids.add(id);
		if (this.ids.size > this.capacity) {
			const oldest = this.ids.values().next().value;
			if (oldest !== undefined) this.ids.delete(oldest);
		}
		return true;
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}
}
