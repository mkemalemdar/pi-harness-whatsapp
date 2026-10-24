// /voice, /lang, /speed, /replies — the same settings as the terminal panel.

import { languageLabel } from "../core/languages.ts";
import { formatSpeed, REPLY_TOGGLES, replyLanguageLabel, VOICE_MODE_LABELS } from "../core/panel-model.ts";
import { clampSpeed, MAX_SPEED, MIN_SPEED, MIRROR, replyMode, SPEED_PRESETS, type VoiceMode } from "../core/settings.ts";
import { notifyTerminal, type Command, type CommandEnv } from "./types.ts";

const VOICE_ALIASES: Record<string, VoiceMode> = {
	off: "off",
	text: "off",
	voice: "voice",
	on: "voice",
	both: "voice+text",
	"voice+text": "voice+text",
	mirror: "mirror",
};

/** Voice can only be switched on in the terminal: it downloads (and deletes) speech files. */
export const VOICE_REPLIES_OFF = "Voice replies are off. Turn them on in the terminal: /whatsapp → Voice notes → Reply with voice notes.";

function repliesState(env: CommandEnv): string {
	const replies = env.settings.get().replies;
	return [
		"Final answer: always ✓",
		...REPLY_TOGGLES.map((toggle) => `${toggle.label}: ${replies[toggle.key] ? "on ✓" : "off"}`),
	].join("\n");
}

export function settingsCommands(): Command[] {
	return [
		{
			name: "voice",
			usage: "/voice [text|voice|both|mirror]",
			summary: "reply type (text, voice, both, mirror me)",
			gated: true,
			run: async (args, request, env) => {
				const apply = (mode: VoiceMode) => {
					env.settings.update((draft) => {
						draft.voiceMode = mode;
					});
					notifyTerminal(env, `reply type → ${VOICE_MODE_LABELS[mode]}`);
					return `✅ Reply type → ${VOICE_MODE_LABELS[mode]}`;
				};
				const settings = env.settings.get();
				if (!settings.voice.reply) return VOICE_REPLIES_OFF;
				const direct = VOICE_ALIASES[args.toLowerCase()];
				if (direct) return apply(direct);
				const current = replyMode(settings);
				await env.menus.show(request.chatJid, {
					kind: "voice",
					title: `Reply type (now ${VOICE_MODE_LABELS[current]})`,
					gated: true,
					options: (["mirror", "off", "voice", "voice+text"] as const).map((mode) => ({
						label: `${mode === current ? "✓ " : ""}${VOICE_MODE_LABELS[mode]}`,
						value: mode,
					})),
					onPick: async ([mode]) => apply(mode as VoiceMode),
				});
				return undefined;
			},
		},
		{
			name: "lang",
			aliases: ["language"],
			usage: "/lang",
			summary: "reply language",
			gated: true,
			run: async (_args, request, env) => {
				const settings = env.settings.get();
				const choices = [MIRROR, ...settings.languages];
				await env.menus.show(request.chatJid, {
					kind: "lang",
					title: `Reply language (now ${replyLanguageLabel(settings.replyLanguage)})`,
					gated: true,
					options: choices.map((code) => ({
						label: `${code === settings.replyLanguage ? "✓ " : ""}${replyLanguageLabel(code)}`,
						value: code,
					})),
					onPick: async ([code]) => {
						env.settings.update((draft) => {
							draft.replyLanguage = code ?? MIRROR;
						});
						const label = replyLanguageLabel(env.settings.get().replyLanguage);
						notifyTerminal(env, `reply language → ${label}`);
						return `✅ Reply language → ${label}${code === MIRROR ? "" : ". Add more languages in the terminal: /whatsapp → My languages."}`;
					},
				});
				return undefined;
			},
		},
		{
			name: "speed",
			usage: "/speed [0.5–2.0]",
			summary: "voice reply speed",
			gated: true,
			run: async (args, request, env) => {
				const apply = (value: number) => {
					const saved = env.settings.update((draft) => {
						draft.voiceSpeed = clampSpeed(value);
					});
					notifyTerminal(env, `voice speed → ${formatSpeed(saved.voiceSpeed)}`);
					return `✅ Voice reply speed → ${formatSpeed(saved.voiceSpeed)}`;
				};
				if (!env.settings.get().voice.reply) return VOICE_REPLIES_OFF;
				if (args) {
					const value = Number.parseFloat(args.replace(",", "."));
					if (!Number.isFinite(value)) return `Send a number from ${MIN_SPEED} to ${MAX_SPEED}, e.g. /speed 1.15`;
					return apply(value);
				}
				const current = env.settings.get().voiceSpeed;
				await env.menus.show(request.chatJid, {
					kind: "speed",
					title: `Voice reply speed (now ${formatSpeed(current)}; or send /speed 1.15)`,
					gated: true,
					options: SPEED_PRESETS.map((speed) => ({
						label: `${speed === current ? "✓ " : ""}${speed < 1 ? "Slower" : speed > 1 ? "Faster" : "Normal"} ${formatSpeed(speed)}`,
						value: String(speed),
					})),
					onPick: async ([value]) => apply(Number(value)),
				});
				return undefined;
			},
		},
		{
			name: "replies",
			usage: "/replies",
			summary: "what Pi sends besides the final answer",
			gated: true,
			run: async (_args, request, env) => {
				await env.queue.sendText(request.chatJid, `*Replies now*\n${repliesState(env)}`);
				await env.menus.show(request.chatJid, {
					kind: "replies",
					title: "Switch replies on/off",
					multi: true,
					gated: true,
					options: REPLY_TOGGLES.map((toggle) => ({ label: toggle.label, value: toggle.key })),
					onPick: async (_values, { added, removed }) => {
						// Each tick or untick flips that setting.
						const flipped = [...added, ...removed];
						env.settings.update((draft) => {
							for (const key of flipped) {
								const toggle = key as keyof typeof draft.replies;
								if (toggle in draft.replies) draft.replies[toggle] = !draft.replies[toggle];
							}
						});
						notifyTerminal(env, "reply settings changed");
						return `✅ Updated\n${repliesState(env)}`;
					},
				});
				return undefined;
			},
		},
		{
			name: "languages",
			usage: "/languages",
			summary: "which languages Pi listens to and speaks",
			gated: false,
			run: async (_args, _request, env) => {
				const settings = env.settings.get();
				return `Languages: ${settings.languages.map(languageLabel).join(", ")} (default ${languageLabel(settings.languages[0]!)}).\nAdd or remove them in the terminal: /whatsapp → My languages.`;
			},
		},
	];
}
