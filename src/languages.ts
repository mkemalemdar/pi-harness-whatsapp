/**
 * Languages the extension can listen to and speak.
 *
 * One multilingual Whisper model understands every language, and one
 * Supertonic model speaks all of them, so a language needs no extra download.
 * Every language listed here is one Supertonic speaks.
 */

export interface VoiceOption {
	id: string;
	label: string;
}

export interface LanguageInfo {
	/** ISO 639-1 code, as reported by Whisper. */
	code: string;
	/** ISO 639-3 code, as used by franc. */
	iso3: string;
	/** Name in English. */
	name: string;
	/** Name in the language itself. */
	nativeName: string;
	/** The same 10 voices for every language; the first is the default. */
	voices: readonly VoiceOption[];
	/** Short line spoken by "Send me a sample". */
	sample: string;
}

/**
 * Supertonic's 10 voices. Each speaks every language, so every language offers
 * the same list and can still have its own voice.
 */
export const VOICES: readonly VoiceOption[] = [
	{ id: "F1", label: "F1 (female)" },
	{ id: "F2", label: "F2 (female)" },
	{ id: "F3", label: "F3 (female)" },
	{ id: "F4", label: "F4 (female)" },
	{ id: "F5", label: "F5 (female)" },
	{ id: "M1", label: "M1 (male)" },
	{ id: "M2", label: "M2 (male)" },
	{ id: "M3", label: "M3 (male)" },
	{ id: "M4", label: "M4 (male)" },
	{ id: "M5", label: "M5 (male)" },
];

export const LANGUAGES: readonly LanguageInfo[] = [
	{
		code: "en",
		iso3: "eng",
		name: "English",
		nativeName: "English",
		sample: "Hi, this is how I sound. Do you like this voice?",
		voices: VOICES,
	},
	{
		code: "tr",
		iso3: "tur",
		name: "Turkish",
		nativeName: "Türkçe",
		sample: "Merhaba, sesim böyle. Bu sesi beğendin mi?",
		voices: VOICES,
	},
	{
		code: "de",
		iso3: "deu",
		name: "German",
		nativeName: "Deutsch",
		sample: "Hallo, so klinge ich. Gefällt dir diese Stimme?",
		voices: VOICES,
	},
	{
		code: "fr",
		iso3: "fra",
		name: "French",
		nativeName: "Français",
		sample: "Salut, voici ma voix. Est-ce qu'elle te plaît ?",
		voices: VOICES,
	},
	{
		code: "es",
		iso3: "spa",
		name: "Spanish",
		nativeName: "Español",
		sample: "Hola, así sueno yo. ¿Te gusta esta voz?",
		voices: VOICES,
	},
	{
		code: "it",
		iso3: "ita",
		name: "Italian",
		nativeName: "Italiano",
		sample: "Ciao, questa è la mia voce. Ti piace?",
		voices: VOICES,
	},
	{
		code: "pt",
		iso3: "por",
		name: "Portuguese",
		nativeName: "Português",
		sample: "Oi, essa é a minha voz. Você gosta dela?",
		voices: VOICES,
	},
	{
		code: "nl",
		iso3: "nld",
		name: "Dutch",
		nativeName: "Nederlands",
		sample: "Hoi, zo klink ik. Vind je deze stem leuk?",
		voices: VOICES,
	},
	{
		code: "pl",
		iso3: "pol",
		name: "Polish",
		nativeName: "Polski",
		sample: "Cześć, tak brzmię. Podoba ci się ten głos?",
		voices: VOICES,
	},
	{
		code: "ru",
		iso3: "rus",
		name: "Russian",
		nativeName: "Русский",
		sample: "Привет, вот так я звучу. Тебе нравится этот голос?",
		voices: VOICES,
	},
	{
		code: "uk",
		iso3: "ukr",
		name: "Ukrainian",
		nativeName: "Українська",
		sample: "Привіт, ось так я звучу. Тобі подобається цей голос?",
		// "ukrainian_tts" is character-based and sherpa-onnx feeds it phonemes, so it stays almost silent.
		voices: VOICES,
	},
	{
		code: "ar",
		iso3: "arb",
		name: "Arabic",
		nativeName: "العربية",
		sample: "مرحبا، هكذا يبدو صوتي. هل يعجبك هذا الصوت؟",
		voices: VOICES,
	},
	{
		code: "hi",
		iso3: "hin",
		name: "Hindi",
		nativeName: "हिन्दी",
		sample: "नमस्ते, मेरी आवाज़ ऐसी है। क्या आपको यह आवाज़ पसंद है?",
		voices: VOICES,
	},
	{
		code: "sv",
		iso3: "swe",
		name: "Swedish",
		nativeName: "Svenska",
		sample: "Hej, så här låter jag. Gillar du den här rösten?",
		voices: VOICES,
	},
	{
		code: "fi",
		iso3: "fin",
		name: "Finnish",
		nativeName: "Suomi",
		sample: "Hei, tältä minä kuulostan. Pidätkö tästä äänestä?",
		voices: VOICES,
	},
];

export function getLanguage(code: string): LanguageInfo | undefined {
	return LANGUAGES.find((language) => language.code === code);
}

export function languageLabel(code: string): string {
	const language = getLanguage(code);
	if (!language) return code;
	return language.name === language.nativeName ? language.name : `${language.nativeName} (${language.name})`;
}

export function defaultVoiceFor(code: string): string | undefined {
	return getLanguage(code)?.voices[0]?.id;
}
