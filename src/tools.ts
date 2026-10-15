/**
 * Optional tools for the model while WhatsApp is on. Normal replies never
 * need them (they're sent automatically); these are for extras like "send me
 * that screenshot". They only reach allowed contacts.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { contactLabel } from "./contacts-flow.ts";
import type { Controller } from "./controller.ts";
import { createLogger } from "./log.ts";
import { chooseSpeechLanguage } from "./voice/language.ts";
import { contactJid } from "./wa/jid.ts";

const log = createLogger("tools");
const MAX_SEND_BYTES = 60 * 1024 * 1024;

export const TOOL_NAMES = ["whatsapp_send_image", "whatsapp_send_file", "whatsapp_send_voice"] as const;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".zip": "application/zip",
	".html": "text/html",
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
};

export function mimeFor(path: string): string {
	return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Where a tool call sends to: an allowed contact named in `to`, the current WhatsApp chat, or the owner. */
export function resolveRecipient(controller: Controller, to: string | undefined): string {
	const contacts = controller.settings.get().contacts;
	if (to?.trim()) {
		const needle = to.trim().toLowerCase().replace(/^\+/, "");
		const match = contacts.find(
			(contact) => contact.id === needle || contact.name?.toLowerCase() === needle || contact.lid === needle,
		);
		if (!match) throw new Error(`"${to}" is not an allowed WhatsApp contact. Allowed: ${contacts.map(contactLabel).join(", ") || "none"}`);
		return contactJid(match);
	}
	const active = controller.bridge.activeChat();
	if (active) return active;
	const owner = contacts.find((contact) => contact.owner);
	if (owner) return contactJid(owner);
	throw new Error("No WhatsApp chat to send to: nobody is allowed yet.");
}

function readLocalFile(cwd: string, path: string): { data: Buffer; full: string } {
	const full = isAbsolute(path) ? path : resolve(cwd, path);
	const size = statSync(full).size;
	if (size > MAX_SEND_BYTES) throw new Error(`${path} is too large for WhatsApp (${Math.round(size / 1e6)} MB)`);
	return { data: readFileSync(full), full };
}

function ensureConnected(controller: Controller): void {
	if (!controller.isEnabled()) throw new Error("WhatsApp is off.");
	if (!controller.connection.isOpen()) throw new Error(`WhatsApp is not connected (${controller.connectionLabel()}).`);
}

const recipientParam = Type.Optional(
	Type.String({ description: "Allowed contact name or number. Default: the chat you are answering (or the owner)." }),
);

export function registerTools(pi: ExtensionAPI, controller: Controller): void {
	pi.registerTool(
		defineTool({
			name: "whatsapp_send_image",
			label: "WhatsApp: send image",
			description: "Send an image file (e.g. a screenshot) to WhatsApp. Not needed for normal replies, which are sent automatically.",
			promptSnippet: "whatsapp_send_image(path, caption?, to?) - send an image file to the WhatsApp chat",
			parameters: Type.Object({
				path: Type.String({ description: "Path to a PNG/JPEG/WebP/GIF file" }),
				caption: Type.Optional(Type.String()),
				to: recipientParam,
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				ensureConnected(controller);
				const jid = resolveRecipient(controller, params.to);
				const { data, full } = readLocalFile(ctx.cwd, params.path);
				const result = await controller.queue.enqueue(jid, {
					image: data,
					mimetype: mimeFor(full),
					...(params.caption ? { caption: params.caption } : {}),
				});
				if (!result) throw new Error("WhatsApp did not accept the image (see the log).");
				log.info(`sent image ${basename(full)}`);
				return { content: [{ type: "text", text: `Sent ${basename(full)} to WhatsApp.` }], details: undefined };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "whatsapp_send_file",
			label: "WhatsApp: send file",
			description: "Send any file (PDF, text, zip…) to WhatsApp as a document. Not needed for normal replies.",
			promptSnippet: "whatsapp_send_file(path, caption?, to?) - send a file to the WhatsApp chat as a document",
			parameters: Type.Object({
				path: Type.String({ description: "Path to the file" }),
				caption: Type.Optional(Type.String()),
				to: recipientParam,
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				ensureConnected(controller);
				const jid = resolveRecipient(controller, params.to);
				const { data, full } = readLocalFile(ctx.cwd, params.path);
				const result = await controller.queue.enqueue(jid, {
					document: data,
					mimetype: mimeFor(full),
					fileName: basename(full),
					...(params.caption ? { caption: params.caption } : {}),
				});
				if (!result) throw new Error("WhatsApp did not accept the file (see the log).");
				log.info(`sent file ${basename(full)}`);
				return { content: [{ type: "text", text: `Sent ${basename(full)} to WhatsApp.` }], details: undefined };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "whatsapp_send_voice",
			label: "WhatsApp: send voice note",
			description: "Speak a short text as a WhatsApp voice note (in addition to the automatic reply).",
			promptSnippet: "whatsapp_send_voice(text, to?) - send a spoken voice note to the WhatsApp chat",
			parameters: Type.Object({
				text: Type.String({ description: "What to say (plain text, no code)" }),
				to: recipientParam,
			}),
			async execute(_id, params) {
				ensureConnected(controller);
				const jid = resolveRecipient(controller, params.to);
				const settings = controller.settings.get();
				const language = chooseSpeechLanguage(params.text, { enabled: settings.languages, replyLanguage: settings.replyLanguage });
				const note = await controller.voice.speak(params.text, language);
				const result = await controller.queue.enqueue(jid, {
					audio: note.audio,
					ptt: true,
					seconds: note.seconds,
					mimetype: "audio/ogg; codecs=opus",
				});
				if (!result) throw new Error("WhatsApp did not accept the voice note (see the log).");
				return { content: [{ type: "text", text: `Sent a ${note.seconds}s voice note.` }], details: undefined };
			},
		}),
	);
}

/** Shows the tools only while WhatsApp is on, so the model doesn't see them otherwise. */
export function setToolsActive(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, on: boolean): void {
	const ours = new Set<string>(TOOL_NAMES);
	const current = pi.getActiveTools();
	const next = on ? [...new Set([...current, ...TOOL_NAMES])] : current.filter((name) => !ours.has(name));
	if (next.length !== current.length) pi.setActiveTools(next);
}
