import type { AnyMessageContent } from "baileys";
import { describe, expect, it } from "vitest";
import { formatActivity, formatDuration, formatTouchedFiles, RunReport } from "../src/run-report.ts";
import { SendQueue, type Sender } from "../src/wa/outbound.ts";

describe("RunReport", () => {
	it("counts tool calls, collects touched files and formats the summary", () => {
		const report = new RunReport("/work", 0);
		report.toolStarted("1", "read", { path: "/work/a.ts" });
		report.toolStarted("2", "edit", { path: "/work/src/b.ts", edits: [] });
		report.toolStarted("3", "write", { path: "notes.md" });
		report.toolStarted("4", "bash", { command: "npm test" });
		report.toolEnded("1", false);
		report.toolEnded("2", false);
		report.toolEnded("3", false);
		report.toolEnded("4", true);
		expect(report.summary(134_000)).toBe("⚠️ 3/4 tool calls ok · ⏱ 2m 14s");
		expect(report.touchedFiles()).toEqual(["notes.md", "src/b.ts"]);
		expect(formatActivity(report.recentSteps(2), report.toolCount)).toBe(
			"… 2 earlier steps\n🔧 write: notes.md ✓\n🔧 bash: npm test ✗",
		);
	});

	it("handles runs without tools", () => {
		expect(new RunReport("/", 0).summary(5_000)).toBe("✅ no tool calls · ⏱ 5s");
		expect(formatTouchedFiles([])).toBeUndefined();
	});

	it("formats durations", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(59_400)).toBe("59s");
		expect(formatDuration(3_725_000)).toBe("1h 2m");
	});
});

class FakeSender implements Sender {
	open = true;
	failures = 0;
	sent: Array<{ jid: string; content: AnyMessageContent }> = [];
	isOpen() {
		return this.open;
	}
	async send(jid: string, content: AnyMessageContent) {
		if (this.failures > 0) {
			this.failures--;
			throw new Error("boom");
		}
		this.sent.push({ jid, content });
		const id = `m${this.sent.length}`;
		return { id, key: { id, remoteJid: jid, fromMe: true } };
	}
}

const noSleep = async () => {};

describe("SendQueue", () => {
	it("sends in order, formatted and split", async () => {
		const sender = new FakeSender();
		const queue = new SendQueue(sender, { sleep: noSleep });
		await Promise.all([queue.sendText("a", "**one**"), queue.sendText("a", "two")]);
		expect(sender.sent.map((entry) => (entry.content as { text: string }).text)).toEqual(["*one*", "two"]);
	});

	it("retries failures and gives up after the limit", async () => {
		const sender = new FakeSender();
		const queue = new SendQueue(sender, { sleep: noSleep, retries: 3 });
		sender.failures = 2;
		expect(await queue.enqueue("a", { text: "x" })).toMatchObject({ id: "m1" });
		sender.failures = 5;
		expect(await queue.enqueue("a", { text: "y" })).toBeUndefined();
		// A group gets two extra attempts.
		sender.failures = 4;
		expect(await queue.enqueue("1@g.us", { text: "z" })).toBeDefined();
	});

	it("drops messages while closed or offline", async () => {
		const sender = new FakeSender();
		const queue = new SendQueue(sender, { sleep: noSleep, offlineWaitMs: 0 });
		sender.open = false;
		expect(await queue.enqueue("a", { text: "x" })).toBeUndefined();
		sender.open = true;
		queue.close();
		expect(await queue.enqueue("a", { text: "x" })).toBeUndefined();
		queue.reopen();
		expect(await queue.enqueue("a", { text: "x" })).toBeDefined();
	});
});
