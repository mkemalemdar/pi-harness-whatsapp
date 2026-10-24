// The /whatsapp settings panel. Every row opens a submenu; nothing changes
// while you just look around. Only "Allowed chats" leaves the panel (it uses
// dialogs to type numbers and names) and the panel reopens afterwards.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getLanguage, languageLabel } from "../core/languages.ts";
import {
	applyChoice,
	applyLanguageSelection,
	applyVoiceChoice,
	buildRows,
	CUSTOM,
	downloadQuestion,
	formatSize,
	formatSpeed,
	languageChecklist,
	ON,
	PART_LABELS,
	type PanelRow,
	type PanelState,
	partsDiskMB,
	removalQuestion,
	SPEED_CHOICES,
	type SpeechInfo,
	VOICE_PARTS,
	voiceLabel,
	type VoicePart,
	voicePlan,
} from "../core/panel-model.ts";
import { InputStep, ListMenu, type MenuItem, MenuStack } from "./panel-components.ts";
import { clampSpeed, MAX_SPEED, MIN_SPEED, type VoiceParts } from "../core/settings.ts";
import { type SettingsStore } from "../settings-store.ts";
import { PART_SPECS, RUNTIME_SPEC } from "../voice/models.ts";

export type PanelAction = "contacts" | "qr" | "remove";

export type ConnectionCommand = "connect" | "repair" | "logout";

export interface PanelHost {
	settings: SettingsStore;
	isEnabled(): boolean;
	setEnabled(on: boolean): Promise<void>;
	connectionLabel(): string;
	/** A QR code is on screen waiting to be scanned. */
	isShowingQr(): boolean;
	logFile(): string;
	connectionCommand(command: ConnectionCommand): Promise<void>;
	speechInfo(): SpeechInfo;
	isInstalled(name: string): boolean;
	/** Starts downloading what the settings need, in the background. */
	downloadMissing(): void;
	/** Deletes speech files (stops their downloads first). */
	removeSpeechFiles(names: readonly string[]): Promise<void>;
	/** Downloads the voice if needed and sends a short sample to the owner's WhatsApp. */
	sendVoiceSample(language: string, voiceId: string, onStatus: (text: string) => void): Promise<void>;
}

/** Main-panel lines: "[SECTION]" headers the cursor skips, indented rows, a blank line between sections. */
export function mainItems(rows: readonly PanelRow[]): MenuItem[] {
	const items: MenuItem[] = [];
	for (const row of rows) {
		if (row.kind === "header") {
			if (items.length > 0) items.push({ id: `space:${row.id}`, label: "", disabled: true });
			items.push({ id: row.id, label: `[${row.label}]`, disabled: true, heading: true });
		} else if (row.kind === "info") {
			items.push({ id: row.id, label: row.label, indent: 1, disabled: true });
		} else {
			items.push({
				id: row.id,
				label: row.label,
				indent: 1,
				detail: row.currentValue,
				description: row.locked ?? row.description,
				...(row.locked ? { dimmed: true } : {}),
			});
		}
	}
	return items;
}

