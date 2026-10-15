/**
 * Small building blocks for the /whatsapp submenus: a list menu (choices,
 * checkboxes and buttons, each with a short description), a text input step,
 * and a stack that lets menus open deeper menus and go back with Esc.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface MenuItem {
	id: string;
	label: string;
	/** Shown in a column next to the label. */
	detail?: string;
	/** Shown under the list while this item is selected. */
	description?: string;
	/** Text before the label, e.g. "●", "[x]". */
	marker?: string;
	/** Indentation level (for nested checklists). */
	indent?: number;
	/** Rendered as a button line, separated from the list. */
	button?: boolean;
	/** Can't be selected (section labels, info lines). */
	disabled?: boolean;
}

export interface ListMenuOptions {
	title: string;
	description?: string;
	items: MenuItem[];
	/** Enter on an item. */
	onSelect?(item: MenuItem): void;
	/** Space on an item (defaults to onSelect). */
	onToggle?(item: MenuItem): void;
	onCancel(): void;
	hint?: string;
	initialId?: string;
	maxVisible?: number;
}

export class ListMenu implements Component {
	private items: MenuItem[];
	private index = 0;
	private status: { text: string; tone: "info" | "ok" | "error" } | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly options: ListMenuOptions,
	) {
		this.items = options.items;
		const initial = options.initialId ? this.items.findIndex((item) => item.id === options.initialId) : -1;
		this.index = initial >= 0 ? initial : this.firstEnabled();
	}

	setItems(items: MenuItem[], keepId?: string): void {
		const currentId = keepId ?? this.items[this.index]?.id;
		this.items = items;
		const found = items.findIndex((item) => item.id === currentId);
		this.index = found >= 0 ? found : this.firstEnabled();
	}

	setStatus(text: string | undefined, tone: "info" | "ok" | "error" = "info"): void {
		this.status = text ? { text, tone } : undefined;
	}

	selected(): MenuItem | undefined {
		return this.items[this.index];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "escape")) this.options.onCancel();
		else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = this.selected();
			if (item && !item.disabled) this.options.onSelect?.(item);
		} else if (matchesKey(data, "space")) {
			const item = this.selected();
			if (item && !item.disabled) (this.options.onToggle ?? this.options.onSelect)?.(item);
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [t.fg("accent", t.bold(this.options.title))];
		if (this.options.description) {
			for (const line of wrapTextWithAnsi(t.fg("muted", this.options.description), width)) lines.push(line);
		}
		lines.push("");

		const labelWidth = Math.min(
			Math.max(...this.items.map((item) => (item.indent ?? 0) * 2 + (item.marker ? item.marker.length + 1 : 0) + item.label.length), 10) + 2,
			Math.floor(width * 0.6),
		);
		const maxVisible = this.options.maxVisible ?? 14;
		const start = Math.max(0, Math.min(this.index - Math.floor(maxVisible / 2), this.items.length - maxVisible));
		const visible = this.items.slice(start, start + maxVisible);
		visible.forEach((item, offset) => {
			const selected = start + offset === this.index;
			if (item.button) lines.push("");
			const pointer = selected ? t.fg("accent", "→ ") : "  ";
			const indent = "  ".repeat(item.indent ?? 0);
			const text = `${indent}${item.marker ? `${item.marker} ` : ""}${item.label}`;
			const label = item.disabled ? t.fg("dim", text) : selected ? t.fg("accent", text) : text;
			const padded = label + " ".repeat(Math.max(1, labelWidth - text.length));
			const detail = item.detail ? t.fg("dim", item.detail) : "";
			lines.push(truncateToWidth(`${pointer}${padded}${detail}`, width));
		});
		if (this.items.length > maxVisible) lines.push(t.fg("dim", `  (${this.index + 1}/${this.items.length})`));

		lines.push("");
		if (this.status) {
			const color = this.status.tone === "error" ? "error" : this.status.tone === "ok" ? "success" : "warning";
			for (const line of wrapTextWithAnsi(t.fg(color, this.status.text), width)) lines.push(line);
		}
		const description = this.selected()?.description;
		if (description) for (const line of wrapTextWithAnsi(t.fg("muted", description), width)) lines.push(line);
		lines.push(t.fg("dim", this.options.hint ?? "↑↓ move · Enter choose · Esc back"));
		return lines;
	}

	private firstEnabled(): number {
		const found = this.items.findIndex((item) => !item.disabled);
		return found >= 0 ? found : 0;
	}

	private move(step: number): void {
		if (this.items.length === 0) return;
		let next = this.index;
		for (let tries = 0; tries < this.items.length; tries++) {
			next = (next + step + this.items.length) % this.items.length;
			if (!this.items[next]!.disabled) break;
		}
		this.index = next;
	}
}

/** A single text field with a title and explanation. */
export class InputStep implements Component {
	private readonly input = new Input();
	private error: string | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly title: string,
		private readonly description: string,
		initial: string,
		onSubmit: (value: string) => string | undefined,
		onCancel: () => void,
	) {
		this.input.setValue(initial);
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			this.error = onSubmit(value);
		};
		this.input.onEscape = onCancel;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const t = this.theme;
		return [
			t.fg("accent", t.bold(this.title)),
			...wrapTextWithAnsi(t.fg("muted", this.description), width),
			"",
			...this.input.render(width),
			"",
			...(this.error ? [t.fg("error", this.error)] : []),
			t.fg("dim", "Enter save · Esc back"),
		];
	}
}

/** Menus that open deeper menus; Esc on the first one closes the whole stack. */
export class MenuStack implements Component {
	private readonly stack: Component[] = [];

	constructor(private readonly onEmpty: () => void) {}

	push(component: Component): void {
		this.stack.push(component);
	}

	/** Goes back one level, or closes when at the first menu. */
	pop(): void {
		this.stack.pop();
		if (this.stack.length === 0) this.onEmpty();
	}

	/** Closes everything. */
	close(): void {
		this.stack.length = 0;
		this.onEmpty();
	}

	top(): Component | undefined {
		return this.stack.at(-1);
	}

	invalidate(): void {
		this.top()?.invalidate();
	}

	handleInput(data: string): void {
		this.top()?.handleInput?.(data);
	}

	render(width: number): string[] {
		return this.top()?.render(width) ?? [];
	}
}

/** Checkbox state for a group: all, some, or none ticked. */
export function groupMarker(ticked: number, total: number): string {
	if (ticked === 0) return "[ ]";
	return ticked === total ? "[x]" : "[-]";
}
