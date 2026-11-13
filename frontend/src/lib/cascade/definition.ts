// A definition as the answer shows it: one line for each part of speech.
// A lexicon's definition gives each part's meaning and then its part of
// speech and inflections in brackets, the parts separated by " / ":
// "a way out [n -S] / to go out [v -ED, -ING, -S]".

/** The definition's parts of speech, one each, in order; a definition with one part is one line. */
export function definitionLines(text: string): string[] {
	return text
		.replace(/\]\s*\/\s+/g, ']\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

/** A part of speech's brackets longer than this wrap like any other text. */
const TAG_MAX = 16;

/**
 * A line as its meaning and its closing part of speech, "a harbour " and
 * "[n -S]", so a short part of speech is kept whole when the line wraps. A
 * long one (a verb's inflections spelt out), or a line without one, is all
 * meaning.
 */
export function splitTag(line: string): [string, string] {
	const at = line.lastIndexOf('[');
	if (at <= 0 || !line.endsWith(']') || line.length - at > TAG_MAX) return [line, ''];
	return [line.slice(0, at), line.slice(at)];
}

/**
 * Text for display with each inflection kept whole: a word joiner (U+2060,
 * no width) after the hyphen of "-S" or "-ING", where a line would otherwise
 * break and leave the hyphen behind. A hyphen inside a meaning ("gun-like")
 * still breaks.
 */
export function unbroken(text: string): string {
	return text.replace(/-(?=[A-Z])/g, '-\u2060');
}
