// What the WhatsApp commands (/help, /model, /status …) may use from the controller, and their shared types.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsStore } from "../settings-store.ts";
import type { InboundMessage } from "../wa/inbound.ts";
import type { SendQueue } from "../wa/outbound.ts";
import type { PollMenus } from "../wa/polls.ts";

/** What commands may use. Implemented by the controller. */
export interface CommandEnv {
	pi: ExtensionAPI;
	getCtx(): ExtensionContext | undefined;
	settings: SettingsStore;
	queue: SendQueue;
	menus: PollMenus;
	connectionLabel(): string;
	isAutoCompactEnabled(): boolean;
	setAutoCompact(on: boolean): void;
	setEnabled(on: boolean): Promise<void>;
	/** Remembers the chat that asked for /restart, so Pi can say it's back. */
	markRestartRequested(chatJid: string): void;
	/** Starts a new Pi session (the old one stays saved). */
	startNewSession(chatJid: string): void;
	/** One line about voice (models downloaded, etc.), when voice support is loaded. */
	voiceStatus?(): string;
}

export interface CommandRequest {
	chatJid: string;
	message: InboundMessage;
	/** The sender may change Pi (owner, or everyone when access is "all allowed contacts"). */
	mayChange: boolean;
}

export interface Command {
	name: string;
	aliases?: string[];
	/** Shown in /help. */
	usage: string;
	summary: string;
	/** Changes Pi: limited by "Command access". */
	gated: boolean;
	/** Returns text to send back, or nothing when the command replies itself. */
	run(args: string, request: CommandRequest, env: CommandEnv): Promise<string | undefined>;
}

/** Tells the user something happened from WhatsApp, in the terminal. */
export function notifyTerminal(env: CommandEnv, text: string): void {
	env.getCtx()?.ui.notify(`WhatsApp: ${text}`, "info");
}
