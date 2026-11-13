<script lang="ts">
	// The player for the cascade's deepest level (PLAN.md § Taking a quiz):
	// for a fine pointer at least 900 px wide, a hideable menu on the left, the
	// quiz area with the question at the top, and a status bar along the bottom;
	// tap zones otherwise. The three actions from mouse, wheel, keys and taps;
	// typed mode; the Settings dialog, which holds every setting there is, in
	// two groups: this cascade's (synced; a change offers to be used for every
	// cascade too, and another cascade's can be copied) and this device's
	// (its display and controls, never synced); banners, the completion
	// screen, and a trashed cascade's Restore.
	import { INFO, SCOPE, SECTION } from '$lib/settings-info';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { isRetriable, sendWithRetry } from '$lib/builder/create';
	import { session } from '$lib/auth/session.svelte';
	import CascadeLadder from '$lib/components/CascadeLadder.svelte';
	import QuizOptionsForm from '$lib/components/QuizOptionsForm.svelte';
	import SyncStatus from '$lib/components/SyncStatus.svelte';
	import TileText from '$lib/components/TileText.svelte';
	import AnswerView from '$lib/components/player/AnswerView.svelte';
	import DisplaySettings from '$lib/components/player/DisplaySettings.svelte';
	import ApplyWider from '$lib/components/settings/ApplyWider.svelte';
	import ControlsEditor from '$lib/components/settings/ControlsEditor.svelte';
	import CreatingCascade from '$lib/components/CreatingCascade.svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import { Button } from '$lib/components/ui/button';
	import { display, textStyle } from '$lib/player/display.svelte';
	import { controls } from '$lib/player/controls.svelte';
	import { applyLocally, type NewOp } from '$lib/local/apply';
	import { storeCreated, type Created } from '$lib/local/created';
	import type { UserDb } from '$lib/local/db';
	import { getMeta, recordOpen } from '$lib/local/meta';
	import { DEFAULT_STORAGE_LIMIT, formatBytes } from '$lib/cascades/storage';
	import {
		applyToAll,
		copySettings,
		copySources,
		kindOf,
		reachable,
		type CascadeSettings,
		type Widening
	} from '$lib/settings/cascade';
	import { userDb } from '$lib/local/open';
	import type { AnswerMode, AttemptRow, CascadeRow } from '$lib/local/rows';
	import type { RwTx } from '$lib/local/view';
	import { PLAYER_LOCK } from '$lib/sync/downloads';
	import { afterLocalWrite, ensureCascade, fetchAhead, fetchCard, fetchDistribution, playerActs, syncState } from '$lib/sync/runtime.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PanelBottomCloseIcon from '@lucide/svelte/icons/panel-bottom-close';
	import PanelBottomOpenIcon from '@lucide/svelte/icons/panel-bottom-open';
	import { actionFor, Debounce, inputOwns, keyStroke, mouseStroke, wheelStroke, type Action } from '$lib/player/bindings';
	import { Player, type PlayerView } from '$lib/player/controller';
	import { levelRows, type LevelRow } from '$lib/player/ladder';
	import { clampPrefill, type QuizOptions } from '$lib/options';
	import { confirmAction, confirmState } from '$lib/confirm.svelte';

	// The cascade this player was made for. The layout beside this page makes a
	// new page for another id, so it never changes under the player.
	const id = page.params.id as string;

	let db = $state<UserDb | null>(null);
	let player = $state<Player | null>(null);
	let v = $state<PlayerView | null>(null);
	let attempts = $state<AttemptRow[]>([]);
	let desktop = $state(true);
	let landscape = $state(false);
	let settingsOpen = $state(false);
	let typedText = $state('');
	let typedInput = $state<HTMLInputElement | null>(null);
	let typedFocused = $state(false);
	/** The last entry was wrong: the input shows red until the next keystroke. */
	let typedWrong = $state(false);
	/** The last entry the card took (an anagram of the question), shown under the input: green if right, red if wrong. */
	let lastEntry = $state<{ text: string; correct: boolean } | null>(null);
	/** The scrolling quiz area, and the answer inside it that shrinks to fit it. */
	let fitArea = $state<HTMLElement | null>(null);
	let answerBox = $state<HTMLElement | null>(null);
	let quizOptions = $state<QuizOptions | null>(null);
	let maxQuiz = $state(300_000);

	// The repeat guard is a setting on this device (display.repeat_guard_ms), read on every press.
	const actions = new Debounce(() => display.value.repeat_guard_ms);
	const wheel = new Debounce(150);

	let rows = $derived<LevelRow[]>(v?.cascade ? levelRows(v.quizzes, v.cascade.depth, attempts) : []);
	/** The quiz the status bar's Level row describes: the one played, or the segmented level whose segment it drills. */
	let levelQuiz = $derived(v?.bar?.level ?? v?.quiz ?? null);
	/** The Segment row, on a level studied in segments (PLAN.md § Desktop layout). */
	let segment = $derived(v?.bar?.segment ?? null);
	/** The position the Level row shows: the card shown, or the waiting level's cursor while its segment is drilled. */
	let levelPos = $derived(!levelQuiz ? 0 : v?.bar && !v.bar.played ? levelQuiz.cursor : (v?.card?.pos ?? levelQuiz.cursor));
	let dsp = $derived(display.value);
