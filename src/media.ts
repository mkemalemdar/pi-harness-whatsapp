// What incoming media becomes for the model (images, voice notes, files),
// and how replies go out (text, voice note, or both).

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { MediaHandler, PreparedPrompt } from "./bridge.ts";
import { isCodeHeavy, splitForSpeech, textForSpeech } from "./core/format.ts";
import { createLogger } from "./log.ts";
import { replyMode } from "./core/settings.ts";
import { type SettingsStore } from "./settings-store.ts";
import { chooseSpeechLanguage } from "./voice/language.ts";
import { MAX_SPOKEN_CHARS, MAX_VOICE_PARTS, type VoiceService } from "./voice/service.ts";
import type { WhatsAppConnection } from "./wa/connection.ts";
import type { InboundMessage } from "./wa/inbound.ts";
import type { SendQueue } from "./wa/outbound.ts";

const log = createLogger("media");
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Received files are kept this long, then removed. */
export const INBOX_KEEP_MS = 7 * 24 * 60 * 60_000;

/** Deletes received files older than a week. */
export function cleanInbox(dir: string, now = Date.now()): number {
	let removed = 0;
	try {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (now - statSync(path).mtimeMs > INBOX_KEEP_MS) {
				rmSync(path, { force: true });
				removed++;
			}
		}
	} catch {
		// No inbox yet.
	}
	return removed;
}

export interface MediaDeps {
	settings: SettingsStore;
	connection: Pick<WhatsAppConnection, "download" | "presence">;
	queue: SendQueue;
	voice: VoiceService;
	/** Folder where received files are saved for Pi to read. */
	inboxDir: string;
}

/** A file name that is safe to write: no folders, no odd characters. */
export function safeFileName(name: string | undefined, fallbackExt: string): string {
	const base = basename(name ?? "").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	if (!base) return `file-${stamp}${fallbackExt}`;
	const ext = extname(base);
	return `${base.slice(0, base.length - ext.length)}-${stamp}${ext || fallbackExt}`;
}

const EXT_BY_MIME: Record<string, string> = {
	"application/pdf": ".pdf",
	"text/plain": ".txt",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"video/mp4": ".mp4",
};

export class Media implements MediaHandler {
	private readonly deps: MediaDeps;

	constructor(deps: MediaDeps) {
		this.deps = deps;
	}

	async prepare(message: InboundMessage, makeHeader: (voiceTag?: string) => string): Promise<PreparedPrompt> {
		const prepared = await this.prepareMessage(message, makeHeader);
		// A reply to an image: attach that image too, so "what's this?" can be answered.
		if (message.quotedImage && message.kind !== "image") return this.withQuotedImage(message, prepared);
		return prepared;
	}

	private async withQuotedImage(message: InboundMessage, prepared: PreparedPrompt): Promise<PreparedPrompt> {
		try {
			const quoted = {
				key: {
					remoteJid: message.chatJid,
					id: message.quotedId ?? null,
					fromMe: false,
					...(message.quotedAuthorJid ? { participant: message.quotedAuthorJid } : {}),
				},
				message: { imageMessage: message.quotedImage },
			} as unknown as InboundMessage["raw"];
			const data = await this.deps.connection.download(quoted);
			if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return prepared;
			const text = typeof prepared.content === "string" ? prepared.content : prepared.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			const others = typeof prepared.content === "string" ? [] : prepared.content.filter((part) => part.type !== "text");
			return {
				...prepared,
				content: [
					{ type: "text", text: `${text} [the image they replied to is attached]` },
					...others,
					{ type: "image", data: data.toString("base64"), mimeType: message.quotedImage?.mimetype ?? "image/jpeg" },
				],
			};
		} catch (error) {
			log.warn("could not download the replied-to image", error);
			return prepared;
		}
	}

	private async prepareMessage(message: InboundMessage, makeHeader: (voiceTag?: string) => string): Promise<PreparedPrompt> {
		const header = makeHeader();
		const quoted = message.quotedText ? ` (replying to: "${message.quotedText.slice(0, 300)}")` : "";
		switch (message.kind) {
			case "image":
				return this.image(message, header, quoted);
			case "audio":
				return this.audio(message, makeHeader, quoted);
			case "document":
			case "video":
				return this.file(message, header, quoted);
			case "sticker":
				return { content: `${header} (sent a sticker)`, voice: false };
			case "other":
				return { content: `${header} (sent a message type Pi can't read)`, voice: false };
			default:
				return { content: `${header}${quoted} ${message.text}`, voice: false };
		}
	}

	private async image(message: InboundMessage, header: string, quoted: string): Promise<PreparedPrompt> {
		const caption = message.text ? ` ${message.text}` : " (sent an image)";
		try {
			const data = await this.deps.connection.download(message.raw);
			if (data.length > MAX_IMAGE_BYTES) return { content: `${header}${quoted}${caption} [image too large to view]`, voice: false };
			return {
				content: [
					{ type: "text", text: `${header}${quoted}${caption}` },
					{ type: "image", data: data.toString("base64"), mimeType: message.mimeType ?? "image/jpeg" },
				],
				voice: false,
			};
		} catch (error) {
			log.warn("image download failed", error);
			return { content: `${header}${quoted}${caption} [the image could not be downloaded]`, voice: false };
		}
	}

