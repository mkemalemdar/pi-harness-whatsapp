import { describe, expect, it } from "vitest";
import { isCodeHeavy, markdownToWhatsApp, splitMessage, textForSpeech } from "../src/format.ts";

describe("markdownToWhatsApp", () => {
	it("converts emphasis", () => {
		expect(markdownToWhatsApp("**bold** and *italic* and ~~gone~~ and __also bold__")).toBe(
			"*bold* and _italic_ and ~gone~ and *also bold*",
		);
	});

	it("keeps inline code and code blocks untouched", () => {
		const input = "Use `**not bold**` here\n\n```ts\nconst a = **b**;\n```\nafter **x**";
		expect(markdownToWhatsApp(input)).toBe("Use `**not bold**` here\n\n```\nconst a = **b**;\n```\nafter *x*");
	});

	it("turns headings, bullets, tasks and quotes into WhatsApp style", () => {
		const input = "## Plan\n- one\n* two\n- [ ] todo\n- [x] done\n> quoted **text**\n---";
		expect(markdownToWhatsApp(input)).toBe(
			"*Plan*\n• one\n• two\n☐ todo\n☑ done\n> quoted *text*\n──────────",
		);
	});

	it("rewrites links", () => {
		expect(markdownToWhatsApp("see [docs](https://pi.dev) or https://x.y")).toBe(
			"see docs (https://pi.dev) or https://x.y",
		);
	});

	it("puts tables in a monospace block", () => {
		const input = "| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";
		expect(markdownToWhatsApp(input)).toBe("```\n| a | b |\n| 1 | 2 |\n```\n\nafter");
	});

	it("does not treat list asterisks or multiplication as italics", () => {
		expect(markdownToWhatsApp("2 * 3 * 4")).toBe("2 * 3 * 4");
	});
});

describe("splitMessage", () => {
	it("returns short text as one chunk and nothing for empty text", () => {
		expect(splitMessage("hello")).toEqual(["hello"]);
		expect(splitMessage("")).toEqual([]);
	});

	it("splits on paragraph boundaries within the limit", () => {
		const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
		const chunks = splitMessage(text, 100);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
		expect(chunks.join("")).toContain("c".repeat(60));
	});

	it("closes and reopens a code block that is cut", () => {
		const code = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		const chunks = splitMessage(`intro\n\`\`\`\n${code}\n\`\`\``, 120);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(120);
			expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
		}
	});

	it("hard-cuts text without spaces", () => {
		const chunks = splitMessage("x".repeat(250), 100);
		expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
		expect(chunks.join("").length).toBe(250);
	});
});

describe("speech helpers", () => {
	it("strips markup and code for speech", () => {
		expect(textForSpeech("## Done\n**Fixed** the `bug` in [file](http://a.b).\n```\ncode\n```\nSee https://x.y")).toBe(
			"Done\nFixed the bug in file.\n (code omitted) \nSee link",
		);
	});

	it("detects code-heavy replies", () => {
		expect(isCodeHeavy("short answer")).toBe(false);
		expect(isCodeHeavy(`Here:\n\`\`\`\n${"x = 1\n".repeat(60)}\`\`\``)).toBe(true);
	});
});
