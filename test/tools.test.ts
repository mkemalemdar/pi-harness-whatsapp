// The model's WhatsApp tools: who gets a message, when the tools are offered, file types.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mimeFor, resolveRecipient, setToolsActive, TOOL_NAMES } from "../src/tools.ts";

const controllerWith = (contacts: unknown[], activeChat?: string) =>
	({
		settings: { get: () => ({ contacts }) },
		bridge: { activeChat: () => activeChat },
	}) as never;

describe("resolveRecipient", () => {
	const contacts = [
		{ id: "905551234567", name: "Alex", owner: true },
		{ id: "120363000000000001@g.us", name: "Team" },
		{ id: "100000000000001", lid: "100000000000001", name: "Hidden" },
	];

	it("uses the chat Pi is answering, else the owner", () => {
		assert.equal(resolveRecipient(controllerWith(contacts, "x@s.whatsapp.net"), undefined), "x@s.whatsapp.net");
		assert.equal(resolveRecipient(controllerWith(contacts), undefined), "905551234567@s.whatsapp.net");
	});

	it("finds allowed contacts by name or number and refuses others", () => {
		assert.equal(resolveRecipient(controllerWith(contacts), "team"), "120363000000000001@g.us");
		assert.equal(resolveRecipient(controllerWith(contacts), "+905551234567"), "905551234567@s.whatsapp.net");
		assert.equal(resolveRecipient(controllerWith(contacts), "Hidden"), "100000000000001@lid");
		assert.throws(() => resolveRecipient(controllerWith(contacts), "+4477001122"), /not an allowed/);
		assert.throws(() => resolveRecipient(controllerWith([]), undefined), /nobody is allowed/);
	});
});

describe("tool visibility", () => {
	it("adds and removes only the WhatsApp tools", () => {
		let active = ["read", "bash"];
		const pi = { getActiveTools: () => active, setActiveTools: (names: string[]) => (active = names) };
		setToolsActive(pi, true);
		assert.deepEqual(active, ["read", "bash", ...TOOL_NAMES]);
		setToolsActive(pi, true);
		assert.equal(active.length, 2 + TOOL_NAMES.length);
		setToolsActive(pi, false);
		assert.deepEqual(active, ["read", "bash"]);
	});

	it("knows common file types", () => {
		assert.equal(mimeFor("shot.PNG"), "image/png");
		assert.equal(mimeFor("report.pdf"), "application/pdf");
		assert.equal(mimeFor("blob"), "application/octet-stream");
	});
});
