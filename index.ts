/**
 * pi-harness-whatsapp — talk to Pi from WhatsApp.
 *
 * This file only wires Pi's extension API to the Controller. Nothing is
 * started here: connections begin in session_start, as Pi requires.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Controller, NEW_SESSION_ARG } from "./src/controller.ts";
import { registerTools, setToolsActive, TOOL_NAMES } from "./src/tools.ts";

export default function piHarnessWhatsApp(pi: ExtensionAPI) {
	pi.registerFlag("whatsapp", {
		description: "Turn WhatsApp on for this session (also in print/JSON mode)",
		type: "boolean",
		default: false,
	});

	const controller = new Controller(pi);
	const bridge = controller.bridge;
	registerTools(pi, controller);
	controller.onToolsChanged = (on) => setToolsActive(pi, on);

	pi.registerCommand("whatsapp", {
		description: "WhatsApp settings: on/off, replies, voice, languages, contacts, connection",
		handler: async (args, ctx) => {
			// Internal: "/new" from WhatsApp dispatches this so Pi gives us a real command context.
			if (args.trim() === NEW_SESSION_ARG) {
				await ctx.waitForIdle();
				await ctx.newSession();
				return;
			}
			await controller.openSettings(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		await controller.onSessionStart(event, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Moving to another branch can change the saved on/off state.
		await controller.onBranchChange(ctx);
	});

	pi.on("session_shutdown", async () => {
		await controller.onSessionShutdown();
	});

	pi.on("session_before_compact", async (event) => {
		// "/autocompact off": skip threshold compactions. Overflow recovery still runs,
		// because without it the conversation could not continue.
		if (event.reason === "threshold" && !controller.isAutoCompactEnabled()) return { cancel: true };
		return undefined;
	});

	pi.on("before_agent_start", async (event) => {
		if (!controller.isEnabled()) return;
		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			whatsapp: bridge.systemPromptSection(),
		};
	});

	pi.on("agent_start", async () => {
		// Tracked even while off, so the bridge knows whether Pi is in a run.
		bridge.onAgentStart();
	});

	pi.on("turn_start", async () => {
		if (controller.isEnabled()) bridge.onTurnStart();
	});

	pi.on("message_end", async (event) => {
		if (!controller.isEnabled()) return;
		if (event.message.role === "user") bridge.onUserMessage(event.message);
		else if (event.message.role === "assistant") bridge.onAssistantMessage(event.message);
	});

	pi.on("tool_execution_start", async (event) => {
		if (controller.isEnabled() && !event.parentToolCallId) bridge.onToolStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", async (event) => {
		if (controller.isEnabled() && !event.parentToolCallId) bridge.onToolEnd(event.toolCallId, event.isError);
	});

	pi.on("tool_result", async (event) => {
		// "Forward images from tools": screenshots etc. go to the chat Pi is answering.
		if (!controller.isEnabled() || !controller.settings.get().forwardToolImages) return;
		if (event.parentToolCallId || event.toolName === "read" || (TOOL_NAMES as readonly string[]).includes(event.toolName)) return;
		await bridge.forwardImages(event.content, event.toolName);
	});

	pi.on("agent_settled", async (event) => {
		await bridge.onSettled(event.aborted);
	});
}
