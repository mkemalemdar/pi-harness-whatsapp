import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyMessageContent } from "baileys";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Media, safeFileName } from "../src/media.ts";
import { addLanguage, SettingsStore } from "../src/settings.ts";
import { decodeToSamples, encodeVoiceNote } from "../src/voice/audio.ts";
import { SpeechEngine } from "../src/voice/engine.ts";
import { chooseSpeechLanguage, detectLanguage } from "../src/voice/language.ts";
import { ModelStore, RUNTIME_SPEC, SUPERTONIC_SPEC, WHISPER_SPEC } from "../src/voice/models.ts";
import { chunkText } from "../src/voice/supertonic.ts";
import type { VoiceService } from "../src/voice/service.ts";
import { SendQueue } from "../src/wa/outbound.ts";

describe("language choice", () => {
	const both = ["en", "tr"];
	it("detects Turkish and English among the enabled languages", () => {
		assert.equal(detectLanguage("Testleri çalıştırdım ve hepsi geçti, başka ne yapayım?", both), "tr");
		assert.equal(detectLanguage("I ran the tests and they all passed, what next?", both), "en");
		assert.equal(detectLanguage("ok", both), undefined);
		assert.equal(detectLanguage("anything", ["tr"]), "tr");
		// Finnish and Swedish need the full language detector (franc-min doesn't know Finnish).
		assert.equal(detectLanguage("Hei, tänään on kaunis päivä ja menemme kauppaan ostamaan ruokaa.", ["en", "fi", "sv"]), "fi");
		assert.equal(detectLanguage("Idag är det en vacker dag och vi ska handla mat i affären.", ["en", "fi", "sv"]), "sv");
	});

	it("prefers a fixed reply language, then the text, then the user's language, then the default", () => {
		assert.equal(chooseSpeechLanguage("Hello there, how are you doing today?", { enabled: both, replyLanguage: "tr" }), "tr");
		assert.equal(chooseSpeechLanguage("Merhaba, bugün nasılsın, her şey yolunda mı?", { enabled: both, replyLanguage: "mirror" }), "tr");
		assert.equal(chooseSpeechLanguage("ok", { enabled: both, replyLanguage: "mirror", incoming: "tr" }), "tr");
		assert.equal(chooseSpeechLanguage("ok", { enabled: both, replyLanguage: "mirror", incoming: "de" }), "en");
	});
});

describe("chunkText", () => {
	it("keeps sentences together and cuts over-long ones at commas or spaces", () => {
		assert.deepEqual(chunkText("One. Two.\n\nThree.", 300), ["One. Two.", "Three."]);
		const chunks = chunkText(`${"alpha beta, ".repeat(60)}end`, 300);
		assert.ok(chunks.length > 2);
		assert.equal(chunks.every((chunk) => chunk.length <= 300), true);
		assert.equal(chunks.join(" ").replace(/\s+/g, " "), `${"alpha beta, ".repeat(60)}end`.replace(/\s+/g, " "));
	});
});

describe("safeFileName", () => {
	it("strips folders and odd characters and keeps the extension", () => {
		assert.match(safeFileName("../../etc/pass wd.pdf", ".bin"), /^pass wd-[\dT-]+Z\.pdf$/);
		assert.match(safeFileName(undefined, ".txt"), /^file-.*\.txt$/);
		assert.match(safeFileName("we$ird;name", ".bin"), /^we_ird_name-.*\.bin$/);
	});
});

class FakeVoice {
	spoken: Array<{ text: string; language: string }> = [];
	fail = false;
	async speak(text: string, language: string) {
		if (this.fail) throw new Error("no voice");
		this.spoken.push({ text, language });
		return { audio: Buffer.from("ogg"), seconds: 2 };
	}
	installed = true;
	async unavailable(): Promise<string | undefined> {
		return undefined;
	}
	missingModels() {
		return this.installed ? [] : [SUPERTONIC_SPEC];
	}
}

