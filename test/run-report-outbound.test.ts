// The run summary (tool calls, touched files, time) and the queue that sends messages in order.
import type { AnyMessageContent } from "baileys";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatActivity, formatDuration, formatTouchedFiles, RunReport } from "../src/core/run-report.ts";
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
		assert.equal(report.summary(134_000), "⚠️ 3/4 tool calls ok · ⏱ 2m 14s");
		assert.deepEqual(report.touchedFiles(), ["notes.md", "src/b.ts"]);
		assert.equal(formatActivity(report.recentSteps(2), report.toolCount), "… 2 earlier steps\n🔧 write: notes.md ✓\n🔧 bash: npm test ✗");
	});

	it("handles runs without tools", () => {
		assert.equal(new RunReport("/", 0).summary(5_000), "✅ no tool calls · ⏱ 5s");
		assert.equal(formatTouchedFiles([]), undefined);
	});

	it("formats durations", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(59_400), "59s");
		assert.equal(formatDuration(3_725_000), "1h 2m");
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
		assert.deepEqual(sender.sent.map((entry) => (entry.content as { text: string }).text), ["*one*", "two"]);
	});

	it("retries failures and gives up after the limit", async () => {
		const sender = new FakeSender();
		const queue = new SendQueue(sender, { sleep: noSleep, retries: 3 });
		sender.failures = 2;
		assert.partialDeepStrictEqual(await queue.enqueue("a", { text: "x" }), { id: "m1" });
		sender.failures = 5;
		assert.equal(await queue.enqueue("a", { text: "y" }), undefined);
		// A group gets two extra attempts.
		sender.failures = 4;
		assert.notEqual(await queue.enqueue("1@g.us", { text: "z" }), undefined);
	});

	it("drops messages while closed or offline", async () => {
		const sender = new FakeSender();
		const queue = new SendQueue(sender, { sleep: noSleep, offlineWaitMs: 0 });
		sender.open = false;
		assert.equal(await queue.enqueue("a", { text: "x" }), undefined);
		sender.open = true;
		queue.close();
		assert.equal(await queue.enqueue("a", { text: "x" }), undefined);
		queue.reopen();
		assert.notEqual(await queue.enqueue("a", { text: "x" }), undefined);
	});
});