/** Shows the panel; resolves with a follow-up action, or undefined when closed. */
export function showPanel(ctx: ExtensionContext, host: PanelHost, focus?: string): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _keybindings, done) => {
		const state = (): PanelState => ({
			settings: host.settings.get(),
			enabled: host.isEnabled(),
			connection: host.connectionLabel(),
			speech: host.speechInfo(),
			logFile: host.logFile(),
		});
		let closed = false;
		let refresh: ReturnType<typeof setInterval> | undefined;
		const finish = (action: PanelAction | undefined) => {
			if (closed) return;
			closed = true;
			if (refresh) clearInterval(refresh);
			done(action);
		};
		const render = () => tui.requestRender();
		const refreshValues = () => {
			main.setItems(mainItems(buildRows(state())));
			render();
		};
		const stack = new MenuStack(() => finish(undefined), refreshValues);
		const base = { host, theme, stack, render, refreshValues: () => refreshValues(), finish: (action: PanelAction) => finish(action) };

		const main: ListMenu = new ListMenu(theme, {
			title: "WhatsApp settings",
			items: mainItems(buildRows(state())),
			...(focus ? { initialId: focus } : {}),
			maxVisible: 40,
			hint: "↑↓ move · Enter open · Esc close",
			onCancel: () => stack.pop(),
			onSelect: (item) => {
				const row = buildRows(state()).find((candidate) => candidate.id === item.id);
				if (!row) return;
				if (row.locked) {
					main.setStatus("tick “Reply with voice notes” in Voice notes first", "info", row.id);
					render();
					return;
				}
				if (row.kind === "contacts" || row.kind === "remove") {
					finish(row.kind);
					return;
				}
				stack.push(openSubmenu(row, { ...base, path: `WhatsApp › ${row.section ?? ""}` }));
				render();
			},
		});
		stack.push(main);

		// The connection changes on its own (QR, connected…). Keep it current, and
		// close as soon as a QR code shows so the panel doesn't cover it.
		let shown = host.connectionLabel();
		refresh = setInterval(() => {
			if (host.isShowingQr()) {
				finish("qr");
				return;
			}
			const label = host.connectionLabel();
			if (label === shown) return;
			shown = label;
			refreshValues();
		}, 250);
		refresh.unref?.();

		return {
			render: (width: number) => stack.render(width),
			invalidate: () => stack.invalidate(),
			handleInput: (data: string) => {
				stack.handleInput(data);
				render();
			},
		};
	});
}

export interface SubmenuContext {
	/** Breadcrumb so far, e.g. "WhatsApp › Technical". */
	path: string;
	host: PanelHost;
	theme: Theme;
	stack: MenuStack;
	render(): void;
	refreshValues(): void;
	/** Closes the panel with a follow-up action. */
	finish(action: PanelAction): void;
}

function openSubmenu(row: PanelRow, context: SubmenuContext): Component {
	switch (row.kind) {
		case "languages":
			return languagesMenu(row, context);
		case "voices":
			return voicesMenu(row, context);
		case "speed":
			return speedMenu(row, context);
		case "voiceNotes":
			return voiceNotesMenu(context);
		case "connection":
			return connectionMenu(row, context);
		default:
			return choiceMenu(row, context);
	}
}

function choiceMenu(row: PanelRow, context: SubmenuContext): Component {
	const { host, theme, stack } = context;
	const items: MenuItem[] = (row.choices ?? []).map((choice) => ({
		id: choice.value,
		label: choice.label,
		marker: choice.value === row.current ? "●" : " ",
		...(choice.detail ? { detail: choice.detail } : {}),
		...(choice.disabled ? { disabled: true } : {}),
	}));
	return new ListMenu(theme, {
		title: `${context.path} › ${row.label}`,
		description: row.description,
		items,
		...(row.current ? { initialId: row.current } : {}),
		onCancel: () => stack.pop(),
		onSelect: (item) => {
			if (row.id === "whatsapp") {
				void host.setEnabled(item.id === ON);
			} else {
				host.settings.update((draft) => {
					applyChoice(draft, row.id, item.id);
				});
			}
			stack.pop();
		},
	});
}

function languagesMenu(row: PanelRow, context: SubmenuContext): Component {
	const { host, theme, stack, render } = context;
	const entries = languageChecklist(host.settings.get());
	const ticked = new Set(entries.filter((entry) => entry.checked).map((entry) => entry.id));
	const toItems = (): MenuItem[] =>
		entries.map((entry) => ({ id: entry.id, label: entry.label, marker: ticked.has(entry.id) ? "[x]" : "[ ]" }));
	const menu: ListMenu = new ListMenu(theme, {
		title: `${context.path} › ${row.label}`,
		description: `${row.description} Ticked languages keep their order; new ones are added at the end.`,
		items: toItems(),
		hint: "↑↓ move · Space/Enter tick · Esc save and back",
		onToggle: (item) => {
			if (ticked.has(item.id)) {
				if (ticked.size === 1) {
					menu.setStatus("keep at least one language", "error", item.id);
					render();
					return;
				}
				ticked.delete(item.id);
			} else {
				ticked.add(item.id);
			}
			menu.setStatus(undefined);
			menu.setItems(toItems());
			render();
		},
		onCancel: () => {
			host.settings.update((draft) =>
				applyLanguageSelection(
					draft,
					entries.map((entry) => entry.id).filter((id) => ticked.has(id)),
				),
			);
			stack.pop();
		},
	});
	return menu;
}

