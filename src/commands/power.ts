/** /new, /off, /quit, /restart — the last three ask for confirmation first. */

import { spawn, spawnSync } from "node:child_process";
import { createLogger } from "../log.ts";
import { notifyTerminal, type Command, type CommandEnv } from "./types.ts";

const log = createLogger("power");

/** Set in the systemd unit (see README) to the unit's name, e.g. "pi-whatsapp". */
export const SERVICE_ENV = "PI_HARNESS_WHATSAPP_SERVICE";

export interface ServiceInfo {
	name: string;
	/** Extra systemctl arguments: ["--user"] for a user service. */
	scope: string[];
}

/** The systemd service Pi runs in, if any. A user service is tried first (no sudo needed). */
export function detectService(
	env: NodeJS.ProcessEnv = process.env,
	isActive: (scope: string[], name: string) => boolean = systemctlIsActive,
): ServiceInfo | undefined {
	const name = env[SERVICE_ENV]?.trim();
	if (!name || !/^[\w@.-]+$/.test(name)) return undefined;
	for (const scope of [["--user"], []]) {
		if (isActive(scope, name)) return { name, scope };
	}
	return undefined;
}

function systemctlIsActive(scope: string[], name: string): boolean {
	const result = spawnSync("systemctl", [...scope, "is-active", "--quiet", name], { stdio: "ignore", timeout: 5000 });
	return result.status === 0;
}

/** Asks systemd to restart or stop the service. --no-block: systemd does it after this returns. */
export function serviceAction(service: ServiceInfo, action: "restart" | "stop"): void {
	const child = spawn("systemctl", [...service.scope, "--no-block", action, service.name], { detached: true, stdio: "ignore" });
	child.on("error", (error) => log.error(`systemctl ${action} failed`, error));
	child.unref();
}

async function confirm(
	env: CommandEnv,
	chatJid: string,
	kind: string,
	title: string,
	yesLabel: string,
	onYes: () => Promise<string | undefined>,
): Promise<undefined> {
	await env.menus.show(chatJid, {
		kind,
		title,
		gated: true,
		options: [
			{ label: yesLabel, value: "yes" },
			{ label: "Cancel", value: "no" },
		],
		onPick: async ([value]) => (value === "yes" ? onYes() : "Cancelled."),
	});
	return undefined;
}

export function powerCommands(): Command[] {
	return [
		{
			name: "new",
			usage: "/new",
			summary: "start a fresh Pi session (the old one stays saved)",
			gated: true,
			run: async (_args, request, env) => {
				const ctx = env.getCtx();
				if (!ctx) return "Pi has no active session.";
				if (!ctx.isIdle()) return "Pi is working right now. Wait for it to finish, or /stop first.";
				notifyTerminal(env, "new session requested from WhatsApp");
				env.startNewSession(request.chatJid);
				return undefined;
			},
		},
		{
			name: "off",
			usage: "/off",
			summary: "turn WhatsApp off (back on only from the terminal)",
			gated: true,
			run: async (_args, request, env) =>
				confirm(
					env,
					request.chatJid,
					"off",
					"Turn Pi's WhatsApp off? It can only be turned back on from the terminal or by restarting Pi.",
					"Yes, turn off",
					async () => {
						await env.queue.sendText(request.chatJid, "👋 WhatsApp is off now. Turn it back on in the terminal with /whatsapp.");
						notifyTerminal(env, "turned off from WhatsApp");
						await env.setEnabled(false);
						return undefined;
					},
				),
		},
		{
			name: "quit",
			aliases: ["exit"],
			usage: "/quit",
			summary: "shut Pi down",
			gated: true,
			run: async (_args, request, env) =>
				confirm(env, request.chatJid, "quit", "Quit Pi on the computer?", "Yes, quit Pi", async () => {
					const ctx = env.getCtx();
					if (!ctx) return "Pi has no active session.";
					const busy = !ctx.isIdle();
					await env.queue.sendText(
						request.chatJid,
						busy ? "👋 Pi will quit when the current task finishes (send /stop to end it now)." : "👋 Quitting Pi.",
					);
					notifyTerminal(env, "quit requested from WhatsApp");
					log.info("quit requested from WhatsApp");
					// Under systemd (Restart=always), a plain exit would just start Pi again.
					const service = detectService();
					if (service) serviceAction(service, "stop");
					else ctx.shutdown();
					return undefined;
				}),
		},
		{
			name: "restart",
			usage: "/restart",
			summary: "restart Pi (when it runs as a systemd service, see the README)",
			gated: true,
			run: async (_args, request, env) => {
				const service = detectService();
				if (!service) {
					return "Restart only works when Pi runs as a systemd service (see “Run in the background” in the README). Use /quit, then start Pi again.";
				}
				return confirm(env, request.chatJid, "restart", "Restart Pi? It continues this session with WhatsApp on.", "Yes, restart", async () => {
					await env.queue.sendText(request.chatJid, "🔄 Restarting Pi… I'll be back in a few seconds.");
					notifyTerminal(env, "restart requested from WhatsApp");
					log.info(`restart requested from WhatsApp (systemctl ${service.scope.join(" ")} restart ${service.name})`);
					env.markRestartRequested(request.chatJid);
					serviceAction(service, "restart");
					return undefined;
				});
			},
		},
	];
}
