import { describe, expect, it } from "vitest";
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
		expect(resolveRecipient(controllerWith(contacts, "x@s.whatsapp.net"), undefined)).toBe("x@s.whatsapp.net");
		expect(resolveRecipient(controllerWith(contacts), undefined)).toBe("905551234567@s.whatsapp.net");
	});

	it("finds allowed contacts by name or number and refuses others", () => {
		expect(resolveRecipient(controllerWith(contacts), "team")).toBe("120363000000000001@g.us");
		expect(resolveRecipient(controllerWith(contacts), "+905551234567")).toBe("905551234567@s.whatsapp.net");
		expect(resolveRecipient(controllerWith(contacts), "Hidden")).toBe("100000000000001@lid");
		expect(() => resolveRecipient(controllerWith(contacts), "+4477001122")).toThrow(/not an allowed/);
		expect(() => resolveRecipient(controllerWith([]), undefined)).toThrow(/nobody is allowed/);
	});
});

describe("tool visibility", () => {
	it("adds and removes only the WhatsApp tools", () => {
		let active = ["read", "bash"];
		const pi = { getActiveTools: () => active, setActiveTools: (names: string[]) => (active = names) };
		setToolsActive(pi, true);
		expect(active).toEqual(["read", "bash", ...TOOL_NAMES]);
		setToolsActive(pi, true);
		expect(active).toHaveLength(2 + TOOL_NAMES.length);
		setToolsActive(pi, false);
		expect(active).toEqual(["read", "bash"]);
	});

	it("knows common file types", () => {
		expect(mimeFor("shot.PNG")).toBe("image/png");
		expect(mimeFor("report.pdf")).toBe("application/pdf");
		expect(mimeFor("blob")).toBe("application/octet-stream");
	});
});