function voicesMenu(row: PanelRow, context: SubmenuContext): Component {
	const { host, theme, stack } = context;
	const languageItems = (): MenuItem[] => {
		const settings = host.settings.get();
		return settings.languages.map((code) => ({
			id: code,
			label: languageLabel(code),
			detail: voiceLabel(code, settings.voices[code]),
		}));
	};
	const languages: ListMenu = new ListMenu(theme, {
		title: `${context.path} › ${row.label}`,
		description: row.description,
		items: languageItems(),
		onCancel: () => stack.pop(),
		onSelect: (item) => stack.push(voiceList(item.id, context, () => languages.setItems(languageItems()))),
	});
	return languages;
}

function voiceList(code: string, context: SubmenuContext, onChanged: () => void): Component {
	const { host, theme, stack } = context;
	const language = getLanguage(code)!;
	const items = (): MenuItem[] => {
		const current = host.settings.get().voices[code];
		return language.voices.map((voice) => ({
			id: voice.id,
			label: voice.label,
			marker: voice.id === current ? "●" : " ",
			...(voice.id === current ? { detail: "in use" } : {}),
		}));
	};
	const current = host.settings.get().voices[code];
	const list: ListMenu = new ListMenu(theme, {
		title: `${context.path} › Voice per language › ${languageLabel(code)}`,
		description: "Pick a voice to use it, or get a sample on WhatsApp first.",
		items: items(),
		...(current ? { initialId: current } : {}),
		onCancel: () => stack.pop(),
		onSelect: (item) =>
			stack.push(
				voiceActions(code, item.id, context, () => {
					list.setItems(items());
					onChanged();
				}),
			),
	});
	return list;
}

function voiceActions(code: string, voiceId: string, context: SubmenuContext, onChanged: () => void): Component {
	const { host, theme, stack, render } = context;
	const voice = getLanguage(code)!.voices.find((option) => option.id === voiceId)!;
	// All voices live in one download, shared by every language.
	const onDisk = () => host.isInstalled("supertonic-3");
	const inUse = () => host.settings.get().voices[code] === voiceId;
	let sending = false;
	const items = (): MenuItem[] => [
		{
			id: "use",
			label: inUse() ? "In use" : "Use this voice",
			disabled: inUse(),
			...(onDisk() || inUse() ? {} : { detail: "downloads when first needed" }),
			description: "Pi speaks your voice replies in this language with this voice.",
		},
		{
			id: "sample",
			label: "Send me a sample on WhatsApp",
			...(onDisk() ? {} : { detail: "downloads the voices first (~400 MB)" }),
			description: "Sends a short voice note in this voice to the owner's WhatsApp.",
		},
		{ id: "back", label: "Back", description: "Back to the voice list." },
	];
	const menu: ListMenu = new ListMenu(theme, {
		title: `${context.path} › ${languageLabel(code)} › ${voice.label}`,
		description: `${languageLabel(code)} voice.`,
		items: items(),
		onCancel: () => stack.pop(),
		onSelect: (item) => {
			if (item.id === "back") {
				stack.pop();
			} else if (item.id === "use") {
				host.settings.update((draft) => applyVoiceChoice(draft, code, voiceId));
				onChanged();
				stack.pop();
			} else if (item.id === "sample" && !sending) {
				sending = true;
				const status = (text: string) => {
					menu.setStatus(text, "info", "sample");
					render();
				};
				host
					.sendVoiceSample(code, voiceId, status)
					.then(() => menu.setStatus("✓ sent to WhatsApp", "ok", "sample"))
					.catch((error: unknown) => menu.setStatus(error instanceof Error ? error.message : String(error), "error", "sample"))
					.finally(() => {
						sending = false;
						menu.setItems(items());
						onChanged();
						render();
					});
			}
		},
	});
	return menu;
}

