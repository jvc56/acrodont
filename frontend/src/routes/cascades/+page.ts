// The Cascades page is the site's root, /: an old link to /cascades goes there.
import { redirect } from '@sveltejs/kit';

export function load() {
	redirect(307, '/');
}
