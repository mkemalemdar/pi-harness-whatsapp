import { describe, expect, it } from "vitest";
import { groupMarker, ListMenu, type MenuItem, MenuStack } from "../src/panel-components.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const KEY = { up: "\u001b[A", down: "\u001b[B", enter: "\r", space: " ", escape: "\u001b" };

function menu(items: MenuItem[], events: string[]) {
	return new ListMenu(theme, {
		title: "Title",
		description: "What this setting does.",
		items,
		onSelect: (item) => events.push(`select:${item.id}`),
		onToggle: (item) => events.push(`toggle:${item.id}`),
		onCancel: () => events.push("cancel"),
	});
}

describe("ListMenu", () => {
	it("skips disabled rows, selects with Enter, toggles with Space, cancels with Esc", () => {
		const events: string[] = [];
		const list = menu(
			[
				{ id: "a", label: "A" },
				{ id: "info", label: "info", disabled: true },
				{ id: "b", label: "B" },
			],
			events,
		);
		list.handleInput(KEY.down);
		expect(list.selected()?.id).toBe("b");
		list.handleInput(KEY.enter);
		list.handleInput(KEY.space);
		list.handleInput(KEY.down);
		expect(list.selected()?.id).toBe("a");
		list.handleInput(KEY.escape);
		expect(events).toEqual(["select:b", "toggle:b", "cancel"]);
	});

	it("renders the title, description, markers, details and the selected item's description", () => {
		const list = menu(
			[
				{ id: "on", label: "on", marker: "●", detail: "sent", description: "Turns it on." },
				{ id: "off", label: "off", marker: " " },
			],
			[],
		);
		const text = list.render(80).join("\n");
		expect(text).toContain("Title");
		expect(text).toContain("What this setting does.");
		expect(text).toMatch(/→ ● on\s+sent/);
		expect(text).toContain("Turns it on.");
		list.setStatus("Deleted 2 files.", "ok");
		expect(list.render(80).join("\n")).toContain("Deleted 2 files.");
	});
});

describe("MenuStack", () => {
	it("opens deeper menus and closes when the first one is left", () => {
		let closed = 0;
		const stack = new MenuStack(() => closed++);
		const events: string[] = [];
		stack.push(menu([{ id: "x", label: "X" }], events));
		stack.push(menu([{ id: "y", label: "Y" }], events));
		stack.handleInput(KEY.enter);
		expect(events).toEqual(["select:y"]);
		stack.pop();
		expect(closed).toBe(0);
		stack.pop();
		expect(closed).toBe(1);
	});
});

describe("groupMarker", () => {
	it("shows all, some or none", () => {
		expect(groupMarker(2, 2)).toBe("[x]");
		expect(groupMarker(1, 2)).toBe("[-]");
		expect(groupMarker(0, 2)).toBe("[ ]");
	});
});
