/**
 * WhatsApp commands ("/help", "/model", …). They are handled here and never
 * reach the model. Commands that change Pi respect "Command access".
 */

import type { CommandHandler } from "../bridge.ts";
import { createLogger } from "../log.ts";
import type { Access, InboundMessage } from "../wa/inbound.ts";
import { modelCommands } from "./model.ts";
import { powerCommands } from "./power.ts";
import { sessionCommands } from "./session.ts";
import { settingsCommands } from "./settings-commands.ts";
import type { Command, CommandEnv } from "./types.ts";

const log = createLogger("commands");

export function allCommands(): Command[] {
	return [...sessionCommands(), ...modelCommands(), ...settingsCommands(), ...powerCommands()];
}

/** "/Model  extra words" → { name: "model", args: "extra words" } */
export function parseCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!match) return undefined;
	return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

export class CommandRouter implements CommandHandler {
	readonly commands: Command[];

	constructor(private readonly env: CommandEnv) {
		this.commands = allCommands();
	}

	find(name: string): Command | undefined {
		return this.commands.find((command) => command.name === name || command.aliases?.includes(name));
	}

	isCommand(text: string): boolean {
		const parsed = parseCommand(text);
		return !!parsed && !!this.find(parsed.name);
	}

	mayChange(access: Access): boolean {
		return access.isOwner || this.env.settings.get().commandAccess === "allowed";
	}

	async handle(message: InboundMessage, access: Access): Promise<boolean> {
		const mayChange = this.mayChange(access);
		if (await this.env.menus.handleNumberReply(message, mayChange)) return true;

		const parsed = parseCommand(message.text);
		if (!parsed) {
			// A normal message for Pi: later bare numbers answer Pi, not an older menu.
			this.env.menus.endNumberReplies(message.chatJid);
			return false;
		}
		const command = this.find(parsed.name);
		if (!command) {
			await this.env.queue.sendText(message.chatJid, `Unknown command /${parsed.name}. Send /help to see what works.`);
			return true;
		}
		if (command.gated && !mayChange) {
			await this.env.queue.sendText(message.chatJid, "🔒 Only the owner can change Pi's settings from WhatsApp.");
			return true;
		}
		// Arguments can be message text (e.g. /compact instructions), which stays out of the log.
		log.info(`/${command.name}`);
		try {
			const reply = await command.run(parsed.args, { chatJid: message.chatJid, message, mayChange }, this.env);
			if (reply) await this.env.queue.sendText(message.chatJid, reply);
		} catch (error) {
			log.error(`/${command.name} failed`, error);
			await this.env.queue.sendText(message.chatJid, `⚠️ /${command.name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return true;
	}

	async handleVote(message: InboundMessage, access: Access): Promise<void> {
		await this.env.menus.handleVote(message, this.mayChange(access));
	}
}
