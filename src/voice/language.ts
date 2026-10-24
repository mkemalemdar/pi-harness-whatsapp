// Which language a text is in, limited to the languages the user enabled.

import { franc } from "franc";
import { getLanguage } from "../core/languages.ts";
import { MIRROR } from "../core/settings.ts";

/** Detects the language of `text` among `enabled` codes; undefined when unsure. */
export function detectLanguage(text: string, enabled: readonly string[]): string | undefined {
	if (enabled.length === 0) return undefined;
	if (enabled.length === 1) return enabled[0];
	const byIso3 = new Map<string, string>();
	for (const code of enabled) {
		const info = getLanguage(code);
		if (info) byIso3.set(info.iso3, code);
	}
	const sample = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
	// Turkish letters are a strong, cheap signal for the common tr/en pair.
	if (byIso3.has("tur") && /[çğıöşüİ]/i.test(sample) && !byIso3.has("aze")) {
		const others = [...byIso3.keys()].filter((iso3) => iso3 !== "tur" && iso3 !== "eng");
		if (others.length === 0) return byIso3.get("tur");
	}
	const guess = franc(sample, { only: [...byIso3.keys()], minLength: 10 });
	return byIso3.get(guess);
}

/**
 * The language to speak a reply in: a fixed reply language wins; with
 * "mirror me" the reply text decides, then the user's own language, then
 * the default (first enabled) language.
 */
export function chooseSpeechLanguage(
	text: string,
	options: { enabled: readonly string[]; replyLanguage: string; incoming?: string },
): string {
	const { enabled, replyLanguage, incoming } = options;
	if (replyLanguage !== MIRROR && enabled.includes(replyLanguage)) return replyLanguage;
	const detected = detectLanguage(text, enabled);
	if (detected) return detected;
	if (incoming && enabled.includes(incoming)) return incoming;
	return enabled[0] ?? "en";
}
