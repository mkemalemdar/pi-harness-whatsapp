import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
		assert.equal(list.selected()?.id, "b");
		list.handleInput(KEY.enter);
		list.handleInput(KEY.space);
		list.handleInput(KEY.down);
		assert.equal(list.selected()?.id, "a");
		list.handleInput(KEY.escape);
		assert.deepEqual(events, ["select:b", "toggle:b", "cancel"]);
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
		assert.ok(text.includes("Title"));
		assert.ok(text.includes("What this setting does."));
		assert.match(text, /→ ● on\s+sent/);
		assert.ok(text.includes("Turns it on."));
		assert.equal(list.render(80).at(-1), "");
		// Moving to a row without an explanation keeps the same number of lines.
		const before = list.render(80).length;
		list.handleInput(KEY.down);
		assert.equal(list.render(80).length, before);
		list.setStatus("Deleted 2 files.", "ok");
		assert.ok(list.render(80).join("\n").includes("Deleted 2 files."));
	});
});

describe("MenuStack", () => {
	it("opens deeper menus, returns home, and closes when the first one is left", () => {
		let closed = 0;
		let returned = 0;
		const stack = new MenuStack(
			() => closed++,
			() => returned++,
		);
		const events: string[] = [];
		stack.push(menu([{ id: "x", label: "X" }], events));
		stack.push(menu([{ id: "y", label: "Y" }], events));
		stack.handleInput(KEY.enter);
		assert.deepEqual(events, ["select:y"]);
		stack.pop();
		assert.equal(closed, 0);
		assert.equal(returned, 1);
		stack.push(menu([{ id: "z", label: "Z" }], events));
		stack.push(menu([{ id: "w", label: "W" }], events));
		stack.home();
		assert.equal(returned, 2);
		stack.pop();
		assert.equal(closed, 1);
	});
});

describe("groupMarker", () => {
	it("shows all, some or none", () => {
		assert.equal(groupMarker(2, 2), "[x]");
		assert.equal(groupMarker(1, 2), "[-]");
		assert.equal(groupMarker(0, 2), "[ ]");
	});
});