describe("Media.deliverReply", () => {
	let dir: string;
	let settings: SettingsStore;
	let sent: AnyMessageContent[];
	let voice: FakeVoice;
	let media: Media;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phw-media-"));
		settings = new SettingsStore(join(dir, "config.json"));
		settings.load();
		settings.update((draft) => {
			addLanguage(draft, "tr");
			draft.voice = { understand: true, reply: true };
		});
		sent = [];
		voice = new FakeVoice();
		const queue = new SendQueue(
			{
				isOpen: () => true,
				send: async (_jid, content) => {
					sent.push(content);
					return { id: "x", key: { id: "x" } };
				},
			},
			{ sleep: async () => {} },
		);
		media = new Media({
			settings,
			connection: { download: async () => Buffer.alloc(0), presence: async () => {} },
			queue,
			voice: voice as unknown as VoiceService,
			inboxDir: join(dir, "inbox"),
		});
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const kinds = () => sent.map((content) => ("audio" in content ? "voice" : "text"));

	it("mirror me: voice in → voice out, text in → text out", async () => {
		await media.deliverReply("c", "Tamam, hallettim.", { voiceIn: true, language: "tr" });
		await media.deliverReply("c", "Done.", { voiceIn: false });
		assert.deepEqual(kinds(), ["voice", "text"]);
		assert.equal(voice.spoken[0]?.language, "tr");
	});

	it("voice + text sends both; off sends text only", async () => {
		settings.update((draft) => {
			draft.voiceMode = "voice+text";
		});
		await media.deliverReply("c", "All good, everything works now.", { voiceIn: false });
		settings.update((draft) => {
			draft.voiceMode = "off";
		});
		await media.deliverReply("c", "All good.", { voiceIn: true });
		assert.deepEqual(kinds(), ["text", "voice", "text"]);
	});

	it("speaks only the prose of code-heavy answers and also sends the text", async () => {
		settings.update((draft) => {
			draft.voiceMode = "voice";
		});
		await media.deliverReply("c", `Here is the fix:\n\`\`\`ts\n${"const x = 1;\n".repeat(40)}\`\`\``, { voiceIn: true });
		assert.deepEqual(kinds(), ["text", "voice"]);
		assert.equal(voice.spoken[0]?.text, "Here is the fix:\n (code omitted)");
	});

	it("says so when a voice has to be downloaded first", async () => {
		voice.installed = false;
		await media.deliverReply("c", "Tamam.", { voiceIn: true, language: "tr" });
		assert.equal((sent[0] as { text: string }).text, `⏳ Getting the voice ready (one-time download, ~${SUPERTONIC_SPEC.approxMB} MB)…`);
		assert.equal("audio" in sent[1]!, true);
	});

	it("only ever sends text while voice replies are off, whatever the reply type", async () => {
		settings.update((draft) => {
			draft.voice.reply = false;
			draft.voiceMode = "voice";
		});
		await media.deliverReply("c", "Tamam, hallettim.", { voiceIn: true, language: "tr" });
		assert.deepEqual(kinds(), ["text"]);
		assert.equal(voice.spoken.length, 0);
	});

	it("mirror me answers a typed message with text, even when Pi can't listen to voice notes", async () => {
		settings.update((draft) => {
			draft.voice = { understand: false, reply: true };
			draft.voiceMode = "mirror";
		});
		await media.deliverReply("c", "Tamam.", { voiceIn: false });
		settings.update((draft) => {
			draft.voiceMode = "voice";
		});
		await media.deliverReply("c", "Tamam, hallettim.", { voiceIn: false, language: "tr" });
		assert.deepEqual(kinds(), ["text", "voice"]);
	});

	it("sends text, not an empty voice note, when there is nothing to say", async () => {
		await media.deliverReply("c", "👍", { voiceIn: true });
		assert.deepEqual(kinds(), ["text"]);
		assert.equal(voice.spoken.length, 0);
	});

	it("says why, without a download notice, when voice can't work on this machine", async () => {
		voice.installed = false;
		voice.unavailable = async () => "ffmpeg is not installed (needed for voice notes)";
		await media.deliverReply("c", "Tamam.", { voiceIn: true, language: "tr" });
		assert.deepEqual(sent.map((content) => (content as { text: string }).text), [
			"Tamam.",
			"(couldn't make a voice note: ffmpeg is not installed (needed for voice notes))",
		]);
	});

	it("falls back to text when the voice note can't be made", async () => {
		settings.update((draft) => {
			draft.voiceMode = "voice";
		});
		voice.fail = true;
		await media.deliverReply("c", "Short answer.", { voiceIn: true });
		assert.deepEqual(sent.map((content) => (content as { text: string }).text), ["Short answer.", "(couldn't make a voice note: no voice)"]);
	});
});

