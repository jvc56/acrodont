<script lang="ts">
	// Setting a new password from a reset link (PLAN.md § Authentication →
	// Password reset), as birdtest does: the link is checked first, then the
	// password, by registration's rule. A link buys five tries an hour, weak
	// passwords included. Success signs out every session, this browser's
	// too, and goes to the log-in page with no message: signing in with the
	// new password is the confirmation.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import AuthCard from '$lib/components/auth/AuthCard.svelte';
	import Field from '$lib/components/auth/Field.svelte';
	import FormError from '$lib/components/auth/FormError.svelte';
	import { ApiError, type FieldError } from '$lib/api';
	import { authApi } from '$lib/auth/client';
	import { describe } from '$lib/auth/errors';
	import { forgetSession, session } from '$lib/auth/session.svelte';

	const token = $derived(page.url.searchParams.get('token') ?? '');
	let password = $state('');
	let errors = $state<FieldError[]>([]);
	let error = $state<string | null>(null);
	/** Past the link's tries: when to come back, in minutes, if the server said. */
	let outOfTries = $state<{ minutes: number | null } | null>(null);
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		errors = [];
		outOfTries = null;
		busy = true;
		try {
			await authApi.confirmReset(token, password);
			// A reset signs out every session, this tab's included.
			if (session.userId) forgetSession();
			await goto('/login');
		} catch (err) {
			if (err instanceof ApiError && err.fieldErrors.length) errors = err.fieldErrors;
			else if (err instanceof ApiError && err.status === 429)
				outOfTries = { minutes: err.retryAfterSeconds ? Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) : null };
			else if (err instanceof ApiError && err.status === 503)
				error = 'The server is busy checking passwords. Try again in a few seconds.';
			else if (err instanceof ApiError && err.status === 400)
				error = 'This reset link has expired or was already used. Ask for a new one.';
			else error = describe(err);
		} finally {
			busy = false;
		}
	}
</script>

<AuthCard title="Choose a new password" description="Every device will be signed out.">
	{#if !token}
		<p class="text-sm text-destructive">That link is missing its reset token. <a class="underline" href="/reset-password">Ask for a new one.</a></p>
	{:else}
		<form class="grid gap-4" onsubmit={submit}>
			{#if outOfTries}
				<p class="text-sm text-destructive" role="alert">
					Too many tries, with this link or from this address. Try again in
					{outOfTries.minutes === null ? 'a few minutes' : `${outOfTries.minutes} minute${outOfTries.minutes === 1 ? '' : 's'}`}, or
					<a class="underline" href="/reset-password">ask for a new link</a>.
				</p>
			{:else}
				<FormError message={error} />
			{/if}
			<Field id="password" label="New password" type="password" bind:value={password} {errors} autocomplete="new-password" />
			<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set new password'}</Button>
		</form>
	{/if}
</AuthCard>
