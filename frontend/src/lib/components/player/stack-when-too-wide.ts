// The phone status bar's rows (PLAN.md § Desktop layout → the Segment row):
// each row's name, position and grades share a line when they fit; when they
// don't, each name takes a line of its own with the figures under it; and when
// even the figures are too wide side by side, each takes a line of its own. The
// choice is the rows' own width against the bar's, so six-digit counts stack
// instead of running off the screen while short ones keep the bar one line a row.
//
// The grid gets `data-stacked="name"`, then `"all"`, while it is wider than the
// bar; its classes say what that means (on a phone; nothing on desktop).
const STEPS = ['name', 'all'] as const;

export function stackWhenTooWide(grid: HTMLElement) {
	const bar = grid.parentElement;
	if (!bar) return;
	const check = () => {
		// Measured unstacked, then a step further each time it is too wide: the changes
		// and the measuring are one layout, so nothing is painted in between.
		delete grid.dataset.stacked;
		for (const step of STEPS) {
			if (grid.getBoundingClientRect().width <= bar.getBoundingClientRect().width + 0.5) break;
			grid.dataset.stacked = step;
		}
	};
	// The bar's width moves with the screen; the figures' with every card. Stacking
	// changes only the bar's height, after which the check comes out the same.
	const resize = new ResizeObserver(check);
	resize.observe(bar);
	const figures = new MutationObserver(check);
	figures.observe(grid, { subtree: true, childList: true, characterData: true });
	check();
	return () => {
		resize.disconnect();
		figures.disconnect();
	};
}