// Uses the real models when they are downloaded (they are after the first voice note).
// Tests run with a temporary data folder; the real speech files are only read here, never changed.
const realModels = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-harness-whatsapp", "models");
const store = new ModelStore(realModels);
const haveModels = existsSync(realModels) && [RUNTIME_SPEC, WHISPER_SPEC, SUPERTONIC_SPEC].every((spec) => store.isInstalled(spec));

describe("speech engine (real models)", { skip: !haveModels && "the speech models aren't installed here" }, () => {
	it("speaks Turkish and hears it back", { timeout: 120_000 }, async () => {
		const engine = new SpeechEngine(() => store.dir(RUNTIME_SPEC));
		try {
			const text = "Merhaba, bütün testler başarıyla geçti ve yeni sayfaya başlıyorum.";
			const spoken = await engine.speak(store.dir(SUPERTONIC_SPEC), text, "tr", "F1", 1);
			const note = await encodeVoiceNote(spoken.samples, spoken.sampleRate);
			assert.equal(note.audio.subarray(0, 4).toString(), "OggS");
			const heard = await engine.transcribe(store.dir(WHISPER_SPEC), await decodeToSamples(note.audio));
			assert.equal(detectLanguage(heard.text, ["en", "tr"]), "tr");
			const expected = ["merhaba", "bütün", "testler", "başarıyla", "geçti", "yeni", "sayfaya", "başlıyorum"];
			const got = heard.text.toLocaleLowerCase("tr");
			assert.ok(expected.filter((word) => got.includes(word)).length >= 6);
		} finally {
			await engine.unload();
		}
	});
});

describe("Media.prepare", () => {
	it("attaches the image a message replies to", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "phw-media-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const media = new Media({
			settings: new SettingsStore(join(dir, "config.json")),
			connection: { download: async () => Buffer.from("jpegbytes"), presence: async () => {} },
			queue: {} as SendQueue,
			voice: {} as VoiceService,
			inboxDir: join(dir, "inbox"),
		});
		const message = {
			id: "1", chatJid: "120363000000000001@g.us", senderJid: "905551234567@s.whatsapp.net", isGroup: true, fromMe: false,
			timestamp: Date.now(), kind: "text", text: "@Pi bu ne?", quotedId: "Q1", quotedAuthorJid: "4477001122@s.whatsapp.net",
			quotedImage: { mimetype: "image/png" }, raw: {},
		} as unknown as Parameters<Media["prepare"]>[0];
		const prepared = await media.prepare(message, () => "[WhatsApp group]");
		assert.deepEqual(prepared.content, [
			{ type: "text", text: "[WhatsApp group] @Pi bu ne? [the image they replied to is attached]" },
			{ type: "image", data: Buffer.from("jpegbytes").toString("base64"), mimeType: "image/png" },
		]);
	});
});

describe("cleanInbox", () => {
	it("removes only files older than a week", async () => {
		const { cleanInbox, INBOX_KEEP_MS } = await import("../src/media.ts");
		const { writeFileSync, utimesSync, readdirSync, mkdirSync } = await import("node:fs");
		const dir = mkdtempSync(join(tmpdir(), "phw-inbox-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "old.pdf"), "x");
		writeFileSync(join(dir, "new.pdf"), "y");
		const old = (Date.now() - INBOX_KEEP_MS - 60_000) / 1000;
		utimesSync(join(dir, "old.pdf"), old, old);
		assert.equal(cleanInbox(dir), 1);
		assert.deepEqual(readdirSync(dir), ["new.pdf"]);
		assert.equal(cleanInbox(join(dir, "missing")), 0);
		rmSync(dir, { recursive: true, force: true });
	});
});
