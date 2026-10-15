/**
 * Markdown (what models write) → WhatsApp formatting, and splitting long
 * messages without breaking code blocks.
 *
 * WhatsApp supports *bold*, _italic_, ~strike~, `inline code` and ```blocks```.
 */

export const MAX_MESSAGE_LENGTH = 4000;

interface Segment {
	code: boolean;
	text: string;
}

/** Splits text into fenced code blocks and the prose between them. */
function splitFences(markdown: string): Segment[] {
	const segments: Segment[] = [];
	const fence = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
	let last = 0;
	for (let match = fence.exec(markdown); match; match = fence.exec(markdown)) {
		if (match.index > last) segments.push({ code: false, text: markdown.slice(last, match.index) });
		segments.push({ code: true, text: match[1]!.replace(/\n$/, "") });
		last = match.index + match[0].length;
	}
	if (last < markdown.length) segments.push({ code: false, text: markdown.slice(last) });
	return segments;
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function convertInline(line: string): string {
	// Keep `inline code` untouched while converting the rest.
	return line
		.split(/(`[^`\n]+`)/)
		.map((part, index) => (index % 2 === 1 ? part : convertEmphasis(part)))
		.join("");
}

function convertEmphasis(text: string): string {
	const BOLD = "\u0000B\u0000";
	return (
		text
			// links: [label](url) → label (url); bare autolinks stay as they are
			.replace(/!?\[([^\]]+)\]\((\S+?)\)/g, (_match, label: string, url: string) =>
				label === url ? url : `${label} (${url})`,
			)
			// bold first, through a placeholder so the italic rule doesn't eat it
			.replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
			.replace(/__(?=\S)([^_]+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`)
			// *italic* → _italic_ (single asterisks that are not list bullets)
			.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, "$1_$2_")
			.replace(/~~(?=\S)([^~]+?)(?<=\S)~~/g, "~$1~")
			.replaceAll(BOLD, "*")
	);
}

function convertProse(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		// Tables read badly in WhatsApp; show them as monospace blocks.
		if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
			const table: string[] = [line];
			index += 2;
			while (index < lines.length && isTableRow(lines[index]!)) table.push(lines[index++]!);
			index--;
			out.push(`\`\`\`\n${table.map((row) => row.trim()).join("\n")}\n\`\`\``);
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			out.push(`*${convertInline(heading[1]!).replace(/\*/g, "")}*`);
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push("──────────");
			continue;
		}
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			const task = /^\[( |x|X)\]\s+(.*)$/.exec(bullet[2]!);
			const body = task ? `${task[1] === " " ? "☐" : "☑"} ${task[2]}` : `• ${bullet[2]}`;
			out.push(`${bullet[1]}${convertInline(body)}`);
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			out.push(`> ${convertInline(quote[1]!)}`);
			continue;
		}
		out.push(convertInline(line));
	}
	return out.join("\n");
}

export function markdownToWhatsApp(markdown: string): string {
	return splitFences(markdown.replace(/\r\n/g, "\n"))
		.map((segment) => (segment.code ? `\`\`\`\n${segment.text}\n\`\`\`` : convertProse(segment.text)))
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Splits a (WhatsApp-formatted) message into chunks of at most `max`
 * characters, preferring paragraph, then line, then word boundaries. A code
 * block cut in two is closed and reopened so both halves stay monospace.
 */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
	if (text.length <= max) return text ? [text] : [];
	const chunks: string[] = [];
	let rest = text;
	let reopenFence = false;
	while (rest.length > 0) {
		const prefix: string = reopenFence ? "```\n" : "";
		const budget = max - prefix.length - 4; // room to close a fence
		if (prefix.length + rest.length <= max) {
			chunks.push(prefix + rest);
			break;
		}
		const window = rest.slice(0, budget);
		let cut = window.lastIndexOf("\n\n");
		if (cut < budget * 0.5) cut = window.lastIndexOf("\n");
		if (cut < budget * 0.5) cut = window.lastIndexOf(" ");
		if (cut <= 0) cut = budget;
		let chunk: string = prefix + rest.slice(0, cut).trimEnd();
		rest = rest.slice(cut).replace(/^\s+/, "");
		const fences: number = (chunk.match(/```/g) ?? []).length;
		reopenFence = fences % 2 === 1;
		if (reopenFence) chunk += "\n```";
		chunks.push(chunk);
	}
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** Prose suitable for text-to-speech: no code, no markup, links shortened. */
export function textForSpeech(markdown: string): string {
	return splitFences(markdown)
		.map((segment) => (segment.code ? " (code omitted) " : segment.text))
		.join("")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/^\s*#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*\|.*\|\s*$/gm, "")
		.replace(/[*_~]+/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/**
 * Splits text for speech into parts of at most `maxChars`, ending each part at a
 * sentence (or, failing that, a word) so no voice note stops mid-sentence.
 */
export function splitForSpeech(text: string, maxChars: number): string[] {
	const parts: string[] = [];
	let rest = text.trim();
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars + 1);
		let cut = Math.max(...[". ", "! ", "? ", "… ", "\n"].map((end) => window.lastIndexOf(end)));
		if (cut < maxChars * 0.5) cut = window.lastIndexOf(" ");
		if (cut <= 0) cut = maxChars;
		else cut += 1;
		parts.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) parts.push(rest);
	return parts;
}

/** True when a reply is mostly code, so a voice note alone would lose it. */
export function isCodeHeavy(markdown: string): boolean {
	const code = splitFences(markdown)
		.filter((segment) => segment.code)
		.reduce((total, segment) => total + segment.text.length, 0);
	return code > 200 && code > markdown.length * 0.3;
}
