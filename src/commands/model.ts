// /model and /think

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Command, CommandEnv } from "./types.ts";
import { notifyTerminal } from "./types.ts";

type AnyModel = NonNullable<ReturnType<CommandEnv["getCtx"]>>["model"] & {};

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof ALL_LEVELS)[number];

/** Above this many models, pick the provider first. */
const GROUP_THRESHOLD = 22;

const modelKey = (model: AnyModel) => `${model.provider}/${model.id}`;

async function chooseModel(env: CommandEnv, chatJid: string, models: AnyModel[], title: string): Promise<void> {
	const current = env.getCtx()?.model;
	await env.menus.show(chatJid, {
		kind: "model",
		title,
		gated: true,
		options: models.map((model) => ({
			label: `${current && modelKey(current) === modelKey(model) ? "✓ " : ""}${modelKey(model)}`,
			value: modelKey(model),
		})),
		onPick: async ([key]) => {
			const model = models.find((candidate) => modelKey(candidate) === key);
			if (!model) return "That model is no longer available.";
			const ok = await env.pi.setModel(model);
			if (!ok) return `⚠️ No login or API key for ${model.provider}. Set it up in Pi first.`;
			notifyTerminal(env, `model → ${key} (from WhatsApp)`);
			return `✅ Model → ${key} (this session)`;
		},
	});
}

export function modelCommands(): Command[] {
	return [
		{
			name: "model",
			aliases: ["models", "m"],
			usage: "/model [name]",
			summary: "switch the model for this session",
			gated: true,
			run: async (args, request, env) => {
				const ctx = env.getCtx();
				if (!ctx) return "Pi has no active session.";
				const models = ctx.modelRegistry.getAvailable() as AnyModel[];
				if (models.length === 0) return "No models with a login or API key. Set one up in Pi first.";

				if (args) {
					const needle = args.toLowerCase();
					const matches = models.filter((model) => modelKey(model).toLowerCase().includes(needle));
					if (matches.length === 1) {
						const ok = await env.pi.setModel(matches[0]!);
						if (ok) notifyTerminal(env, `model → ${modelKey(matches[0]!)} (from WhatsApp)`);
						return ok ? `✅ Model → ${modelKey(matches[0]!)} (this session)` : "⚠️ That provider has no login or API key.";
					}
					if (matches.length === 0) return `No available model matches "${args}". Send /model to pick from a list.`;
					await chooseModel(env, request.chatJid, matches, `Models matching "${args}"`);
					return undefined;
				}

				const current = ctx.model ? modelKey(ctx.model) : "none";
				if (models.length <= GROUP_THRESHOLD) {
					await chooseModel(env, request.chatJid, models, `Choose a model (now ${current})`);
					return undefined;
				}
				const providers = [...new Set(models.map((model) => model.provider))].sort();
				await env.menus.show(request.chatJid, {
					kind: "model",
					title: `Choose a provider (now ${current})`,
					gated: true,
					options: providers.map((provider) => ({
						label: `${ctx.model?.provider === provider ? "✓ " : ""}${provider} (${models.filter((model) => model.provider === provider).length})`,
						value: provider,
					})),
					onPick: async ([provider]) => {
						await chooseModel(
							env,
							request.chatJid,
							models.filter((model) => model.provider === provider),
							`Choose a ${provider} model`,
						);
						return undefined;
					},
				});
				return undefined;
			},
		},
		{
			name: "think",
			aliases: ["thinking", "reasoning"],
			usage: "/think [level]",
			summary: "reasoning level (off … max)",
			gated: true,
			run: async (args, request, env) => {
				const model = env.getCtx()?.model;
				const supported = (model ? getSupportedThinkingLevels(model) : [...ALL_LEVELS]) as Level[];
				const apply = (level: Level) => {
					env.pi.setThinkingLevel(level);
					const actual = env.pi.getThinkingLevel();
					notifyTerminal(env, `thinking → ${actual} (from WhatsApp)`);
					return actual === level ? `✅ Thinking → ${actual}` : `✅ Thinking → ${actual} (closest this model supports)`;
				};
				const wanted = args.toLowerCase() as Level;
				if (ALL_LEVELS.includes(wanted)) return apply(wanted);
				if (supported.length <= 1) return `${model?.id ?? "This model"} has no adjustable reasoning.`;
				const current = env.pi.getThinkingLevel();
				await env.menus.show(request.chatJid, {
					kind: "think",
					title: `Reasoning level (now ${current})`,
					gated: true,
					options: supported.map((level) => ({ label: `${level === current ? "✓ " : ""}${level}`, value: level })),
					onPick: async ([level]) => apply(level as Level),
				});
				return undefined;
			},
		},
	];
}
