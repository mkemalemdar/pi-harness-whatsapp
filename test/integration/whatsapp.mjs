// A real pi (RPC mode) with the real extension, against a fake WhatsApp (fake-whatsapp.ts) and a fake model (a small
// OpenAI-style server here that answers "echo: <message>"). Needs no phone, no account and no GPU:
//   node test/integration/whatsapp.mjs
// Checks what reaches WhatsApp: the "Message yourself" chat (one number), an allowed contact, a stranger, your own
// message in a group, a contact in a group, a WhatsApp command, a prompt typed in the terminal, and Remove everything.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = new URL("../../", import.meta.url).pathname;
const SELF = "15550000001";
const FRIEND = "15550000002";
const STRANGER = "15550000009";
const GROUP = "120363000000000001@g.us";
const jid = (digits) => `${digits}@s.whatsapp.net`;

const results = [];
const check = (name, ok, detail = "") => {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
	results.push(line);
	console.log(line);
};

// ---- the fake model: answers "echo: <the last line of the prompt, without WhatsApp's label>"
const asked = [];
const model = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const request = JSON.parse(body || "{}");
		const last = [...(request.messages ?? [])].reverse().find((m) => m.role === "user");
		const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((p) => p.text ?? "").join("");
		const said = text.split("\n").at(-1).replace(/^\[[^\]]*\]\s*/, "").trim();
		asked.push(said);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish = null) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "echo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: `echo: ${said}` }));
		res.write(chunk({}, "stop"));
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const port = model.address().port;

// ---- pi's own folder for this test, with the fake model and the extension's settings
const agent = mkdtempSync(join(tmpdir(), "phw-it-"));
mkdirSync(join(agent, "work"));
writeFileSync(join(agent, "models.json"), JSON.stringify({
	providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "echo", contextWindow: 32000, maxTokens: 1000 }] } },
}));
mkdirSync(join(agent, "pi-harness-whatsapp"), { mode: 0o700 });
writeFileSync(join(agent, "pi-harness-whatsapp", "config.json"), JSON.stringify({
	contacts: [{ id: FRIEND, name: "Sam" }, { id: GROUP, name: "Team" }],
}));
const waLog = join(agent, "fake-wa.jsonl");
const sentLog = () => (existsSync(waLog) ? readFileSync(waLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const proc = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-e", `${ROOT}test/integration/fake-whatsapp.ts`, "--whatsapp"], {
	cwd: join(agent, "work"),
	env: { ...process.env, PI_CODING_AGENT_DIR: agent, FAKE_WA_LOG: waLog, FAKE_WA_SELF: SELF },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d));
const events = [];
const pending = new Map();
let seq = 0;
// Questions from pi: "allow this stranger?" is answered no; Remove everything's questions yes.
let answerYes = false;
createInterface({ input: proc.stdout }).on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.type === "response" && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
		return;
	}
	if (msg.type === "extension_ui_request" && msg.method === "confirm") {
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: answerYes })}\n`);
	} else if (msg.type === "extension_ui_request" && ["select", "input", "editor"].includes(msg.method)) {
		proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: msg.id, cancelled: true })}\n`);
	}
	events.push(msg);
});
const send = (cmd) => {
	const id = `t${++seq}`;
	proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
	return new Promise((resolve) => pending.set(id, resolve));
};
const waitFor = async (pred, ms) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const hit = pred();
		if (hit) return hit;
		await new Promise((r) => setTimeout(r, 100));
	}
	return undefined;
};
const settle = () => new Promise((r) => setTimeout(r, 1500));
/** A message arrives on WhatsApp; what was sent to `to` afterwards (text), and what the model was asked. */
const arrive = async (message, to, ms = 20000) => {
	const mark = sentLog().length;
	const askedBefore = asked.length;
	await send({ type: "prompt", message: `/fakewa ${JSON.stringify(message)}` });
	const reply = to ? await waitFor(() => sentLog().slice(mark).find((e) => e.type === "sent" && e.jid === to && typeof e.content?.text === "string" && !e.content.text.startsWith("⏳")), ms) : undefined;
	if (!to) await settle();
	return { reply: reply?.content?.text, asked: asked.slice(askedBefore), sent: sentLog().slice(mark).filter((e) => e.type === "sent") };
};

try {
	await send({ type: "set_model", provider: "fake", modelId: "echo" });
	const open = await waitFor(() => events.find((e) => e.method === "setStatus" && /WA: connected as \+/.test(e.statusText ?? "")), 20000);
	check("connects to the (fake) WhatsApp without a QR code", !!open, open?.statusText);

	const self = await arrive({ chat: "self", text: "hello from my phone" }, jid(SELF));
	check("one number: the \"Message yourself\" chat reaches pi, and the answer comes back there", self.reply?.includes("echo: hello from my phone"), self.reply);

	const friend = await arrive({ chat: FRIEND, text: "hi there", name: "Sam" }, jid(FRIEND));
	check("an allowed contact gets the answer in their chat", friend.reply?.includes("echo: hi there"), friend.reply);

	const stranger = await arrive({ chat: STRANGER, text: "let me in", name: "Who" });
	check("a stranger's message never reaches the model, and nothing is sent to them", stranger.asked.length === 0 && !stranger.sent.some((e) => e.jid === jid(STRANGER)), JSON.stringify(stranger.asked));

	const ownInGroup = await arrive({ chat: GROUP, from: "self", fromMe: true, mention: true, text: "@Pi are you there?" });
	check("one number: your own message in a group is ignored (it's the same account)", ownInGroup.asked.length === 0 && ownInGroup.sent.length === 0, JSON.stringify(ownInGroup.asked));

	const inGroup = await arrive({ chat: GROUP, from: FRIEND, name: "Sam", mention: true, text: "@Pi what's up?" }, GROUP);
	check("a contact @mentioning pi in an allowed group gets the answer in the group", inGroup.reply?.includes("echo:"), inGroup.reply);

	const help = await arrive({ chat: "self", text: "/help" }, jid(SELF));
	check("a WhatsApp command (/help) is answered without the model", !!help.reply && help.asked.length === 0, help.reply?.split("\n")[0]);

	const mark = sentLog().length;
	await send({ type: "prompt", message: "typed in the terminal" });
	await waitFor(() => asked.includes("typed in the terminal"), 20000);
	await settle();
	check("a prompt typed in the terminal stays there (Terminal answers is off)", asked.includes("typed in the terminal") && !sentLog().slice(mark).some((e) => e.type === "sent"), "");

	answerYes = true;
	await send({ type: "prompt", message: "/whatsapp remove" });
	const loggedOut = await waitFor(() => sentLog().find((e) => e.type === "logout"), 20000);
	await settle();
	check("/whatsapp remove: unlinks from the phone and deletes the extension's folder", !!loggedOut && !existsSync(join(agent, "pi-harness-whatsapp")), existsSync(join(agent, "pi-harness-whatsapp")) ? "folder still there" : "");
} catch (e) {
	check("ran", false, e.message);
} finally {
	proc.stdin.end();
	await new Promise((r) => {
		const t = setTimeout(() => (proc.kill("SIGTERM"), r()), 5000);
		proc.on("exit", () => (clearTimeout(t), r()));
	});
	model.close();
	rmSync(agent, { recursive: true, force: true });
}
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length && stderr.trim()) console.log(`\npi's stderr (last lines):\n${stderr.trim().split("\n").slice(-15).join("\n")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
