<script lang="ts">
	// There is no separate home or landing page: the Cascades page is where a
	// signed-in user starts, and the log-in page (with its link to create an
	// account) is where everyone else does.
	import { goto } from '$app/navigation';
	import { session } from '$lib/auth/session.svelte';

	$effect(() => {
		if (!session.ready) return;
		if (session.toLanding) session.toLanding = false;
		void goto(session.userId ? '/cascades' : '/login', { replaceState: true });
	});
</script>
