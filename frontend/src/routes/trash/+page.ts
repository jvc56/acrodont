// The Trash is on the Cascades page, under the cascades (PLAN.md § Trash);
// an old link to /trash goes there.
import { redirect } from '@sveltejs/kit';

export function load() {
	redirect(307, '/cascades#trash');
}
