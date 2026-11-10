// One confirmation at a time (PLAN.md § Frontend → ConfirmDialog): an action
// that loses something or is hard to undo — moving a cascade to the Trash,
// deleting forever, starting over, removing data — asks first. The dialog
// itself is mounted once, in the root layout.

export interface ConfirmRequest {
	title: string;
	/** What happens, and whether it can be undone. */
	body?: string;
	/** The confirming button's label: the action's own name, never "OK". */
	action: string;
	/** Drawn in the destructive colour: data goes for good. */
	destructive?: boolean;
}

class ConfirmState {
	current = $state<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null);

	answer(ok: boolean) {
		const c = this.current;
		this.current = null;
		c?.resolve(ok);
	}
}

export const confirmState = new ConfirmState();

/** Asks; resolves true only if the user confirms. A newer request cancels an older one. */
export function confirmAction(r: ConfirmRequest): Promise<boolean> {
	confirmState.answer(false);
	return new Promise((resolve) => (confirmState.current = { ...r, resolve }));
}
