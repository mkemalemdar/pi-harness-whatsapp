/**
 * What incoming media becomes for the model (images, voice notes, files),
 * and how replies go out (text, voice note, or both).
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { MediaHandler, PreparedPrompt } from "./bridge.ts";
import { isCodeHeavy, textForSpeech } from "./format.ts";
import { languageLabel } from "./languages.ts";
import { createLogger } from "./log.ts";
import type { SettingsStore } from "./settings.ts";
import { chooseSpeechLanguage } from "./voice/language.ts";
import { MAX_SPOKEN_CHARS, type VoiceService } from "./voice/service.ts";
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
	constructor(private readonly deps: MediaDeps) {}

	async prepare(message: InboundMessage, header: string): Promise<PreparedPrompt> {
		const quoted = message.quotedText ? ` (replying to: "${message.quotedText.slice(0, 300)}")` : "";
		switch (message.kind) {
			case "image":
				return this.image(message, header, quoted);
			case "audio":
				return this.audio(message, header, quoted);
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

	private async audio(message: InboundMessage, header: string, quoted: string): Promise<PreparedPrompt> {
		void this.deps.connection.presence(message.chatJid, "composing");
		try {
			const missing = this.deps.voice.missingModels().filter((spec) => spec.kind === "stt");
			if (missing.length > 0) {
				await this.deps.queue.sendText(
					message.chatJid,
					`⏳ Getting the speech model ready (one-time download, ~${missing[0]!.approxMB} MB)…`,
				);
			}
			const audio = await this.deps.connection.download(message.raw);
			const transcript = await this.deps.voice.transcribe(audio);
			const language = transcript.language;
			const tag = language ? `[voice note · ${languageLabel(language).replace(/ \(.*\)$/, "")}]` : "[voice note]";
			log.info(`transcribed ${message.seconds ?? "?"}s voice note in ${transcript.ms}ms (${language ?? "?"})`);
			const text = transcript.text || "(no speech recognized)";
			return { content: `${header}${quoted} ${tag} ${text}`, voice: true, ...(language ? { language } : {}) };
		} catch (error) {
			log.error("voice note transcription failed", error);
			const reason = error instanceof Error ? error.message : String(error);
			return { content: `${header}${quoted} [voice note — could not be transcribed: ${reason}]`, voice: true };
		}
	}

	private async file(message: InboundMessage, header: string, quoted: string): Promise<PreparedPrompt> {
		const what = message.kind === "video" ? "a video" : "a file";
		try {
			const data = await this.deps.connection.download(message.raw);
			if (data.length > MAX_FILE_BYTES) return { content: `${header}${quoted} (sent ${what} too large to save)`, voice: false };
			mkdirSync(this.deps.inboxDir, { recursive: true });
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
		const mode = settings.voiceMode;
		const wantVoice = mode === "voice" || mode === "voice+text" || (mode === "mirror" && context.voiceIn);
		if (!wantVoice) {
			await this.deps.queue.sendText(chatJid, text);
			return;
		}

		const spoken = textForSpeech(text);
		const tooLong = spoken.length > MAX_SPOKEN_CHARS;
		// Code or very long answers don't survive as audio alone: send the text too.
		const alsoText = mode === "voice+text" || isCodeHeavy(text) || tooLong || !spoken;
		if (alsoText) await this.deps.queue.sendText(chatJid, text);
		if (!spoken) return;

		const language = chooseSpeechLanguage(text, {
			enabled: settings.languages,
			replyLanguage: settings.replyLanguage,
			...(context.language ? { incoming: context.language } : {}),
		});
		const toSpeak = tooLong ? `${spoken.slice(0, MAX_SPOKEN_CHARS).replace(/\s+\S*$/, "")}… The rest is in the text message.` : spoken;
		void this.deps.connection.presence(chatJid, "recording");
		try {
			const note = await this.deps.voice.speak(toSpeak, language);
			await this.deps.queue.enqueue(chatJid, { audio: note.audio, ptt: true, seconds: note.seconds, mimetype: "audio/ogg; codecs=opus" });
		} catch (error) {
			log.error("voice reply failed", error);
			if (!alsoText) await this.deps.queue.sendText(chatJid, text);
			await this.deps.queue.sendText(chatJid, `(couldn't make a voice note: ${error instanceof Error ? error.message : String(error)})`);
		} finally {
			void this.deps.connection.presence(chatJid, "paused");
		}
	}
}