function speedMenu(row: PanelRow, context: SubmenuContext): Component {
	const { host, theme, stack } = context;
	const current = formatSpeed(host.settings.get().voiceSpeed);
	const isPreset = SPEED_CHOICES.some((choice) => choice.value === current);
	return new ListMenu(theme, {
		title: `${context.path} › ${row.label}`,
		description: row.description,
		items: SPEED_CHOICES.map((choice) => ({
			id: choice.value,
			label: choice.value === CUSTOM && !isPreset ? `custom… (${current})` : choice.label,
			marker: choice.value === current || (choice.value === CUSTOM && !isPreset) ? "●" : " ",
			...(choice.detail ? { detail: choice.detail } : {}),
		})),
		initialId: isPreset ? current : CUSTOM,
		onCancel: () => stack.pop(),
		onSelect: (item) => {
			if (item.id !== CUSTOM) {
				host.settings.update((draft) => {
					applyChoice(draft, "voiceSpeed", item.id);
				});
				stack.pop();
				return;
			}
			stack.push(
				new InputStep(
					theme,
					`${context.path} › Voice reply speed › Custom`,
					`A number from ${formatSpeed(MIN_SPEED)} to ${formatSpeed(MAX_SPEED)}, e.g. 1.15. 1.0 is normal.`,
					current,
					(value) => {
						const speed = Number.parseFloat(value.replace(",", "."));
						if (!Number.isFinite(speed)) return "Please type a number, e.g. 1.15";
						host.settings.update((draft) => {
							draft.voiceSpeed = clampSpeed(speed);
						});
						stack.home();
						return undefined;
					},
					() => stack.pop(),
				),
			);
		},
	});
}

/** The two voice switches. Downloads and deletions happen when you leave, after asking. */
export function voiceNotesMenu(context: SubmenuContext): Component {
	const { host, theme, render } = context;
	const before = { ...host.settings.get().voice };
	const ticked = { ...before };
	let deleteAll = false;
	const items = (): MenuItem[] => {
		const speech = host.speechInfo();
		const part = (id: VoicePart, kind: string, description: string): MenuItem => {
			const files = PART_SPECS[id].map((spec) => spec.name);
			const state = files.every((name) => speech.installed.has(name))
				? " · ✓ on disk"
				: files.some((name) => speech.downloading.has(name))
					? " · downloading"
					: "";
			return {
				id,
				label: PART_LABELS[id],
				marker: ticked[id] ? "[x]" : "[ ]",
				detail: `${kind} · ${formatSize(partsDiskMB([id]))}${state}`,
				description,
			};
		};
		return [
			part("understand", "speech-to-text", "Pi transcribes the voice notes you send and answers them. Off: a voice note gets “Voice notes are off. Please type your message.”"),
			part("reply", "text-to-speech", "Pi can answer with voice notes (see Reply type, voices and speed). Off: Pi always answers with text."),
			{
				id: "deleteAll",
				label: "[ Delete all speech files ]",
				button: true,
				description: "Unticks both. The files are deleted when you leave this menu, after you confirm.",
			},
		];
	};
	const menu: ListMenu = new ListMenu(theme, {
		title: `${context.path} › Voice notes`,
		description: `Optional. Both parts share a ${formatSize(RUNTIME_SPEC.diskMB)} engine, so together they take ${formatSize(partsDiskMB(VOICE_PARTS))}. Files are downloaded or deleted when you leave this menu.`,
		items: items(),
		hint: "↑↓ move · Space/Enter tick · Esc save and back",
		onSelect: (item) => {
			if (item.id === "deleteAll") {
				ticked.understand = false;
				ticked.reply = false;
				deleteAll = true;
				menu.setStatus("both unticked: deleted when you leave", "info", "deleteAll");
			} else {
				const id = item.id as VoicePart;
				ticked[id] = !ticked[id];
			}
			menu.setItems(items());
			render();
		},
		onCancel: () => leaveVoiceNotes(context, before, ticked, deleteAll),
	});
	return menu;
}