	private async audio(message: InboundMessage, makeHeader: (voiceTag?: string) => string, quoted: string): Promise<PreparedPrompt> {
		void this.deps.connection.presence(message.chatJid, "composing");
		try {
			const problem = await this.deps.voice.unavailable();
			if (problem) throw new Error(problem);
			const missing = this.deps.voice.missingModels().filter((spec) => spec.kind === "stt" || spec.kind === "runtime");
			if (missing.length > 0) {
				const megabytes = missing.reduce((sum, spec) => sum + spec.approxMB, 0);
				await this.deps.queue.sendText(message.chatJid, `⏳ Getting speech recognition ready (one-time download, ~${megabytes} MB)…`);
			}
			const audio = await this.deps.connection.download(message.raw);
			const transcript = await this.deps.voice.transcribe(audio);
			const language = transcript.language;
			log.info(`transcribed ${message.seconds ?? "?"}s voice note in ${transcript.ms}ms (${language ?? "?"})`);
			const text = transcript.text || "(no speech recognized)";
			// The language isn't in the label: the model can see it, and the voice is picked without it.
			return { content: `${makeHeader("voice note")}${quoted} ${text}`, voice: true, ...(language ? { language } : {}) };
		} catch (error) {
			log.error("voice note transcription failed", error);
			const reason = error instanceof Error ? error.message : String(error);
			return { content: `${makeHeader("voice note")}${quoted} [could not be transcribed: ${reason}]`, voice: true };
		}
	}

	private async file(message: InboundMessage, header: string, quoted: string): Promise<PreparedPrompt> {
		const what = message.kind === "video" ? "a video" : "a file";
		try {
			const data = await this.deps.connection.download(message.raw);
			if (data.length > MAX_FILE_BYTES) return { content: `${header}${quoted} (sent ${what} too large to save)`, voice: false };
			mkdirSync(this.deps.inboxDir, { recursive: true, mode: 0o700 });
			const name = safeFileName(message.fileName, EXT_BY_MIME[message.mimeType ?? ""] ?? (message.kind === "video" ? ".mp4" : ".bin"));
			const path = join(this.deps.inboxDir, name);
			writeFileSync(path, data, { mode: 0o600 });
			const caption = message.text ? ` ${message.text}` : "";
			return {
				content: `${header}${quoted}${caption} [sent ${what}: ${message.fileName ?? name} (${message.mimeType ?? "unknown type"}, ${Math.round(data.length / 1024)} KB), saved at ${path}]`,
				voice: false,
			};
		} catch (error) {
			log.warn("file download failed", error);
			return { content: `${header}${quoted} (sent ${what} that could not be downloaded)`, voice: false };
		}
	}

	async deliverReply(chatJid: string, text: string, context: { voiceIn: boolean; language?: string }): Promise<void> {
		const settings = this.deps.settings.get();
		const mode = replyMode(settings);
		const wantVoice = mode === "voice" || mode === "voice+text" || (mode === "mirror" && context.voiceIn);
		if (!wantVoice) {
			await this.deps.queue.sendText(chatJid, text);
			return;
		}

		// Nothing to say when there are no letters or digits (e.g. an answer that is just "👍").
		const prose = textForSpeech(text);
		const spoken = /[\p{L}\p{N}]/u.test(prose) ? prose : "";
		const parts = splitForSpeech(spoken, MAX_SPOKEN_CHARS);
		const tooLong = parts.length > MAX_VOICE_PARTS;
		// Text too only when the voice notes can't carry everything: code, or more than ~10 minutes.
		const alsoText = mode === "voice+text" || isCodeHeavy(text) || tooLong || !spoken;
		if (alsoText) await this.deps.queue.sendText(chatJid, text);
		if (!spoken) return;

		const language = chooseSpeechLanguage(text, {
			enabled: settings.languages,
			replyLanguage: settings.replyLanguage,
			...(context.language ? { incoming: context.language } : {}),
		});
		const toSpeak = tooLong ? parts.slice(0, MAX_VOICE_PARTS) : parts;
		if (tooLong) toSpeak[toSpeak.length - 1] += " … The rest is in the text message.";
		void this.deps.connection.presence(chatJid, "recording");
		try {
			const problem = await this.deps.voice.unavailable();
			if (problem) throw new Error(problem);
			const missing = this.deps.voice.missingModels().filter((spec) => spec.kind === "tts" || spec.kind === "runtime");
			if (missing.length > 0) {
				const megabytes = missing.reduce((sum, spec) => sum + spec.approxMB, 0);
				await this.deps.queue.sendText(chatJid, `⏳ Getting the voice ready (one-time download, ~${megabytes} MB)…`);
			}
			// Long answers go out as several voice notes, in order.
			for (const part of toSpeak) {
				const note = await this.deps.voice.speak(part, language);
				await this.deps.queue.enqueue(chatJid, { audio: note.audio, ptt: true, seconds: note.seconds, mimetype: "audio/ogg; codecs=opus" });
			}
		} catch (error) {
			log.error("voice reply failed", error);
			if (!alsoText) await this.deps.queue.sendText(chatJid, text);
			await this.deps.queue.sendText(chatJid, `(couldn't make a voice note: ${error instanceof Error ? error.message : String(error)})`);
		} finally {
			void this.deps.connection.presence(chatJid, "paused");
		}
	}
}
