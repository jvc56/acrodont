// The tab's title (the root layout's <title>, its only one). A page shows its
// own name there by setting `pageTitle.name` while it is mounted and clearing it
// when it goes; the layout adds " · Acrodont", and shows "Search · Acrodont"
// whenever the Search page is showing, on its own or over a quiz.
//
// One title, worked out in one place: Svelte's <title> only assigns
// document.title, and a page's <title> taken away (Search closed over the quiz,
// or left for another page) never puts back the one before it.

export const pageTitle = $state<{ name: string | null }>({ name: null });

/** The tab's title: "Search · Acrodont" on Search, a page's name, or "Acrodont". */
export function documentTitle(search: boolean, name: string | null): string {
	if (search) return 'Search · Acrodont';
	return name ? `${name} · Acrodont` : 'Acrodont';
}
