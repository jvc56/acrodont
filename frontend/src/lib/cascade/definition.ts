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
