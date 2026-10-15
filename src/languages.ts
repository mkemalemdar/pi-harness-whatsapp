/**
 * Languages the extension can listen to and speak.
 *
 * Speech recognition uses one multilingual Whisper model for every language,
 * so only text-to-speech needs a per-language download (one Piper voice).
 * Voice ids are the sherpa-onnx release names without the `vits-piper-` prefix,
 * e.g. `tr_TR-dfki-medium` → vits-piper-tr_TR-dfki-medium.tar.bz2.
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
	/** First voice is the default. */
	voices: VoiceOption[];
	/** Short line spoken by "Send me a sample". */
	sample: string;
}

export const LANGUAGES: readonly LanguageInfo[] = [
	{
		code: "en",
		iso3: "eng",
		name: "English",
		nativeName: "English",
		sample: "Hi, this is how I sound. Do you like this voice?",
		voices: [
			{ id: "en_US-amy-medium", label: "Amy (US, female)" },
			{ id: "en_US-ryan-medium", label: "Ryan (US, male)" },
			{ id: "en_US-lessac-medium", label: "Lessac (US, female)" },
			{ id: "en_GB-alan-medium", label: "Alan (UK, male)" },
			{ id: "en_GB-cori-medium", label: "Cori (UK, female)" },
		],
	},
	{
		code: "tr",
		iso3: "tur",
		name: "Turkish",
		nativeName: "Türkçe",
		sample: "Merhaba, sesim böyle. Bu sesi beğendin mi?",
		voices: [
			{ id: "tr_TR-dfki-medium", label: "DFKI (male)" },
			{ id: "tr_TR-fahrettin-medium", label: "Fahrettin (male)" },
			{ id: "tr_TR-fettah-medium", label: "Fettah (male)" },
		],
	},
	{
		code: "de",
		iso3: "deu",
		name: "German",
		nativeName: "Deutsch",
		sample: "Hallo, so klinge ich. Gefällt dir diese Stimme?",
		voices: [
			{ id: "de_DE-thorsten-medium", label: "Thorsten (male)" },
			{ id: "de_DE-kerstin-low", label: "Kerstin (female)" },
		],
	},
	{
		code: "fr",
		iso3: "fra",
		name: "French",
		nativeName: "Français",
		sample: "Salut, voici ma voix. Est-ce qu'elle te plaît ?",
		voices: [
			{ id: "fr_FR-siwis-medium", label: "Siwis (female)" },
			{ id: "fr_FR-tom-medium", label: "Tom (male)" },
		],
	},
	{
		code: "es",
		iso3: "spa",
		name: "Spanish",
		nativeName: "Español",
		sample: "Hola, así sueno yo. ¿Te gusta esta voz?",
		voices: [
			{ id: "es_ES-davefx-medium", label: "Davefx (Spain, male)" },
			{ id: "es_MX-ald-medium", label: "Ald (Mexico, male)" },
		],
	},
	{
		code: "it",
		iso3: "ita",
		name: "Italian",
		nativeName: "Italiano",
		sample: "Ciao, questa è la mia voce. Ti piace?",
		voices: [
			{ id: "it_IT-paola-medium", label: "Paola (female)" },
			{ id: "it_IT-riccardo-x_low", label: "Riccardo (male)" },
		],
	},
	{
		code: "pt",
		iso3: "por",
		name: "Portuguese",
		nativeName: "Português",
		sample: "Oi, essa é a minha voz. Você gosta dela?",
		voices: [
			{ id: "pt_BR-faber-medium", label: "Faber (Brazil, male)" },
			{ id: "pt_PT-tugao-medium", label: "Tugão (Portugal, male)" },
		],
	},
	{
		code: "nl",
		iso3: "nld",
		name: "Dutch",
		nativeName: "Nederlands",
		sample: "Hoi, zo klink ik. Vind je deze stem leuk?",
		voices: [{ id: "nl_NL-pim-medium", label: "Pim (male)" }],
	},
	{
		code: "pl",
		iso3: "pol",
		name: "Polish",
		nativeName: "Polski",
		sample: "Cześć, tak brzmię. Podoba ci się ten głos?",
		voices: [
			{ id: "pl_PL-gosia-medium", label: "Gosia (female)" },
			{ id: "pl_PL-darkman-medium", label: "Darkman (male)" },
		],
	},
	{
		code: "ru",
		iso3: "rus",
		name: "Russian",
		nativeName: "Русский",
		sample: "Привет, вот так я звучу. Тебе нравится этот голос?",
		voices: [
			{ id: "ru_RU-irina-medium", label: "Irina (female)" },
			{ id: "ru_RU-dmitri-medium", label: "Dmitri (male)" },
		],
	},
	{
		code: "uk",
		iso3: "ukr",
		name: "Ukrainian",
		nativeName: "Українська",
		sample: "Привіт, ось так я звучу. Тобі подобається цей голос?",
		// "ukrainian_tts" is character-based and sherpa-onnx feeds it phonemes, so it stays almost silent.
		voices: [{ id: "uk_UA-lada-x_low", label: "Lada (female)" }],
	},
	{
		code: "ar",
		iso3: "arb",
		name: "Arabic",
		nativeName: "العربية",
		sample: "مرحبا، هكذا يبدو صوتي. هل يعجبك هذا الصوت؟",
		voices: [{ id: "ar_JO-kareem-medium", label: "Kareem (male)" }],
	},
	{
		code: "fa",
		iso3: "pes",
		name: "Persian",
		nativeName: "فارسی",
		sample: "سلام، صدای من این‌طوری است. این صدا را دوست داری؟",
		voices: [{ id: "fa_IR-amir-medium", label: "Amir (male)" }],
	},
	{
		code: "hi",
		iso3: "hin",
		name: "Hindi",
		nativeName: "हिन्दी",
		sample: "नमस्ते, मेरी आवाज़ ऐसी है। क्या आपको यह आवाज़ पसंद है?",
		voices: [{ id: "hi_IN-pratham-medium", label: "Pratham (male)" }],
	},
	{
		code: "sv",
		iso3: "swe",
		name: "Swedish",
		nativeName: "Svenska",
		sample: "Hej, så här låter jag. Gillar du den här rösten?",
		voices: [{ id: "sv_SE-nst-medium", label: "NST" }],
	},
	{
		code: "fi",
		iso3: "fin",
		name: "Finnish",
		nativeName: "Suomi",
		sample: "Hei, tältä minä kuulostan. Pidätkö tästä äänestä?",
		voices: [{ id: "fi_FI-harri-medium", label: "Harri (male)" }],
	},
	{
		code: "zh",
		iso3: "cmn",
		name: "Chinese",
		nativeName: "中文",
		sample: "你好，这是我的声音。你喜欢这个声音吗？",
		voices: [{ id: "zh_CN-huayan-medium", label: "Huayan (female)" }],
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
