import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyMessageContent } from "baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Media, safeFileName } from "../src/media.ts";
import { addLanguage, SettingsStore } from "../src/settings.ts";
import { decodeToSamples, encodeVoiceNote } from "../src/voice/audio.ts";
import { SpeechEngine } from "../src/voice/engine.ts";
import { chooseSpeechLanguage, detectLanguage } from "../src/voice/language.ts";
import { ModelStore, RUNTIME_SPEC, SUPERTONIC_SPEC, WHISPER_SPEC } from "../src/voice/models.ts";
import type { VoiceService } from "../src/voice/service.ts";
import { SendQueue } from "../src/wa/outbound.ts";

describe("language choice", () => {
	const both = ["en", "tr"];
	it("detects Turkish and English among the enabled languages", () => {
		expect(detectLanguage("Testleri çalıştırdım ve hepsi geçti, başka ne yapayım?", both)).toBe("tr");
		expect(detectLanguage("I ran the tests and they all passed, what next?", both)).toBe("en");
		expect(detectLanguage("ok", both)).toBeUndefined();
		expect(detectLanguage("anything", ["tr"])).toBe("tr");
	});

	it("prefers a fixed reply language, then the text, then the user's language, then the default", () => {
		expect(chooseSpeechLanguage("Hello there, how are you doing today?", { enabled: both, replyLanguage: "tr" })).toBe("tr");
		expect(chooseSpeechLanguage("Merhaba, bugün nasılsın, her şey yolunda mı?", { enabled: both, replyLanguage: "mirror" })).toBe("tr");
		expect(chooseSpeechLanguage("ok", { enabled: both, replyLanguage: "mirror", incoming: "tr" })).toBe("tr");
		expect(chooseSpeechLanguage("ok", { enabled: both, replyLanguage: "mirror", incoming: "de" })).toBe("en");
	});
});

describe("safeFileName", () => {
	it("strips folders and odd characters and keeps the extension", () => {
		expect(safeFileName("../../etc/pass wd.pdf", ".bin")).toMatch(/^pass wd-[\dT-]+Z\.pdf$/);
		expect(safeFileName(undefined, ".txt")).toMatch(/^file-.*\.txt$/);
		expect(safeFileName("we$ird;name", ".bin")).toMatch(/^we_ird_name-.*\.bin$/);
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
		settings.update((draft) => addLanguage(draft, "tr"));
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
		expect(kinds()).toEqual(["voice", "text"]);
		expect(voice.spoken[0]?.language).toBe("tr");
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
		expect(kinds()).toEqual(["text", "voice", "text"]);
	});

	it("speaks only the prose of code-heavy answers and also sends the text", async () => {
		settings.update((draft) => {
			draft.voiceMode = "voice";
		});
		await media.deliverReply("c", `Here is the fix:\n\`\`\`ts\n${"const x = 1;\n".repeat(40)}\`\`\``, { voiceIn: true });
		expect(kinds()).toEqual(["text", "voice"]);
		expect(voice.spoken[0]?.text).toBe("Here is the fix:\n (code omitted)");
	});

	it("says so when a voice has to be downloaded first", async () => {
		voice.installed = false;
		await media.deliverReply("c", "Tamam.", { voiceIn: true, language: "tr" });
		expect((sent[0] as { text: string }).text).toBe(`⏳ Getting the voice ready (one-time download, ~${SUPERTONIC_SPEC.approxMB} MB)…`);
		expect("audio" in sent[1]!).toBe(true);
	});

	it("falls back to text when the voice note can't be made", async () => {
		settings.update((draft) => {
			draft.voiceMode = "voice";
		});
		voice.fail = true;
		await media.deliverReply("c", "Short answer.", { voiceIn: true });
		expect(sent.map((content) => (content as { text: string }).text)).toEqual(["Short answer.", "(couldn't make a voice note: no voice)"]);
	});
});

// Uses the real models when they are downloaded (they are after the first voice note).
// Tests run with a temporary data folder; the real speech files are only read here, never changed.
const realModels = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-harness-whatsapp", "models");
const store = new ModelStore(realModels);
const haveModels = existsSync(realModels) && [RUNTIME_SPEC, WHISPER_SPEC, SUPERTONIC_SPEC].every((spec) => store.isInstalled(spec));

describe.skipIf(!haveModels)("speech engine (real models)", () => {
	it("speaks Turkish and hears it back", async () => {
		const engine = new SpeechEngine(() => store.dir(RUNTIME_SPEC));
		try {
			const text = "Merhaba, bütün testler başarıyla geçti ve yeni sayfaya başlıyorum.";
			const spoken = await engine.speak(store.dir(SUPERTONIC_SPEC), text, "tr", "F1", 1);
			const note = await encodeVoiceNote(spoken.samples, spoken.sampleRate);
			expect(note.audio.subarray(0, 4).toString()).toBe("OggS");
			const heard = await engine.transcribe(store.dir(WHISPER_SPEC), await decodeToSamples(note.audio));
			expect(detectLanguage(heard.text, ["en", "tr"])).toBe("tr");
			const expected = ["merhaba", "bütün", "testler", "başarıyla", "geçti", "yeni", "sayfaya", "başlıyorum"];
			const got = heard.text.toLocaleLowerCase("tr");
			expect(expected.filter((word) => got.includes(word)).length).toBeGreaterThanOrEqual(6);
		} finally {
			await engine.unload();
		}
	}, 120_000);
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
		expect(cleanInbox(dir)).toBe(1);
		expect(readdirSync(dir)).toEqual(["new.pdf"]);
		expect(cleanInbox(join(dir, "missing"))).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});
});
