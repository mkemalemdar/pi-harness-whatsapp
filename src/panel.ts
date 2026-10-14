/**
 * The /whatsapp settings panel (terminal UI). Rows come from panel-model.ts;
 * rows that need dialogs (contacts, connection, custom speed) close the panel
 * and return an action, and the caller reopens it afterwards.
 */

import { type ExtensionContext, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	applyLanguageToggle,
	applyRowChange,
	applyVoiceChoice,
	buildRows,
	CUSTOM,
	languageRows,
	OFF,
	ON,
	type PanelState,
	SPEED_CHOICES,
	voiceRows,
} from "./panel-model.ts";
import type { SettingsStore } from "./settings.ts";

export type PanelAction = "contacts" | "connection" | "customSpeed" | "reopen" | "qr";

export interface PanelHost {
	settings: SettingsStore;
	isEnabled(): boolean;
	setEnabled(on: boolean): Promise<void>;
	connectionLabel(): string;
	/** A QR code is on screen waiting to be scanned. */
	isShowingQr(): boolean;
}

/** Shows the panel once; resolves with the follow-up action, or undefined when closed. */
export function showPanel(ctx: ExtensionContext, host: PanelHost): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _keybindings, done) => {
		const state = (): PanelState => ({
			settings: host.settings.get(),
			enabled: host.isEnabled(),
			connection: host.connectionLabel(),
		});
		let closed = false;
		let refresh: ReturnType<typeof setInterval> | undefined;
		const finish = (action: PanelAction | undefined) => {
			if (closed) return;
			closed = true;
			if (refresh) clearInterval(refresh);
			done(action);
		};
		const placeholder: Component = { render: () => [], invalidate() {} };

		const items: SettingItem[] = buildRows(state()).map((row) => {
			const item: SettingItem = {
				id: row.id,
				label: row.label,
				description: row.description,
				currentValue: row.currentValue,
			};
			if (row.values) item.values = row.values;
			if (row.kind === "action") {
				item.submenu = () => {
					finish(row.id as PanelAction);
					return placeholder;
				};
			} else if (row.kind === "languages") {
				item.submenu = (_value, close) => languagesSubmenu(host, () => close(undefined), () => finish("reopen"));
			} else if (row.kind === "voices") {
				item.submenu = (_value, close) => voicesSubmenu(host, () => close(undefined), () => finish("reopen"));
			} else if (row.kind === "speed") {
				item.submenu = (value, close) =>
					speedSubmenu(value, (picked) => {
						if (picked === CUSTOM) finish("customSpeed");
						else close(picked);
					});
			}
			return item;
		});

		const list = new SettingsList(
			items,
			Math.min(items.length, 18),
			getSettingsListTheme(),
			(id, value) => {
				if (id === "whatsapp") {
					void host.setEnabled(value === ON).then(() => {
						list.updateValue("connection", host.connectionLabel());
						tui.requestRender();
					});
					return;
				}
				host.settings.update((draft) => {
					applyRowChange(draft, id, value);
				});
				// Show what was actually saved: values get normalized, and some rows summarize others.
				for (const row of buildRows(state())) list.updateValue(row.id, row.currentValue);
			},
			() => finish(undefined),
		);

		// The connection state changes on its own (QR, connected…); keep that row current.
		let shownConnection = host.connectionLabel();
		refresh = setInterval(() => {
			// Close as soon as a QR code shows, so the panel doesn't cover it.
			if (host.isShowingQr()) {
				finish("qr");
				return;
			}
			const label = host.connectionLabel();
			if (label === shownConnection) return;
			shownConnection = label;
			list.updateValue("connection", label);
			list.updateValue("whatsapp", host.isEnabled() ? ON : OFF);
			tui.requestRender();
		}, 250);
		refresh.unref?.();

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("WhatsApp settings")), 0, 0));
		container.addChild(list);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function languagesSubmenu(host: PanelHost, close: () => void, reopen: () => void): Component {
	let changed = false;
	const list = new SettingsList(
		languageRows(host.settings.get()),
		12,
		getSettingsListTheme(),
		(code, value) => {
			let accepted = true;
			host.settings.update((draft) => {
				accepted = applyLanguageToggle(draft, code, value);
			});
			if (!accepted) list.updateValue(code, ON);
			else changed = true;
		},
		() => (changed ? reopen() : close()),
		{ enableSearch: true },
	);
	return list;
}

function voicesSubmenu(host: PanelHost, close: () => void, reopen: () => void): Component {
	let changed = false;
	return new SettingsList(
		voiceRows(host.settings.get()),
		10,
		getSettingsListTheme(),
		(code, label) => {
			host.settings.update((draft) => applyVoiceChoice(draft, code, label));
			changed = true;
		},
		() => (changed ? reopen() : close()),
	);
}

function speedSubmenu(current: string, pick: (value: string | undefined) => void): Component {
	const choices = SPEED_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }));
	const list = new SelectList(choices, choices.length, getSelectListTheme());
	const index = choices.findIndex((choice) => choice.value === current);
	list.setSelectedIndex(index >= 0 ? index : choices.length - 1);
	list.onSelect = (item) => pick(item.value);
	list.onCancel = () => pick(undefined);
	return list;
}
