<script lang="ts">
	// A local stack's sign-in without a password, for ./scripts/dev.py
	// --login-as (PLAN.md § Development). The endpoint exists only with
	// DEV_LOGIN=true, which a TLS deployment refuses to start with, so on the
	// real site this page only says it is unavailable.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { adoptSession } from '$lib/auth/session.svelte';
	import { sameSitePath } from '$lib/auth/next';
	import type { Me } from '$lib/auth/types';
	import AuthCard from '$lib/components/auth/AuthCard.svelte';
	import FormError from '$lib/components/auth/FormError.svelte';
	import { syncNow } from '$lib/sync/runtime.svelte';

	let error = $state<string | null>(null);

	onMount(async () => {
		const username = page.url.searchParams.get('username') ?? '';
		const next = sameSitePath(page.url.searchParams.get('next'));
		try {
			const me = await api.post<Me>('/api/dev/login', { username }, { bindUser: false });
			await adoptSession(me);
			void syncNow().catch(() => undefined);
			await goto(next, { replaceState: true });
		} catch (err) {
			if (err instanceof ApiError && err.status === 404 && err.code === 'not_found' && username)
				error = `No such account, or this is not a local stack (DEV_LOGIN is off): ${username}.`;
			else if (err instanceof ApiError && err.status === 403) error = `${username} has not confirmed its email address.`;
			else error = 'Dev sign-in is only available on a local stack started by ./scripts/dev.py.';
		}
	});
</script>

<AuthCard title="Dev sign-in" description="Signing in on a local stack…">
	<FormError message={error} />
	{#if error}
		<a class="underline" href="/login">Log in with a password instead</a>
	{/if}
</AuthCard>
