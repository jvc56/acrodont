<script lang="ts">
	import { INFO } from '$lib/settings-info';
	import { confirmAction } from '$lib/confirm.svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import Field from '$lib/components/auth/Field.svelte';
	import FormError from '$lib/components/auth/FormError.svelte';
	import { ApiError, type FieldError } from '$lib/api';
	import { authApi } from '$lib/auth/client';
	import { describe } from '$lib/auth/errors';
	import { forgetSession, logout, session } from '$lib/auth/session.svelte';
	import { removeAccountData } from '$lib/local/accounts';
	import { closeUserDb, countUnsent } from '$lib/local/open';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import { syncNow, syncState } from '$lib/sync/runtime.svelte';

	// A signed-in change of password (PLAN.md § Accounts): the current one, then the new.
	let currentPw = $state('');
	let newPw = $state('');
	let changeErrors = $state<FieldError[]>([]);
	let changeMessage = $state<string | null>(null);

	let everywherePw = $state('');
	let everywhereErrors = $state<FieldError[]>([]);
	let everywhereMessage = $state<string | null>(null);

	let deletePw = $state('');
	let deleteErrors = $state<FieldError[]>([]);
	let deleteError = $state<string | null>(null);

	let removeData = $state(false);

	function fieldErrorsOr(e: unknown, set: (f: FieldError[]) => void): string | null {
		if (e instanceof ApiError && e.fieldErrors.length) {
			set(e.fieldErrors);
			return null;
		}
		return describe(e);
	}

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		changeErrors = [];
		changeMessage = null;
		try {
			await authApi.changePassword(currentPw, newPw);
			currentPw = '';
			newPw = '';
			changeMessage = 'Your password is changed. Every other session has been signed out; this one keeps working.';
		} catch (err) {
			changeMessage = fieldErrorsOr(err, (f) => (changeErrors = f));
		}
	}

	async function signOutEverywhere(e: SubmitEvent) {
		e.preventDefault();
		everywhereErrors = [];
		everywhereMessage = null;
		try {
			await authApi.signOutEverywhere(everywherePw);
			everywherePw = '';
			everywhereMessage = 'Every other session has been signed out. This one keeps working.';
		} catch (err) {
			everywhereMessage = fieldErrorsOr(err, (f) => (everywhereErrors = f));
		}
	}

	async function deleteAccount(e: SubmitEvent) {
		e.preventDefault();
		deleteErrors = [];
		deleteError = null;
		const ok = await confirmAction({
			title: 'Delete your account?',
			body: 'Your account, every cascade, your saved searches and your settings are deleted for good, on every device. This cannot be undone.',
			action: 'Delete account',
			destructive: true
		});
		if (!ok) return;
		const id = session.userId;
		try {
			await authApi.deleteAccount(deletePw);
		} catch (err) {
			deleteError = fieldErrorsOr(err, (f) => (deleteErrors = f));
			return;
		}
		// The session is already void: remove this device's copy, with no queued logout.
		closeUserDb();
		if (id) await removeAccountData(id);
		// To the landing page; the signed-out guard would otherwise send this page to /login.
		session.toLanding = true;
		forgetSession();
		await goto('/login', { replaceState: true });
	}

	async function doLogout() {
		// The app tries to sync first, then always completes locally.
		if (navigator.onLine) await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]).catch(() => undefined);
		const id = session.userId;
		if (removeData && id) {
			// Whatever that sync did not send is about to be deleted with the rest:
			// a long outbox still draining, a server asking the device to wait, a
			// sync led by another tab, a tab that has stopped syncing. Counted now
			// from the account's own database, and asked about, whatever the status
			// line above was showing; a count that cannot be made is asked about too.
			const left = await countUnsent(id);
			if (left !== 0) {
				const ok = await confirmAction({
					title: 'Discard changes that haven’t synced?',
					body:
						left === null
							? 'This device’s copy could not be checked for changes that haven’t synced. Removing this account’s data from this device discards any there are for good. Log out without removing the data and they will sync the next time you log in here.'
							: `${left === 1 ? '1 change hasn’t' : `${left} changes haven’t`} synced yet. Removing this account’s data from this device discards ${left === 1 ? 'it' : 'them'} for good. Log out without removing the data and ${left === 1 ? 'it' : 'they'} will sync the next time you log in here.`,
					action: 'Remove and log out',
					destructive: true
				});
				if (!ok) return;
			}
		}
		// The removal is part of the logout, ahead of its request: it needs no connection.
		await logout({ removeData });
		await goto('/login', { replaceState: true });
	}

	// Map the account endpoints' field names onto the inputs here.
	const rename = (errs: FieldError[], from: string, to: string) =>
		errs.map((e) => (e.field === from ? { ...e, field: to } : e));
</script>

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<h1 class="text-2xl font-semibold">Account</h1>

	<Card.Root>
		<Card.Header><Card.Title>Signed in as {session.username}</Card.Title></Card.Header>
		<Card.Content class="grid gap-3">
			<SettingRow label="Remove this account's data from this device" info={INFO.remove_data} for="remove-data">
				<Checkbox id="remove-data" bind:checked={removeData} />
			</SettingRow>
			<!-- Only changes that cannot sync now matter at logout. Online, a change
			     syncs within a second, and the header's sync status shows that: a
			     line here would come and go with every setting changed. -->
			{#if (syncState.pending ?? 0) > 0 && (syncState.status === 'offline' || syncState.status === 'needs_login' || session.needsLogin)}
				<p class="text-sm" role="status">
					{syncState.pending === 1 ? '1 change hasn’t' : `${syncState.pending} changes haven’t`} synced yet. {syncState.pending === 1 ? 'It' : 'They'}
					will sync the next time you log in on this device.
				</p>
				{#if removeData}
					<p class="text-sm text-destructive">
						Removing this account’s data discards {syncState.pending === 1 ? 'that change' : `those ${syncState.pending} changes`}.
					</p>
				{/if}
			{/if}
			<Button variant="outline" onclick={doLogout}>Log out</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Change password</Card.Title>
			<Card.Description>Signs out every other session. This device stays signed in.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form class="grid gap-4" onsubmit={changePassword}>
				{#if changeMessage}<p class="text-sm" role="status">{changeMessage}</p>{/if}
				<Field id="current_password" label="Current password" type="password" bind:value={currentPw} errors={changeErrors} autocomplete="current-password" />
				<Field id="new_password" label="New password" type="password" bind:value={newPw} errors={changeErrors} autocomplete="new-password" />
				<Button type="submit" variant="outline">Change password</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Sign out everywhere</Card.Title>
			<Card.Description>Signs out every other session. This device stays signed in.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form class="grid gap-4" onsubmit={signOutEverywhere}>
				{#if everywhereMessage}<p class="text-sm">{everywhereMessage}</p>{/if}
				<Field id="everywhere_password" label="Password" type="password" bind:value={everywherePw} errors={rename(everywhereErrors, 'password', 'everywhere_password')} autocomplete="current-password" />
				<Button type="submit" variant="outline">Sign out everywhere</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Delete account</Card.Title>
			<Card.Description>Deletes your account and everything in it, for good.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form class="grid gap-4" onsubmit={deleteAccount}>
				<FormError message={deleteError} />
				<Field id="delete_password" label="Password" type="password" bind:value={deletePw} errors={rename(deleteErrors, 'password', 'delete_password')} autocomplete="current-password" />
				<Button type="submit" variant="destructive">Delete account</Button>
			</form>
		</Card.Content>
	</Card.Root>
</main>
