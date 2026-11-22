// The phone status bar's figures (PLAN.md § Desktop layout → the Segment row):
// the card's position and the grades share a line when they fit beside each
// other, and the grades go under the position when they don't. The choice is
// the figures' own width against the bar's, so six-digit counts stack instead
// of running off the screen while short ones keep the bar as short as it was.
//
// The grid gets `data-stacked` while its two columns are wider than the bar;
// its classes say what that means (one column on a phone, nothing on desktop).
export function stackWhenTooWide(grid: HTMLElement) {
	const bar = grid.parentElement;
	if (!bar) return;
	const check = () => {
		// Measured unstacked, then stacked again at once if too wide: the change
		// and the measuring are one layout, so nothing is painted in between.
		delete grid.dataset.stacked;
		if (grid.getBoundingClientRect().width > bar.getBoundingClientRect().width + 0.5) grid.dataset.stacked = '';
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