/** Typed mode's "3 of 9 found", when the cascade's setting asks for it and the card is still being typed. */
	let foundCount = $derived.by(() => {
		const card = v?.card;
		if (!v?.cascade?.show_found_count || !card?.typed || card.revealed || !player) return null;
		return `${card.typed.found.length} of ${player.words(card).length} found`;
	});
	/** How far through the pass the current card is, for the status bar's line. */
	let progress = $derived(levelQuiz ? ((levelPos + 1) / Math.max(1, levelQuiz.question_count)) * 100 : 0);
	/** Of the level's questions, the share graded in this pass; of those, the share correct. */
	let gradedPct = $derived(levelQuiz ? ((levelQuiz.correct_count + levelQuiz.missed_count) / Math.max(1, levelQuiz.question_count)) * 100 : 0);
	let correctPct = $derived(
		levelQuiz && levelQuiz.correct_count + levelQuiz.missed_count > 0
			? (levelQuiz.correct_count / (levelQuiz.correct_count + levelQuiz.missed_count)) * 100
			: null
	);
	/** The same two shares within the segment, or its drill. */
	let segmentGradedPct = $derived(segment ? ((segment.correct + segment.missed) / Math.max(1, segment.length)) * 100 : 0);
	let segmentCorrectPct = $derived(segment && segment.correct + segment.missed > 0 ? (segment.correct / (segment.correct + segment.missed)) * 100 : null);
	/** A percentage to two decimal places, rounded. */
	const pct = (p: number) => `${p.toFixed(2)}%`;
	/** Whether the share correct so far would clear the level: green on track, red not; nothing before a grade. */
	let onTrack = $derived(correctPct === null || !v?.cascade ? null : correctPct >= v.cascade.clear_threshold);
	/** The grade the quiz area's border shows once the answer is shown; none before. */
	let gradeState = $derived(v?.status === 'ready' && v.card?.revealed ? v.card.grade : null);
	// Each grade's border is a setting: by default a missed answer shows red and a correct one nothing.
	let gradeBorder = $derived(
		gradeState === 'correct' && dsp.border_correct
			? 'border-green-600'
			: gradeState === 'missed' && dsp.border_missed
				? 'border-red-600'
				: 'border-transparent'
	);
	/** The menu beside the quiz: hidden whenever a cascade opens, shown for this visit by ☰. */
	let menuOpen = $state(false);
	let cascadeOptions = $state<QuizOptions | null>(null);
	let atLimit = $state(false);
	let cascadeError = $state<string | null>(null);
	/**
	 * The offer under each of this cascade's settings changed since Settings
	 * opened: the values saved, and how many cascades "all" would reach.
	 */
	type Offer = { fields: CascadeSettings; reach: number; serial: number };
	let offers = $state<Record<string, Offer>>({});
	let offerSerial = 0;
	/** The level's options were just saved: says so under them. */
	let levelSaved = $state(0);
	/** The cascades whose settings this one can copy, the one chosen, and what copying did. */
	let sources = $state<CascadeRow[]>([]);
	let copyFrom = $state('');
	let copied = $state<string | null>(null);
	/** Bumped when a copy changes the options under the forms, so they show the new ones. */
	let formKey = $state(0);

	async function refreshSide() {
		if (!db) return;
		attempts = await db.getAllFromIndex('quiz_attempts', 'cascade_id', id);
	}

	onMount(() => {
		const fine = matchMedia('(pointer: fine) and (min-width: 900px)');
		const land = matchMedia('(orientation: landscape)');
		const layout = () => {
			desktop = fine.matches;
			landscape = land.matches;
		};
		layout();
		fine.addEventListener('change', layout);
		land.addEventListener('change', layout);
		let release: (() => void) | null = null;
		let unsub: (() => void) | null = null;
		let cancelled = false;
		(async () => {
			if (!session.userId) return;
			const d = await userDb(session.userId, session.username);
			if (cancelled) return;
			db = d;
			const max = (await getMeta(d, 'server')).max_quiz_questions;
			if (cancelled) return;
			maxQuiz = max;
			await display.load(d);
			await controls.load(d);
			if (cancelled) return;
			// Navigating to the player is an open (§ Downloads).
			const tx = d.transaction(['meta'], 'readwrite');
			await recordOpen(tx as unknown as RwTx, id, new Date().toISOString());
			await tx.done;
			// The page was left while those ran: no lock, no open cascade, no player.
			if (cancelled) return;
			// Each player tab holds a Web Lock named for its cascade, so no drop pass takes it.
			// A lock granted after the page is left is given straight back.
			if (navigator.locks) {
				void navigator.locks.request(PLAYER_LOCK + id, () => (cancelled ? undefined : new Promise<void>((r) => (release = r))));
			}
			syncState.openCascade = id;
			const p = new Player(d, id, {
ensure: (cid, progress) => ensureCascade(d, cid, progress),
				fetchCard: (cid, idx, ahead) => fetchCard(d, cid, idx, ahead),
				fetchAhead: (cid, idx) => fetchAhead(d, cid, idx),
				fetchDistribution: (cid) => fetchDistribution(d, cid),
				afterWrite: () => {
					afterLocalWrite();
					void refreshSide();
				}
			});
			unsub = p.subscribe((x) => (v = x));
			player = p;
			await refreshSide();
			await p.load();
		})();
		return () => {
			cancelled = true;
			fine.removeEventListener('change', layout);
			land.removeEventListener('change', layout);
			unsub?.();
			release?.();
			if (syncState.openCascade === id) syncState.openCascade = null;
		};
	});

	// Step 5 of the rebase: refresh if what the player shows changed.
	$effect(() => {
		const c = syncState.changed;
		if (c.tick && player && c.ids.includes(id)) {
			void refreshSide();
			// As an action does, the reload holds background download writes off, so
			// an action waiting its turn behind it is not kept waiting long.
			const p = player;
			void playerActs(() => p.load(true));
		}
	});

	// A download made progress: the card takes what it lacked.
	$effect(() => {
		if (syncState.progress && player) void player.refreshCard();
	});

	/**
	 * An action from a key, a click, the wheel or a tap. Never dropped and never
	 * waited on: the player takes actions in order and changes the screen before
	 * its writes are saved (PLAN.md § Taking a quiz → Instant at any size).
	 */
	function act(a: Action) {
		// The completion screen is in front: the new pass under it takes no action.
		if (!player || v?.completion || !actions.pass(a, performance.now())) return;
		const card = v?.card;
		// Before the reveal, Show / Next on a typed card focuses the input instead of giving up.
		if (a === 'show_next' && card?.typed && !card.revealed && !typedFocused) {
			typedInput?.focus();
			return;
		}
		const p = player;
		if (a !== 'toggle_grade') {
			typedText = '';
			typedWrong = false;
		}

		// Background downloads start no chunk while the action and its writes run.
		void playerActs(async () => {
			if (a === 'show_next') await p.showNext();
			else if (a === 'toggle_grade') await p.toggle();
			else await p.previous();
		}).catch((e) => console.error('player action failed', e));
	}


	/** The column layout on a phone: a tap in the quiz area acts by its third, Previous, Toggle or Show / Next. */
	function tapColumn(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('input,button,a')) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const third = Math.min(2, Math.max(0, Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * 3)));
		act((['previous', 'toggle_grade', 'show_next'] as const)[third]);
	}

	function onKey(e: KeyboardEvent) {
		// A confirmation owns the keyboard: Space or Enter there must not also act on the quiz.
		if (confirmState.current) return;
		if (settingsOpen) {
			if (e.key === 'Escape') settingsOpen = false;
			return;
		}
		// The completion screen keeps its keys: Space or Enter presses its focused button.
		if (!v || v.status !== 'ready' || v.completion) return;
		const t = e.target as HTMLElement | null;
		const inTyped = t === typedInput;
		// Text fields outside the quiz area keep their keys.
		if (!inTyped && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		if (inTyped && inputOwns(e)) return;
		const a = actionFor(controls.value, keyStroke(e));
		if (!a) return;
		e.preventDefault();
		// A key held down is one press: its repeats would show and grade cards unseen.
		if (e.repeat) return;
		void act(a);
	}

	function onMouse(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('input,button,a')) return;
		const s = mouseStroke(e);
		if (!s) return;
		e.preventDefault();
		const a = actionFor(controls.value, s);
		if (a) void act(a);
	}

	function onWheel(e: WheelEvent) {
		const s = wheelStroke(e);
		if (!s) return;
		const a = actionFor(controls.value, s);
		if (!a) return; // an unbound direction scrolls as usual
		e.preventDefault();
		if (wheel.pass(s.code, performance.now())) void act(a);
	}

	/**
	 * Fits the answer, definitions included, on the screen: when the quiz area
	 * would scroll, down or across, its sizes are scaled down (the --fit factor AnswerView reads)
	 * as far as needed, to a floor of FIT_MIN. Runs before the browser paints,
	 * so the answer never shows at a size that scrolls.
	 */
	const FIT_MIN = 0.3;
	function fit() {
		const area = fitArea;
		const box = answerBox;
		if (!area || !box) return;
		// Too tall, or too wide: a long line of hooks on a phone runs past the edge otherwise.
		const fits = () => area.scrollHeight <= area.clientHeight + 1 && area.scrollWidth <= area.clientWidth + 1;
		box.style.setProperty('--fit', '1');
		if (fits()) return;
		let lo = FIT_MIN;
		let hi = 1;
		for (let i = 0; i < 8; i++) {
			const mid = (lo + hi) / 2;
			box.style.setProperty('--fit', String(mid));
			if (fits()) lo = mid;
			else hi = mid;
		}
		box.style.setProperty('--fit', String(lo));
	}

	// Refit when the area changes size or anything in it changes: a reveal, a
	// typed word, definitions arriving, a display setting. The fit's own change
	// to the answer's style is not a reason to refit.
	$effect(() => {
		const area = fitArea;
		if (!area) return;
		const resize = new ResizeObserver(() => fit());
		resize.observe(area);
		const changes = new MutationObserver((records) => {
			if (records.some((r) => !(r.target === answerBox && r.attributeName === 'style'))) fit();
		});
		changes.observe(area, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
		fit();
		return () => {
			resize.disconnect();
			changes.disconnect();
		};
	});

	/**
	 * The card being typed, if any: changes only when another card comes up to
	 * type, so the input is focused once per card, not on every keystroke.
	 */
	let typingCard = $derived(
		v?.status === 'ready' && v.card?.typed && !v.card.revealed && v.card.key !== null && !v.completion && v.quiz
			? `${v.quiz.id}:${v.card.pos}`
			: null
	);

	// Typed mode: each card's input takes focus as the card comes up (and when
	// Settings or a confirmation closes over it), so the next answer can be
	// typed straight away, with no click in the box.
	$effect(() => {
		const input = typedInput;
		if (typingCard && input && !settingsOpen && !confirmState.current) input.focus();
	});

	// A new card to type starts with the input as normal, not red from the last one, and no last entry.
	$effect(() => {
		void typingCard;
		typedWrong = false;
		lastEntry = null;
	});

	async function onTypedKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !player) return;
		e.preventDefault();
		const text = typedText;
		const r = await player.enter(text);
		// A word that is not an anagram of the question stays in the input to fix; everything else clears it.
		if (r && r.kind !== 'not_anagram') typedText = '';
		typedWrong = r?.kind === 'wrong';
		// An anagram of the question is taken, right or wrong, and shown under the input.
		if (r?.kind === 'found' || r?.kind === 'already' || r?.kind === 'wrong') {
			lastEntry = { text: text.trim().toUpperCase(), correct: r.kind !== 'wrong' };
		}
	}

	async function write(op: NewOp) {
		if (!db) return;
		await applyLocally(db, op);
		afterLocalWrite();
		await refreshSide();
		await player?.load(true);
	}

	/**
	 * Changes this cascade's settings, for it alone, then offers to use the same
	 * values for every cascade (§ Settings → One cascade, or all of them).
	 * `key` names the offer: one per setting, or one for the new levels' options.
	 */
	async function setCascade(fields: CascadeSettings, key: string = Object.keys(fields)[0]) {
		const c = v?.cascade;
		if (!c || !Object.keys(fields).length) return;
		// Definitions, hooks or probability orders change what an answer holds: the cards in memory go first.
		if (fields.show_definitions !== undefined || fields.show_hooks !== undefined || fields.show_probability !== undefined) player?.settingsChanged();
		await write({ type: 'set_cascade_options', cascade_id: c.id, ...fields } as NewOp);
		// Switching mode mid-card resets its typed entries.
		if (fields.answer_mode !== undefined) await player?.modeChanged();
		await offer(key, fields);
	}

	/** Flashcard or typed, for this cascade alone. */
	async function setAnswerMode(mode: AnswerMode) {
		if (!v?.cascade || mode === v.cascade.answer_mode) return;
		await setCascade({ answer_mode: mode });
	}

	/** Settings: what is read fresh each time it opens, then the dialog. */
	async function openSettings() {
		const q = v?.quiz;
		quizOptions = q ? { segment_size: q.segment_size, progression: q.progression, require_alphabetical: q.require_alphabetical } : null;
		const c = v?.cascade;
		cascadeOptions = c
			? { segment_size: clampPrefill(c.segment_size, maxQuiz), progression: c.progression, require_alphabetical: c.require_alphabetical }
			: null;
		cascadeError = null;
		offers = {};
		levelSaved = 0;
		copied = null;
		copyFrom = '';
		if (db) {
			// Duplicate makes a new cascade, which needs room; the server checks the exact figure.
			const server = await getMeta(db, 'server');
			atLimit = (server.storage_bytes ?? 0) >= (server.max_storage_bytes ?? DEFAULT_STORAGE_LIMIT);
			sources = c ? await copySources(db, c) : [];
		}
		settingsOpen = true;
	}

	/** The level being studied: its options change as soon as one is changed, from the current card. */
	async function saveQuizOptions(o: QuizOptions) {
		const q = v?.quiz;
		if (!q) return;
		const op: Record<string, unknown> = { type: 'set_quiz_options', quiz_id: q.id };
		if (o.segment_size !== q.segment_size) op.segment_size = o.segment_size;
		if (o.progression !== q.progression) op.progression = o.progression;
		if (o.require_alphabetical !== q.require_alphabetical) op.require_alphabetical = o.require_alphabetical;
		if (Object.keys(op).length <= 2) return;
		await write(op as unknown as NewOp);
		levelSaved++;
	}

	/** The options the cascade's new levels start with: saved as soon as one is changed, like its other settings. */
	async function saveCascadeOptions(o: QuizOptions) {
		const c = v?.cascade;
		if (!c) return;
		const fields: CascadeSettings = {};
		if (o.segment_size !== c.segment_size) fields.segment_size = o.segment_size;
		if (o.progression !== c.progression) fields.progression = o.progression;
		if (o.require_alphabetical !== c.require_alphabetical) fields.require_alphabetical = o.require_alphabetical;
		await setCascade(fields, 'levels');
	}

	/** After a change to this cascade alone, the offer to use it for every cascade. */
	async function offer(key: string, fields: CascadeSettings) {
		if (!db || !Object.keys(fields).length) return;
		const reach = (await reachable(db, fields)).length;
		offers = { ...offers, [key]: { fields, reach, serial: ++offerSerial } };
	}

	/** "all 12 cascades" (or anagram cascades, for a setting only they have), when there are others. */
	function widenings(o: Offer): Widening[] {
		const d = db;
		if (!d || o.reach < 2) return [];
		const only = kindOf(o.fields);
		const kind = only ? `${{ anagram: 'anagram', leave_value: 'leave value', definition: 'definition' }[only]} cascades` : 'cascades';
		return [
			{
				key: 'all',
				label: `all ${o.reach} ${kind}`,
				done: `Used for all ${o.reach} ${kind}`,
				run: async () => {
					await applyToAll(d, o.fields);
					afterLocalWrite();
					await refreshSide();
					await player?.load(true);
				}
			}
		];
	}

	/**
	 * The cascade's clear threshold, from 1 to 100. It is the cascade's alone,
	 * and every finish reads it, so the pass in progress is judged by it too.
	 */
	async function setThreshold(el: HTMLInputElement) {
		const c = v?.cascade;
		if (!c) return;
		const n = Number(el.value);
		if (!Number.isInteger(n) || n < 1 || n > 100) {
			el.value = String(c.clear_threshold);
			return;
		}
		if (n === c.clear_threshold) return;
		await setCascade({ clear_threshold: n });
	}

	/** Gives this cascade every setting of the one chosen that applies to it, in one change. */
	async function copySettingsFrom() {
		const c = v?.cascade;
		const from = sources.find((o) => o.id === copyFrom);
		if (!db || !c || !from) return;
		player?.settingsChanged();
		const n = await copySettings(db, from, c);
		afterLocalWrite();
		await refreshSide();
		// The cascade first, then its card, which may now be typed or hold more.
		await player?.load(true);
		await player?.modeChanged();
		// The forms show what the cascade has now.
		cascadeOptions = v?.cascade
			? { segment_size: clampPrefill(v.cascade.segment_size, maxQuiz), progression: v.cascade.progression, require_alphabetical: v.cascade.require_alphabetical }
			: cascadeOptions;
		offers = {};
		formKey++;
		copied = n ? `Copied ${n} setting${n === 1 ? '' : 's'} from “${from.name}”.` : `“${from.name}” already has the same settings.`;
	}

	async function restore() {
		await write({ type: 'restore_cascade', cascade_id: id });
	}

	async function moveToTrash() {
		const c = v?.cascade;
		if (!db || !c) return;
		const days = (await getMeta(db, 'server')).trash_retention_days;
		const ok = await confirmAction({
			title: `Move “${c.name}” to the Trash?`,
			body: `You can restore it from the Trash for ${days} days. After that it is deleted forever.`,
			action: 'Move to Trash'
		});
		if (!ok) return;
		await write({ type: 'trash_cascade', cascade_id: id });
		await goto('/');
	}

	let starting = $state<{ stage: 'server' | 'device'; progress: number; count: number | null } | null>(null);

	/** Settings → Duplicate cascade: a new cascade from the same filters and settings, at Level 1. */
	async function duplicate() {
		if (!db || !session.userId) return;
		const ok = await confirmAction({
			title: `Duplicate “${v?.cascade?.name ?? 'this cascade'}”?`,
			body: `This makes a new cascade from the same filters, with the same threshold and options, starting at Level 1. It takes this cascade’s name with the next free number after it. This cascade isn’t changed. You’ll have both, and each counts toward your storage until it is deleted from the Trash.`,
			action: 'Duplicate'
		});
		if (!ok) return;
		const { device_id } = await getMeta(db, 'device');
		const body = { id: crypto.randomUUID(), source_quiz_id: crypto.randomUUID(), device_id, at: new Date().toISOString() };
		cascadeError = null;
		if (!navigator.onLine) {
			cascadeError = 'Duplicating a cascade needs a connection.';
			return;
		}
		starting = { stage: 'server', progress: 0, count: null };
		try {
			// Retried with the same ids on a 5xx, a 429 or a dropped connection, as
			// Create Cascade is (builder/create.ts): the server answers a repeat
			// with the cascade it already made.
			const created = await sendWithRetry(() => api.post<Created>(`/api/cascades/${id}/duplicate`, body));
			starting = { stage: 'device', progress: 0, count: Number(created.source_quiz.question_count) };
			await storeCreated(db, created, new Date(), (f) => starting && (starting.progress = f));
			settingsOpen = false;
			await goto(`/cascades/${body.id}`);
		} catch (e) {
			if (e instanceof ApiError && e.code === 'storage_limit') {
				const b = e.body as { used: number; limit: number; needed: number };
				cascadeError = `Duplicating needs about ${formatBytes(b.needed)}, and ${formatBytes(Math.max(0, b.limit - b.used))} of your storage is free. Empty the Trash or delete cascades to make room.`;
			} else if (isRetriable(e)) cascadeError = 'Duplicating a cascade needs a connection.';
			// The server refused it, or this device could not store it: not the connection.
			else cascadeError = 'The cascade could not be duplicated. Try again.';
		} finally {
			starting = null;
		}
	}

	/** The completion screen's Start over: another pass of this cascade, whose Source quiz the finish has reset. */
	function startOver() {
		player?.dismissCompletion();
	}
