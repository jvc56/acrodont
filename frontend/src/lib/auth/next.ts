/**
 * A `next=` destination, if it is a path on this site: it starts with one `/`,
 * never `//` or `/\` (which browsers read as another host), and holds only
 * visible ASCII, so a tab or newline cannot smuggle a host in (birdtest's dev
 * login let `/<tab>/host` through). Anything else becomes `fallback`.
 */
export function sameSitePath(next: string | null | undefined, fallback = '/cascades'): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
	for (let i = 0; i < next.length; i++) {
		const c = next.charCodeAt(i);
		if (c < 0x21 || c > 0x7e) return fallback;
	}
	return next;
}
