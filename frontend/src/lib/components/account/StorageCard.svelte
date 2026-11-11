<script lang="ts">
	// Offline storage (PLAN.md § On the device → Downloads, the budget, the
	// quota path): the device's rows and keys against ROW_STORAGE_BUDGET, every
	// cascade this device still holds data for with its answer size and key
	// size, and every account with data here — its
	// figures from its `accounts` row, never from opening its database — each
	// with "Remove this account's data from this device".
	import { goto } from '$app/navigation';
	import { confirmAction } from '$lib/confirm.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { forgetSession, session } from '$lib/auth/session.svelte';
	import { removeAccountData, storageLine, type AccountRow } from '$lib/local/accounts';
	import type { UserDb } from '$lib/local/db';
	import { getMeta } from '$lib/local/meta';
	import { closeUserDb } from '$lib/local/open';
	import { ROW_STORAGE_BUDGET } from '$lib/sync/config';
	import { ROW_BYTES } from '$lib/sync/downloads';
	import { syncState } from '$lib/sync/runtime.svelte';

	let { db }: { db: UserDb } = $props();

	interface Held {
		id: string;
		name: string;
		answer: number;
		keys: number;
	}

	let accounts = $state<AccountRow[]>([]);
	let held = $state<Held[]>([]);
	let total = $state(0);

	// KB below a megabyte, so a small device's figures don't all read 0.0 MB.
	const mb = (b: number) => (b < 1_048_576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1_048_576).toFixed(1)} MB`);

	async function refresh() {
		accounts = await storageLine();
		const sizes = await getMeta(db, 'sizes');
		const out: Held[] = [];
		for (const c of await db.getAll('cascades')) {
			const id = c.id;
			// Only while the device actually holds data for it: one key probe, not a count.
			const rows = await db.getKeyFromIndex('quiz_questions', 'cascade_id', id);
			if (rows === undefined && !sizes[id]?.answer_bytes && !sizes[id]?.key_bytes) continue;
			out.push({ id, name: c.name, answer: sizes[id]?.answer_bytes ?? 0, keys: sizes[id]?.key_bytes ?? 0 });
		}
		held = out.sort((a, b) => a.name.localeCompare(b.name));
		total = (await db.count('quiz_questions')) * ROW_BYTES + Object.values(sizes).reduce((n, s) => n + s.key_bytes, 0);
	}

	$effect(() => {
		void syncState.progress;
		void refresh();
	});

	async function remove(a: AccountRow) {
		const self = a.user_id === session.userId;
		const ok = await confirmAction({
			title: `Remove ${self ? 'your' : `${a.username}’s`} data from this device?`,
			body: self
				? 'Changes not yet synced are lost, and you are logged out. Everything synced stays on the server and downloads again when you log in.'
				: 'Changes that account has not yet synced are lost. Everything synced stays on the server.',
			action: 'Remove data',
			destructive: true
		});
		if (!ok) return;
		if (self) {
			// The signed-in account: clears the pointer and returns to the login page.
			closeUserDb();
			await removeAccountData(a.user_id);
			forgetSession();
			await goto('/login', { replaceState: true });
			return;
		}
		await removeAccountData(a.user_id);
		await refresh();
	}
</script>

<Card.Root>
	<Card.Header><Card.Title>Offline storage</Card.Title></Card.Header>
	<Card.Content class="grid gap-3 text-sm">
		<p>Rows and question keys: {mb(total)} of {mb(ROW_STORAGE_BUDGET)}.</p>
		{#if syncState.status === 'no_room'}<p class="text-destructive">Not enough room on this device.</p>{/if}
		{#if held.length}
			<h3 class="pt-2 font-medium">Cascades on this device</h3>
			<table class="w-full">
				<thead><tr class="text-left text-muted-foreground"><th>Cascade</th><th>Answers</th><th>Keys</th></tr></thead>
				<tbody>
					{#each held as h (h.id)}
						<tr>
							<td>{h.name}</td>
							<td>{mb(h.answer)}</td>
							<td>{mb(h.keys)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		<h3 class="pt-2 font-medium">Accounts with data on this device</h3>
		<ul class="grid gap-2">
			{#each accounts as a (a.user_id)}
				<li class="flex flex-wrap items-center justify-between gap-2">
					<span>{a.username}: rows and keys {mb(a.rows + a.keys)}, answers {mb(a.answer_bytes)}</span>
					<Button size="sm" variant="outline" onclick={() => remove(a)}>Remove this account's data from this device</Button>
				</li>
			{/each}
		</ul>
		<p class="text-muted-foreground">Some browsers, notably Safari, can clear site data after a period of not being used.</p>
	</Card.Content>
</Card.Root>