</script>

<svelte:window onkeydown={onKey} />

{#snippet waiting(text: string, detail: string | null = null)}
	<div class="flex flex-col items-center gap-3 text-muted-foreground" role="status" aria-busy="true">
		<LoaderCircleIcon class="size-8 animate-spin" aria-hidden="true" />
		<p>{text}</p>
		{#if detail}<p class="max-w-sm text-center text-sm">{detail}</p>{/if}
	</div>
{/snippet}

{#snippet question()}
	{#if v?.fetchingCard}
		{@render waiting('Loading the next questions…')}
	{:else if v?.card}
		{@const card = v.card}
		{#if card.key === null}
			<p class="text-center text-muted-foreground">This question needs a connection.</p>
		{:else}
			<div class="text-center font-semibold" style={textStyle(dsp.question_font, dsp.question_size_px, dsp.question_spacing)} data-question><TileText text={card.key} /></div>
			<!-- The answer space: typed words as they are found, bare, then the whole answer on the reveal. -->
			<div class="mt-6" bind:this={answerBox}>
				{#if card.revealed}
					{#if card.answer === null}
						<p class="text-center text-muted-foreground">Answer needs a connection.</p>
					{:else}
						<AnswerView
							quizType={v.cascade!.quiz_type}
							answer={card.answer}
							settings={v.cascade!}
							found={card.typed?.found ?? null}
							font={dsp.answer_font}
							size={dsp.answer_size_px}
							spacing={dsp.answer_spacing}
							definition={{ font: dsp.definition_font, size: dsp.definition_size_px, spacing: dsp.definition_spacing }}
							definitionWidth={dsp.definition_width_px}
							hookSize={dsp.hook_size_px}
							word={card.word}
						/>
					{/if}
				{:else if card.typed}
					<AnswerView
						quizType={v.cascade!.quiz_type}
						answer={card.answer}
						settings={v.cascade!}
						typing={card.typed.found}
						font={dsp.answer_font}
						size={dsp.answer_size_px}
						spacing={dsp.answer_spacing}
					/>
				{/if}
				{#if card.typed?.outOfOrder.length}
					<p class="mt-4 text-center text-sm text-destructive">
						Out of order: {#each card.typed.outOfOrder as w, i (w)}{#if i}, {/if}<TileText text={w} />{/each}
					</p>
				{/if}
			</div>
			{#if card.revealed}
				<!-- The grade is the quiz area's border colour; this says it for screen readers. -->
				<p class="sr-only" role="status">{card.grade === 'correct' ? 'Correct' : 'Missed'}</p>
			{/if}
		{/if}
		{#if v.distributionMissing}
			<p class="mt-2 text-center text-sm text-muted-foreground">Typed mode needs a connection for this cascade’s tiles.</p>
		{/if}
		{#if v.message}
			<p class="mt-4 text-center text-sm text-muted-foreground" role="status">{v.message}</p>
		{/if}
		{#if v.storage}
			<div class="mt-2 text-center text-sm">
				This device is full. Free space by deleting cascades you no longer need, or by logging in to
				another account used here and logging out with its data removed.
				<Button size="sm" variant="outline" onclick={() => player?.retryStorage()}>Try again</Button>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet status()}
	{#if !v || v.status === 'loading'}
		{@render waiting('Loading…')}
	{:else if v.status === 'downloading'}
<div class="mx-auto flex max-w-sm flex-col items-center gap-3 text-muted-foreground" role="status" aria-busy="true">
			<p class="text-foreground">Getting this level ready…</p>
			<!-- A first open's share done (PLAN.md § Downloads: "behind a short progress indicator"). -->
			<div
				class="h-2 w-64 max-w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Getting this level ready"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={v.downloadProgress === null ? undefined : Math.round(v.downloadProgress * 100)}
				data-download-progress
			>
				{#if v.downloadProgress === null}
					<div class="h-full w-1/3 animate-pulse rounded-full bg-foreground/40"></div>
				{:else}
					<div class="h-full bg-foreground/60 transition-[width]" style={`width: ${v.downloadProgress * 100}%`}></div>
				{/if}
			</div>
			<p class="min-h-5 text-sm tabular-nums">{v.downloadProgress === null ? '' : `${Math.floor(v.downloadProgress * 100)}%`}</p>
			<p class="text-center text-sm">Its questions are downloading to this device. You can start as soon as they are here.</p>
		</div>
	{:else if v.status === 'needs_connection'}
		<p class="text-muted-foreground">This cascade needs a connection to download.</p>
	{:else if v.status === 'gone'}
		<p class="text-muted-foreground">This cascade is not on this device.</p>
		<Button href="/" variant="outline" class="mt-4">Cascades</Button>
	{:else if v.status === 'trashed'}
		<p>This cascade is in the Trash.</p>
		<Button class="mt-4" onclick={restore}>Restore</Button>
		<div class="mt-6"><CascadeLadder {rows} /></div>
	{/if}
{/snippet}

{#snippet typedBar(mobile: boolean)}
	<!-- Typed mode's input, at the bottom of the page until the reveal. -->
	{#if v?.status === 'ready' && v.card?.typed && !v.card.revealed && v.card.key !== null}
		{@const card = v.card}
		{@const typed = v.card.typed}
		<div class="shrink-0 border-t bg-background px-4 py-3">
			{#if mobile && typedFocused}
				<!-- The on-screen keyboard covers the zones: three buttons sit above it. -->
				<div class="mb-2 flex justify-around">
					<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('previous')}>Previous</Button>
					<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('show_next')}>Show / Next</Button>
					<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('toggle_grade')}>Toggle</Button>
				</div>
			{/if}
			<div class="mx-auto max-w-sm space-y-1">
				{#if v.quiz?.require_alphabetical && typed.found.length}
					<p class="text-center text-xs text-muted-foreground">after <TileText text={typed.found.at(-1) ?? ''} /></p>
				{/if}
				<input
					bind:this={typedInput}
					bind:value={typedText}
					onkeydown={onTypedKey}
					oninput={() => (typedWrong = false)}
					onfocus={() => (typedFocused = true)}
					onblur={() => (typedFocused = false)}
					class="w-full rounded-md border px-3 py-2 text-center uppercase {typedWrong
						? 'border-red-600 bg-red-600/15 ring-2 ring-red-600 outline-none'
						: 'bg-background'}"
					data-wrong={typedWrong || undefined}
					aria-invalid={typedWrong || undefined}
					aria-label="Type an answer"
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
				/>
				<!-- The last entry the card took, green if right and red if wrong; then any note.
				     Both kept when empty, so neither appearing ever moves the input. -->
				<p
					class="min-h-6 text-center font-semibold tracking-wide {lastEntry?.correct ? 'text-green-600' : 'text-red-600'}"
					data-last-entry={lastEntry ? (lastEntry.correct ? 'correct' : 'wrong') : undefined}
					aria-live="polite"
				>
					{#if lastEntry}<span class="sr-only">{lastEntry.correct ? 'Right:' : 'Wrong:'}</span> {lastEntry.text}{/if}
				</p>
				<p class="min-h-4 text-center text-xs text-muted-foreground" role="status">{card.note ?? ''}</p>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet menuItems()}
	<!-- The player's menu: on the desktop a panel beside the quiz, on a phone a sheet over it. -->
	<div class="mb-2 flex items-center justify-between">
		<a href="/" class="font-semibold">Acrodont</a>
		<button class="rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onclick={() => (menuOpen = false)} aria-label="Hide menu" title="Hide menu">«</button>
	</div>
	{#if session.isAdmin}<a class="rounded px-2 py-1 hover:bg-muted max-sm:py-2" href="/admin">Admin</a>{/if}
	<a class="rounded px-2 py-1 hover:bg-muted max-sm:py-2" href="/account">Account</a>
	<button
		class="rounded px-2 py-1 text-left hover:bg-muted max-sm:py-2"
		onclick={() => {
			if (!desktop) menuOpen = false;
			void openSettings();
		}}>Settings</button
	>
{/snippet}

{#snippet statusBar()}
	<!-- The status bar keeps its place when hidden, with only its Show button (and the sync
	     status when something needs attention), so hiding it never changes the quiz area
	     or its grade border. -->
	<footer class="shrink-0 border-t text-sm" class:border-transparent={dsp.status_bar_hidden}>
		<div class="h-0.5" class:bg-muted={!dsp.status_bar_hidden} aria-hidden="true">
			{#if !dsp.status_bar_hidden}<div class="h-full bg-foreground/50" style={`width: ${progress}%`}></div>{/if}
		</div>
		<!-- The Show / Hide button, then the rest, which on a phone wraps to a second line
		     rather than leave anything out; that line starts under the first item, not under
		     the button. -->
		<div class="flex min-h-11 items-start gap-x-5 py-2 pr-6 pl-3 max-sm:gap-x-2 max-sm:pr-3 max-sm:pl-1">
			{#if dsp.status_bar_hidden}
				<button
					class="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					onclick={() => display.set({ status_bar_hidden: false })}
					aria-label="Show status bar"
					title="Show status bar"><PanelBottomOpenIcon class="size-4" /></button
				>
			{:else}
				<button
					class="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					onclick={() => display.set({ status_bar_hidden: true })}
					aria-label="Hide status bar"
					title="Hide status bar"><PanelBottomCloseIcon class="size-4" /></button
				>
			{/if}
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 leading-7 max-sm:gap-x-3">
				{#if !dsp.status_bar_hidden && v?.quiz && v.cascade && levelQuiz}
					{#snippet levelRow(cell: string)}
						<p class="font-medium {cell}" data-status-row="level">Level {levelQuiz.level} of {v!.cascade!.depth}</p>
						<p class="text-muted-foreground {cell ? 'whitespace-nowrap' : ''}">Pass {levelQuiz.attempt}</p>
						<p class={cell ? 'whitespace-nowrap' : ''} title="The card shown, and the share of the level graded in this pass">
							<!-- The count in its own element, apart from its percentage: it is read on its own. -->
							<!-- data-played-position marks the position of the quiz being played: this one, or the Segment row's during a drill. -->
							<span data-played-position={v?.bar?.played === false ? undefined : ''}>{levelPos + 1} / {levelQuiz.question_count}</span>
							<span class="text-muted-foreground">({pct(gradedPct)})</span>
						</p>
						<p
							class={cell ? 'whitespace-nowrap' : ''}
							title={`Correct and missed in this pass, and the share correct: the level clears at ${v!.cascade!.clear_threshold}%`}
						>
							<span>{levelQuiz.correct_count} ✓ {levelQuiz.missed_count} ✗</span>
							{#if correctPct !== null}
								<span class:text-green-600={onTrack} class:text-red-600={onTrack === false} data-on-track={onTrack}>({pct(correctPct)})</span>
							{/if}
						</p>
					{/snippet}
					{#if segment}
						<!-- A level studied in segments: the Segment row under the Level row, its figures in
						     the same columns so the two read against each other. On a phone each row's name
						     takes a line of its own and the figures stay in columns under it. A drill of the
						     segment's misses is the segment's next pass: the Level row stays on the level. -->
						<div class="grid grid-cols-[auto_auto_auto] justify-start gap-x-3 tabular-nums sm:grid-cols-[auto_auto_auto_auto] sm:gap-x-5" data-status-rows>
							{@render levelRow('max-sm:col-span-full whitespace-nowrap')}
							<p class="font-medium whitespace-nowrap max-sm:col-span-full" data-status-row="segment">Segment {segment.segment} of {segment.total}</p>
							<p class="whitespace-nowrap text-muted-foreground" title="1 is the segment itself; each drill of its misses is the next pass">
								Pass {segment.pass}
							</p>
							<p class="whitespace-nowrap" title="The card shown, and the share of the segment graded in this pass">
								<span data-played-position={v?.bar?.played === false ? '' : undefined}>{segment.position} / {segment.length}</span>
								<span class="text-muted-foreground">({pct(segmentGradedPct)})</span>
							</p>
							<p class="whitespace-nowrap" title="Correct and missed in this segment, and the share correct: what is missed is drilled before the next segment">
								<span>{segment.correct} ✓ {segment.missed} ✗</span>
								{#if segmentCorrectPct !== null}<span class="text-muted-foreground">({pct(segmentCorrectPct)})</span>{/if}
							</p>
						</div>
					{:else}
						{@render levelRow('')}
					{/if}
					{#if foundCount}<p>{foundCount}</p>{/if}
				{/if}
				<div class="ml-auto"><SyncStatus quiet={dsp.status_bar_hidden || dsp.sync_status_hidden} /></div>
			</div>
		</div>
	</footer>
{/snippet}

{#snippet showMenu(cls: string)}
	<button class="{cls} z-10 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" onclick={() => (menuOpen = true)} aria-label="Show menu" title="Show menu">☰</button>
{/snippet}

{#if desktop}
	<div class="flex h-screen">
		{#if menuOpen}
			<nav class="flex w-48 shrink-0 flex-col gap-1 border-r p-4 text-sm" aria-label="Player menu">{@render menuItems()}</nav>
		{/if}
		<div class="relative flex min-w-0 flex-1 flex-col">
			<!-- The quiz area: the only place mouse controls act; no selection, no context menu.
			     The question sits at the top, so revealing the answer never moves it. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				role="application"
				class="relative flex min-h-0 flex-1 flex-col select-none {gradeBorder}"
				style={`border-width: ${dsp.border_px}px; border-style: solid;`}
				data-grade={gradeState ?? undefined}
				aria-label="Quiz area"
				onmousedown={(e) => e.button === 1 && e.preventDefault()}
				onmouseup={onMouse}
				oncontextmenu={(e) => e.preventDefault()}
				onauxclick={(e) => e.preventDefault()}
				onwheel={onWheel}
			>
				{#if !menuOpen}{@render showMenu('absolute top-3 left-3')}{/if}
				<div class="relative flex min-h-0 flex-1 flex-col items-center">
					<div bind:this={fitArea} data-fit-area class="flex flex-1 flex-col items-center self-stretch overflow-y-auto px-8 pb-8" style={`padding-top: ${dsp.question_top_px}px;`}>
						<!-- The whole width of the page: a definition's column runs to its right edge. -->
						<div class="w-full">
							{#if v?.status === 'ready'}{@render question()}{:else}<div class="text-center">{@render status()}</div>{/if}
						</div>
					</div>
					{#if v?.banner}<p class="absolute bottom-4 max-w-[70%] rounded-md bg-muted px-4 py-2 text-center text-sm" role="status">{v.banner}</p>{/if}
				</div>
				{@render typedBar(false)}
			</div>
			{@render statusBar()}
		</div>
	</div>
{:else}
	<!-- A phone or tablet: the quiz, then typed mode's input, then the status bar, as on the
	     desktop. The three actions are tap zones (display.mobile_buttons): by default three
	     columns, Previous, Toggle and Show / Next, each tapped anywhere in its third of the quiz
	     area, with its label at the bottom; or the question, then three rows of buttons
	     under it, Previous, Toggle and Show / Next, the last nearest the thumb. ☰ opens
	     the menu, Settings with it. -->
	<div class="flex h-dvh flex-col">
		{#if v?.status === 'ready'}
			{#if dsp.mobile_buttons === 'rows'}
				<div class="relative flex min-h-0 flex-1 select-none" class:flex-col={!landscape} style="touch-action: manipulation">
					{@render showMenu('absolute top-1 left-1')}
					{#if v.banner}<p class="absolute top-2 right-2 left-12 z-10 rounded-md bg-muted px-3 py-2 text-sm" role="status">{v.banner}</p>{/if}
					<div
						bind:this={fitArea}
						data-fit-area
						class="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 {gradeBorder}"
						style={`padding-top: ${Math.max(dsp.question_top_px, 40)}px; border-width: ${dsp.border_px}px; border-style: solid;`}
						data-grade={gradeState ?? undefined}
					>
						{@render question()}
					</div>
					<!-- Show / Next at the bottom, nearest the thumb; in landscape the rows stand at
					     the bottom of a column on the right. Each row is display.mobile_row_px tall. -->
					<div class="flex shrink-0 flex-col text-muted-foreground {landscape ? 'w-2/5 justify-end' : ''}" data-zone="rows">
						<button class="shrink-0 active:bg-muted/60" style={`height: ${dsp.mobile_row_px}px`} onclick={() => act('previous')}>↶ Previous</button>
						<button class="shrink-0 active:bg-muted/60" style={`height: ${dsp.mobile_row_px}px`} onclick={() => act('toggle_grade')}>✓ ⇄ ✗ Toggle</button>
						<button class="shrink-0 active:bg-muted/60" style={`height: ${dsp.mobile_row_px}px`} onclick={() => act('show_next')}>Show / Next ▸</button>
					</div>
				</div>
			{:else}
				<div
					class="relative flex min-h-0 flex-1 flex-col select-none {gradeBorder}"
					style={`border-width: ${dsp.border_px}px; border-style: solid; touch-action: manipulation;`}
					data-grade={gradeState ?? undefined}
				>
					{@render showMenu('absolute top-1 left-1')}
					{#if v.banner}<p class="absolute top-2 right-2 left-12 z-10 rounded-md bg-muted px-3 py-2 text-sm" role="status">{v.banner}</p>{/if}
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
					<div
						bind:this={fitArea}
						data-fit-area
						data-zone="columns"
						class="relative min-h-0 flex-1 overflow-y-auto px-4 pb-4"
						style={`padding-top: ${Math.max(dsp.question_top_px, 40)}px;`}
						onclick={tapColumn}
					>
						{@render question()}
					</div>
					<div class="relative grid shrink-0 grid-cols-3 text-sm text-muted-foreground">
						<button class="h-14 active:bg-muted/60" onclick={() => act('previous')}>↶ Previous</button>
						<button class="h-14 active:bg-muted/60" onclick={() => act('toggle_grade')}>✓ ⇄ ✗ Toggle</button>
						<button class="h-14 active:bg-muted/60" onclick={() => act('show_next')}>Show / Next ▸</button>
					</div>
				</div>
			{/if}
			{@render typedBar(true)}
		{:else}
			<div class="relative min-h-0 flex-1 p-6">
				{@render showMenu('absolute top-1 left-1')}
				<div class="pt-8">{@render status()}</div>
			</div>
		{/if}
		{@render statusBar()}
	</div>
	{#if menuOpen}
		<div class="fixed inset-0 z-40 bg-black/40" role="presentation" onclick={() => (menuOpen = false)}>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<nav class="flex h-full w-64 max-w-[80%] flex-col gap-1 border-r bg-background p-4 text-sm" aria-label="Player menu" onclick={(e) => e.stopPropagation()}>
				{@render menuItems()}
			</nav>
		</div>
	{/if}
{/if}

{#snippet widen(key: string)}
	{@const o = offers[key]}
	{#if o}
		<!-- Keyed by the change, so a second change starts a fresh offer. -->
		{#key o.serial}<ApplyWider saved="Saved for this cascade" offers={widenings(o)} />{/key}
	{/if}
{/snippet}

{#snippet scopeHead(id: string, title: string, text: string)}
	<!-- Each of the two sections opens with a bar of its own, so they read as separate. -->
	<div class="-mx-6 space-y-1 border-y bg-muted/60 px-6 py-3">
		<div class="flex flex-wrap items-center gap-2">
			<h3 {id} class="text-lg font-semibold tracking-tight">{title}</h3>
			<InfoTip {text} label="About these settings" />
		</div>
	</div>
{/snippet}

{#snippet subHead(id: string, title: string, text: string | null = null)}
	<div class="flex items-center gap-1 pt-2">
		<h4 {id} class="text-sm font-semibold">{title}</h4>
		{#if text}<InfoTip {text} label="About these settings" />{/if}
	</div>
{/snippet}

{#if settingsOpen}
	<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="presentation" onclick={() => (settingsOpen = false)}>
		<!-- Every setting there is, in one place, in its two groups: this cascade's
		     and this device's. Each group says above its settings where they apply
		     (SCOPE), and each setting is saved as soon as it is changed. -->
		<div
			class="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
			role="dialog"
			aria-label="Settings"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.key === 'Escape' && (settingsOpen = false)}
		>
			<div class="border-b px-6 pt-5 pb-3">
				<div class="flex items-center justify-between gap-4">
					<h2 class="text-lg font-semibold">Settings</h2>
					<Button variant="outline" size="sm" onclick={() => (settingsOpen = false)}>Close</Button>
				</div>
			</div>
			<div class="space-y-10 overflow-y-auto px-6 pb-6">
				{#if v?.cascade && v.quiz}
					{@const c = v.cascade}
					{@const q = v.quiz}
					<section class="space-y-4" aria-labelledby="settings-cascade">
						{@render scopeHead('settings-cascade', 'Cascade Settings', SCOPE.cascade)}
						<div class="overflow-x-auto"><CascadeLadder {rows} onExport={(r) => goto(`/cascades/${id}/export?quiz=${r.quiz.id}`)} /></div>
						<SettingRow label="Clear threshold (%)" info={INFO.clear_threshold} for="cascade-threshold">
							<input
								id="cascade-threshold"
								class="w-24 rounded-md border bg-background px-2 py-1"
								type="number"
								min="1"
								max="100"
								step="1"
								value={c.clear_threshold}
								onchange={(e) => setThreshold(e.currentTarget)}
							/>
						</SettingRow>
						{@render widen('clear_threshold')}
						{#if c.quiz_type === 'anagram'}
							<!-- Typing answers is for anagram quizzes only, and each cascade keeps its own mode. -->
							<SettingRow label="Answer mode" info={INFO.answer_mode} for="player-mode">
								<select id="player-mode" class="rounded border bg-background px-2 py-1" value={c.answer_mode} onchange={(e) => setAnswerMode(e.currentTarget.value as AnswerMode)}>
									<option value="flashcard">Flashcard</option>
									<option value="typed">Typed</option>
								</select>
							</SettingRow>
							{@render widen('answer_mode')}
						{/if}
						<SettingRow label="When an answer is revealed, mark it" info={INFO.reveal_correct} for="cascade-reveal">
							<select
								id="cascade-reveal"
								class="rounded border bg-background px-2 py-1"
								value={c.reveal_correct === false ? 'missed' : 'correct'}
								onchange={(e) => setCascade({ reveal_correct: e.currentTarget.value === 'correct' })}
							>
								<option value="correct">Correct</option>
								<option value="missed">Missed</option>
							</select>
						</SettingRow>
						{@render widen('reveal_correct')}
						{#if c.quiz_type === 'anagram'}
							<SettingRow label="Show definitions" info={INFO.show_definitions} for="cascade-definitions">
								<input
									id="cascade-definitions"
									type="checkbox"
									checked={c.show_definitions !== false}
									onchange={(e) => setCascade({ show_definitions: e.currentTarget.checked })}
								/>
							</SettingRow>
							{@render widen('show_definitions')}
							<SettingRow label="Show hooks" info={INFO.show_hooks} for="cascade-hooks">
								<input id="cascade-hooks" type="checkbox" checked={c.show_hooks !== false} onchange={(e) => setCascade({ show_hooks: e.currentTarget.checked })} />
							</SettingRow>
							{@render widen('show_hooks')}
							<SettingRow label="Show how many anagrams are found in typed mode" info={INFO.found_count} for="cascade-found-count">
								<input
									id="cascade-found-count"
									type="checkbox"
									checked={c.show_found_count === true}
									onchange={(e) => setCascade({ show_found_count: e.currentTarget.checked })}
								/>
							</SettingRow>
							{@render widen('show_found_count')}
						{/if}
						{#if c.quiz_type !== 'leave_value'}
							<SettingRow label="Show each word’s probability order" info={INFO.show_probability} for="cascade-probability">
								<input
									id="cascade-probability"
									type="checkbox"
									checked={c.show_probability === true}
									onchange={(e) => setCascade({ show_probability: e.currentTarget.checked })}
								/>
							</SettingRow>
							{@render widen('show_probability')}
							<SettingRow label="Definitions in their own column" info={INFO.definition_column} for="cascade-definition-column">
								<input
									id="cascade-definition-column"
									type="checkbox"
									checked={c.definition_column !== false}
									onchange={(e) => setCascade({ definition_column: e.currentTarget.checked })}
								/>
							</SettingRow>
							{@render widen('definition_column')}
						{/if}
						{#if c.quiz_type === 'leave_value'}
							<SettingRow label="Round leave values to (decimal places)" info={INFO.leave_value_decimals} for="cascade-decimals">
								<select
									id="cascade-decimals"
									class="rounded border bg-background px-2 py-1"
									value={String(c.leave_value_decimals ?? 0)}
									onchange={(e) => setCascade({ leave_value_decimals: Number(e.currentTarget.value) })}
								>
									{#each [0, 1, 2, 3] as d (d)}<option value={String(d)}>{d}</option>{/each}
								</select>
							</SettingRow>
							{@render widen('leave_value_decimals')}
						{/if}
						{#key formKey}
							{#if quizOptions}
								<div class="space-y-3" role="group" aria-labelledby="settings-level">
									{@render subHead('settings-level', `Level ${q.level}, the level you are studying`, q.segment_chain ? null : SECTION.level)}
									<QuizOptionsForm
										bind:options={quizOptions}
										idPrefix="quiz-"
										questionCount={q.question_count}
										maxQuizQuestions={maxQuiz}
										segmentChain={q.segment_chain}
										source={q.origin === 'source'}
										showAlphabetical={c.quiz_type === 'anagram'}
										onchange={saveQuizOptions}
									/>
									{#if levelSaved}
										{#key levelSaved}
											<p class="text-right text-xs text-green-700 dark:text-green-500" role="status" data-level-saved>✓ Saved for this level</p>
										{/key}
									{/if}
								</div>
							{/if}
							{#if cascadeOptions}
								<div class="space-y-3" role="group" aria-labelledby="settings-new-levels">
									{@render subHead(
										'settings-new-levels',
										'Levels made from now on',
										SECTION.new_levels
									)}
									<QuizOptionsForm
										bind:options={cascadeOptions}
										idPrefix="cascade-"
										questionCount={c.question_count}
										maxQuizQuestions={maxQuiz}
										showAlphabetical={c.quiz_type === 'anagram'}
										onchange={saveCascadeOptions}
									/>
									{@render widen('levels')}
								</div>
							{/if}
						{/key}
						{#if sources.length}
							<div class="space-y-3" role="group" aria-labelledby="settings-copy">
								{@render subHead(
									'settings-copy',
									'Copy another cascade’s settings',
									SECTION.copy
								)}
								<div class="flex flex-wrap items-center justify-end gap-2 text-sm">
									<label for="copy-from" class="sr-only">Cascade to copy from</label>
									<select id="copy-from" class="max-w-full min-w-0 flex-1 rounded border bg-background px-2 py-1 sm:max-w-xs" bind:value={copyFrom}>
										<option value="" disabled>Choose a cascade</option>
										{#each sources as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
									</select>
									<Button size="sm" variant="outline" disabled={!copyFrom} onclick={copySettingsFrom}>Copy settings</Button>
								</div>
								{#if copied}<p class="text-right text-xs text-green-700 dark:text-green-500" role="status" data-copied>✓ {copied}</p>{/if}
							</div>
						{/if}
						{#if cascadeError}<p class="text-sm text-destructive" role="alert">{cascadeError}</p>{/if}
						<div class="flex flex-wrap gap-2 pt-2">
							<Button
								variant="outline"
								disabled={atLimit}
								title={atLimit ? 'Duplicate cascade: your storage is full' : 'A new cascade from the same filters and settings, at Level 1'}
								onclick={duplicate}>Duplicate cascade</Button
							>
							<Button variant="outline" class="hover:text-destructive" onclick={moveToTrash}>Move to Trash</Button>
						</div>
					</section>
				{/if}
				<section class="space-y-4" aria-labelledby="settings-device">
					{@render scopeHead('settings-device', 'Device Settings', SCOPE.device)}
					<DisplaySettings />
					{@render subHead('settings-controls', 'Controls', SECTION.controls)}
					<ControlsEditor />
				</section>
			</div>
		</div>
	</div>
{/if}

{#if v?.completion}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
		<div class="max-w-sm space-y-4 rounded-lg bg-background p-6 text-center" role="dialog" aria-label="Cascade complete">
			<h2 class="text-xl font-semibold">Cascade complete</h2>
			<p>After {v.completion.levels} levels and {v.completion.attempts} {v.completion.attempts === 1 ? 'pass' : 'passes'}.</p>
			<div class="flex flex-col gap-2">
				<Button onclick={startOver}>Start over</Button>
				<Button variant="outline" onclick={moveToTrash}>Move to Trash</Button>
			</div>
		</div>
	</div>
{/if}

{#if starting}
	<CreatingCascade title="Duplicating" stage={starting.stage} progress={starting.progress} count={starting.count} />
{/if}