/** Leaving the Voice notes menu: confirm deletions, save, then offer downloads. */
function leaveVoiceNotes(context: SubmenuContext, before: VoiceParts, after: VoiceParts, deleteAll: boolean): void {
	const { host, stack, render } = context;
	const plan = voicePlan(before, after, deleteAll, host.speechInfo());
	// Saves the switches, then asks about downloading what newly switched-on parts need.
	const save = (final: VoiceParts) => {
		host.settings.update((draft) => {
			draft.voice = { ...final };
		});
		context.refreshValues();
		const downloads = voicePlan(before, final, false, host.speechInfo()).download;
		if (downloads.files.length === 0) return;
		stack.push(
			question(context, "Download speech files?", downloadQuestion({ ...plan, download: downloads }), ["Now (recommended)", "When first needed"], (choice) => {
				if (choice === 0) host.downloadMissing();
			}),
		);
	};
	stack.pop();
	if (plan.remove.files.length === 0) {
		save(after);
		return;
	}
	stack.push(
		question(
			context,
			"Remove speech files?",
			removalQuestion(plan),
			["Yes", "No"],
			(choice) => {
				if (choice === 0) {
					save(after);
					void host.removeSpeechFiles(plan.remove.files).finally(() => {
						context.refreshValues();
						render();
					});
				} else {
					// No: the parts switched off are switched on again; nothing is deleted.
					save({ understand: after.understand || before.understand, reply: after.reply || before.reply });
				}
			},
			1,
		),
	);
}

/** A small question screen; Esc picks `escChoice`. Calls `onAnswer` after closing itself. */
function question(
	context: SubmenuContext,
	title: string,
	text: string,
	choices: readonly string[],
	onAnswer: (choice: number) => void,
	escChoice = choices.length - 1,
): Component {
	const { theme, stack } = context;
	const answer = (choice: number) => {
		stack.pop();
		onAnswer(choice);
	};
	return new ListMenu(theme, {
		title: `${context.path} › ${title}`,
		description: text,
		items: choices.map((label, index) => ({ id: String(index), label })),
		onCancel: () => answer(escChoice),
		onSelect: (item) => answer(Number(item.id)),
	});
}

function connectionMenu(row: PanelRow, context: SubmenuContext): Component {
	const { host, theme, stack, render } = context;
	const confirm = (title: string, description: string, yes: string, command: ConnectionCommand): Component =>
		new ListMenu(theme, {
			title: `${context.path} › Connection › ${title}`,
			description,
			items: [
				{ id: "yes", label: yes },
				{ id: "no", label: "Cancel" },
			],
			initialId: "no",
			onCancel: () => stack.pop(),
			onSelect: (item) => {
				if (item.id === "no") {
					stack.pop();
					return;
				}
				void host.connectionCommand(command).finally(render);
				stack.home();
			},
		});
	const connected = host.connectionLabel().startsWith("connected");
	const items: MenuItem[] = [
		{
			id: "connect",
			label: host.isEnabled() ? (connected ? "Reconnect" : "Connect now") : "Turn WhatsApp on and connect",
			description: "Starts (or restarts) the connection with the saved login.",
		},
		{
			id: "repair",
			label: "Show a new QR code (pair again)",
			description: "Unlinks the current login on this machine and shows a new QR code to scan.",
		},
		{
			id: "logout",
			label: "Log out (unlink this device)",
			description: "Removes Pi from the phone's Linked devices. You'll need to scan a QR code again.",
		},
	];
	return new ListMenu(theme, {
		title: `${context.path} › ${row.label}`,
		description: `Now: ${host.connectionLabel()}`,
		items,
		onCancel: () => stack.pop(),
		onSelect: (item) => {
			if (item.id === "connect") {
				void host.connectionCommand("connect").finally(render);
				stack.home();
			} else if (item.id === "repair") {
				stack.push(
					confirm(
						"Pair again?",
						"This unlinks the current WhatsApp login on this machine and shows a new QR code.",
						"Yes, show a new QR code",
						"repair",
					),
				);
			} else if (item.id === "logout") {
				stack.push(
					confirm(
						"Log out of WhatsApp?",
						"Pi is removed from the phone's Linked devices. You'll need to scan a QR code again to use it.",
						"Yes, log out",
						"logout",
					),
				);
			}
		},
	});
}
