// Markdown (what models write) turned into WhatsApp formatting, and long answers split.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCodeHeavy, markdownToWhatsApp, splitForSpeech, splitMessage, textForSpeech } from "../src/core/format.ts";

describe("markdownToWhatsApp", () => {
	it("converts emphasis", () => {
		assert.equal(markdownToWhatsApp("**bold** and *italic* and ~~gone~~ and __also bold__"), "*bold* and _italic_ and ~gone~ and *also bold*");
	});

	it("keeps inline code and code blocks untouched", () => {
		const input = "Use `**not bold**` here\n\n```ts\nconst a = **b**;\n```\nafter **x**";
		assert.equal(markdownToWhatsApp(input), "Use `**not bold**` here\n\n```\nconst a = **b**;\n```\nafter *x*");
	});

	it("turns headings, bullets, tasks and quotes into WhatsApp style", () => {
		const input = "## Plan\n- one\n* two\n- [ ] todo\n- [x] done\n> quoted **text**\n---";
		assert.equal(markdownToWhatsApp(input), "*Plan*\n• one\n• two\n☐ todo\n☑ done\n> quoted *text*\n──────────");
	});

	it("rewrites links", () => {
		assert.equal(markdownToWhatsApp("see [docs](https://pi.dev) or https://x.y"), "see docs (https://pi.dev) or https://x.y");
	});

	it("puts tables in a monospace block", () => {
		const input = "| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";
		assert.equal(markdownToWhatsApp(input), "```\n| a | b |\n| 1 | 2 |\n```\n\nafter");
	});

	it("does not treat list asterisks or multiplication as italics", () => {
		assert.equal(markdownToWhatsApp("2 * 3 * 4"), "2 * 3 * 4");
	});
});

describe("splitMessage", () => {
	it("returns short text as one chunk and nothing for empty text", () => {
		assert.deepEqual(splitMessage("hello"), ["hello"]);
		assert.deepEqual(splitMessage(""), []);
	});

	it("splits on paragraph boundaries within the limit", () => {
		const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
		const chunks = splitMessage(text, 100);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) assert.ok(chunk.length <= 100);
		assert.ok(chunks.join("").includes("c".repeat(60)));
	});

	it("closes and reopens a code block that is cut", () => {
		const code = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		const chunks = splitMessage(`intro\n\`\`\`\n${code}\n\`\`\``, 120);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.length <= 120);
			assert.equal((chunk.match(/```/g) ?? []).length % 2, 0);
		}
	});

	it("hard-cuts text without spaces", () => {
		const chunks = splitMessage("x".repeat(250), 100);
		assert.equal(chunks.every((chunk) => chunk.length <= 100), true);
		assert.equal(chunks.join("").length, 250);
	});
});

describe("speech helpers", () => {
	it("strips markup and code for speech", () => {
		assert.equal(textForSpeech("## Done\n**Fixed** the `bug` in [file](http://a.b).\n```\ncode\n```\nSee https://x.y"), "Done\nFixed the bug in file.\n (code omitted) \nSee link");
	});

	it("detects code-heavy replies", () => {
		assert.equal(isCodeHeavy("short answer"), false);
		assert.equal(isCodeHeavy(`Here:\n\`\`\`\n${"x = 1\n".repeat(60)}\`\`\``), true);
	});
});

describe("splitForSpeech", () => {
	it("keeps short text whole and splits long text at sentence ends", () => {
		assert.deepEqual(splitForSpeech("Short answer.", 100), ["Short answer."]);
		const sentence = "This is one sentence of about fifty characters. ";
		const parts = splitForSpeech(sentence.repeat(10), 120);
		assert.equal(parts.length, 5);
		for (const part of parts) {
			assert.ok(part.length <= 120);
			assert.equal(part.endsWith("."), true);
		}
		assert.equal(parts.join(" "), sentence.repeat(10).trim());
	});

	it("falls back to a word break when there is no sentence end", () => {
		const parts = splitForSpeech("word ".repeat(50), 40);
		for (const part of parts) assert.ok(part.length <= 40);
		assert.equal(parts.join(" "), "word ".repeat(50).trim());
	});
});
