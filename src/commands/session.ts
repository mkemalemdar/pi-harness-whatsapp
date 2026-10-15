/** /help, /status, /stop, /compact, /autocompact */

import { languageLabel } from "../languages.ts";
import { formatSpeed, REPLY_TOGGLES, replyLanguageLabel, VOICE_MODE_LABELS } from "../panel-model.ts";
import { formatDuration } from "../run-report.ts";
import { replyMode } from "../settings.ts";
import { notifyTerminal, type Command, type CommandEnv } from "./types.ts";

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/** "✅ Compacted in 18s · 142k → 23k tokens (−84%) · context 89% free" */
export function formatCompaction(result: { tokensBefore: number; estimatedTokensAfter?: number }, ms: number, contextWindow?: number): string {
	const parts = [`✅ Compacted in ${formatDuration(ms)}`];
	const after = result.estimatedTokensAfter;
	if (after !== undefined && result.tokensBefore > 0) {
		const saved = Math.round((1 - after / result.tokensBefore) * 100);
		parts.push(`${formatTokens(result.tokensBefore)} → ${formatTokens(after)} tokens (−${saved}%)`);
	} else {
		parts.push(`${formatTokens(result.tokensBefore)} tokens before`);
	}
	if (after !== undefined && contextWindow) {
		parts.push(`context ${Math.max(0, Math.round(100 - (after / contextWindow) * 100))}% free`);
	}
	return parts.join(" · ");
}

function contextLine(env: CommandEnv): string {
	const usage = env.getCtx()?.getContextUsage();
	if (!usage) return "Context: unknown";
	const used = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
	return `Context: ${used} used of ${formatTokens(usage.contextWindow)} · auto-compact ${env.isAutoCompactEnabled() ? "on" : "off"}`;
}

function modelLine(env: CommandEnv): string {
	const model = env.getCtx()?.model;
	return `Model: ${model ? `${model.provider}/${model.id}` : "none"} · thinking ${env.pi.getThinkingLevel()}`;
}

function settingsLines(env: CommandEnv): string[] {
	const settings = env.settings.get();
	const replies = REPLY_TOGGLES.map((toggle) => `${toggle.label.toLowerCase()} ${settings.replies[toggle.key] ? "✓" : "✗"}`).join(", ");
	const { understand, reply } = settings.voice;
	return [
		`Voice notes: understand ${understand ? "✓" : "✗"} · reply ${reply ? "✓" : "✗"}${understand || reply ? "" : " (turn on in the terminal: /whatsapp → Voice notes)"}`,
		reply ? `Reply type: ${VOICE_MODE_LABELS[replyMode(settings)]} · voice reply speed ${formatSpeed(settings.voiceSpeed)}` : "Reply type: text",
		`Reply language: ${replyLanguageLabel(settings.replyLanguage)} · languages: ${settings.languages.map(languageLabel).join(", ")}`,
		`Replies: final ✓, ${replies}`,
		...(env.voiceStatus ? [env.voiceStatus()] : []),
	];
}

export function statusText(env: CommandEnv): string {
	const ctx = env.getCtx();
	const busy = ctx && !ctx.isIdle() ? "working…" : "idle";
	return ["*Pi status*", `WhatsApp: ${env.connectionLabel()}`, `Pi: ${busy}`, modelLine(env), contextLine(env), ...settingsLines(env)].join("\n");
}

export function sessionCommands(): Command[] {
	return [
		{
			name: "help",
			aliases: ["h", "commands"],
			usage: "/help",
			summary: "this list and the current settings",
			gated: false,
			run: async (_args, _request, env) => {
				// Imported lazily to avoid a cycle with the router.
				const { allCommands } = await import("./router.ts");
				const list = allCommands().map((command) => `${command.usage} — ${command.summary}${command.gated ? "" : " (anyone)"}`);
				return [
					"*Pi on WhatsApp*",
					modelLine(env),
					contextLine(env),
					...settingsLines(env),
					"",
					"*Commands*",
					...list,
					"",
					`Anything else you send goes to Pi. Images and files work too${env.settings.get().voice.understand ? ", and voice notes" : ""}.`,
				].join("\n");
			},
		},
		{
			name: "status",
			usage: "/status",
			summary: "connection, model, context and settings",
			gated: false,
			run: async (_args, _request, env) => statusText(env),
		},
		{
			name: "stop",
			aliases: ["abort", "cancel"],
			usage: "/stop",
			summary: "stop what Pi is doing",
			gated: true,
			run: async (_args, _request, env) => {
				const ctx = env.getCtx();
				if (!ctx || ctx.isIdle()) return "Nothing is running.";
				ctx.abort();
				notifyTerminal(env, "stopped from WhatsApp");
				return undefined; // The run's own "⏹ Stopped." reply follows.
			},
		},
		{
			name: "compact",
			usage: "/compact [focus]",
			summary: "shrink the conversation context",
			gated: true,
			run: async (args, request, env) => {
				const ctx = env.getCtx();
				if (!ctx) return "Pi has no active session.";
				if (!ctx.isIdle()) return "Pi is working right now. Wait for it to finish, or /stop first.";
				const started = Date.now();
				await env.queue.sendText(request.chatJid, "🗜 Compacting…");
				notifyTerminal(env, "compacting (requested from WhatsApp)");
				await new Promise<void>((resolve) => {
					ctx.compact({
						...(args ? { customInstructions: args } : {}),
						onComplete: (result) => {
							const window = env.getCtx()?.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
							void env.queue.sendText(request.chatJid, formatCompaction(result, Date.now() - started, window));
							resolve();
						},
						onError: (error) => {
							void env.queue.sendText(request.chatJid, `⚠️ Compaction failed: ${error.message}`);
							resolve();
						},
					});
				});
				return undefined;
			},
		},
		{
			name: "autocompact",
			usage: "/autocompact [on|off]",
			summary: "automatic compaction for this session",
			gated: true,
			run: async (args, request, env) => {
				const apply = (on: boolean) => {
					env.setAutoCompact(on);
					notifyTerminal(env, `auto-compaction ${on ? "on" : "off"} (from WhatsApp)`);
					return on
						? "✅ Auto-compaction on."
						: "✅ Auto-compaction off for this session. (Pi still compacts if the context is completely full.)";
				};
				if (/^(on|off)$/i.test(args)) return apply(args.toLowerCase() === "on");
				const current = env.isAutoCompactEnabled();
				await env.menus.show(request.chatJid, {
					kind: "autocompact",
					title: `Auto-compaction (now ${current ? "on" : "off"})`,
					gated: true,
					options: [
						{ label: `${current ? "✓ " : ""}On`, value: "on" },
						{ label: `${current ? "" : "✓ "}Off`, value: "off" },
					],
					onPick: async ([value]) => apply(value === "on"),
				});
				return undefined;
			},
		},
	];
}
