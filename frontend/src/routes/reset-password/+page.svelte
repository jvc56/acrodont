<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import AuthCard from '$lib/components/auth/AuthCard.svelte';
	import Field from '$lib/components/auth/Field.svelte';
	import FormError from '$lib/components/auth/FormError.svelte';
	import { authApi } from '$lib/auth/client';
	import { describe } from '$lib/auth/errors';

	let email = $state('');
	let sent = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		try {
			await authApi.requestReset(email);
			sent = true;
		} catch (err) {
			error = describe(err);
		}
	}
</script>

<AuthCard title="Reset your password">
	{#if sent}
		<p class="text-sm">
			If that address has a confirmed account, a reset link is on its way, with the account's
			username. The link expires in 30 minutes.
		</p>
	{:else}
		<form class="grid gap-4" onsubmit={submit}>
			<FormError message={error} />
			<Field id="email" label="Email" type="email" bind:value={email} autocomplete="email" />
			<Button type="submit">Send reset link</Button>
		</form>
	{/if}
	{#snippet footer()}<a class="underline" href="/login">Back to log in</a>{/snippet}
</AuthCard>
