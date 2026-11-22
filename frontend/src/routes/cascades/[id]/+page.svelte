<script lang="ts">
	// The player for the cascade's deepest level (PLAN.md § Taking a quiz):
	// for a fine pointer at least 900 px wide, a hideable menu on the left, the
	// quiz area with the question at the top, and a status bar along the bottom;
	// tap zones otherwise. The three actions from mouse, wheel, keys and taps;
	// typed mode; the Settings dialog, which holds every setting there is: this
	// cascade's rules (synced; a change offers to be used for every cascade too),
	// its presets (applied, or saved from this cascade), then the answer, display
	// and control settings, each this cascade's on this device, a change offering
	// to be made more widely (lib/settings/layers);
	// banners, the completion screen, and a trashed cascade's Restore.
	import { INFO, SCOPE, SECTION } from '$lib/settings-info';
	import { onMount, untrack } from 'svelte';
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
	import { stackWhenTooWide } from '$lib/components/player/stack-when-too-wide';
	import ApplyWider from '$lib/components/settings/ApplyWider.svelte';
	import ControlsEditor from '$lib/components/settings/ControlsEditor.svelte';
	import CreatingCascade from '$lib/components/CreatingCascade.svelte';
	import SettingRow from '$lib/components/SettingRow.svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import { Button } from '$lib/components/ui/button';
	import { textStyle } from '$lib/player/display';
	import { settings } from '$lib/settings/store.svelte';
	import { SETTING_KEYS, type SettingKey } from '$lib/settings/layers';
	import AnswerSettings from '$lib/components/settings/AnswerSettings.svelte';
	import { applyOrRefuse, CHANGE_REFUSED, optsOf, type NewOp } from '$lib/local/apply';
	import { storeCreated, storeRenamed, type Created } from '$lib/local/created';
	import type { UserDb } from '$lib/local/db';
	import { getMeta, recordOpen } from '$lib/local/meta';
	import { DEFAULT_STORAGE_LIMIT, formatBytes } from '$lib/cascades/storage';
	import { applyToAll, reachable, rulesToApply, type CascadeSettings, type Widening } from '$lib/settings/cascade';
	import { presetFailure, presetNameError } from '$lib/settings/preset-actions';
	import {
		deletePreset,
		isDefaults,
		presetFrom,
		presetList,
		renamePreset,
		savePreset,
		type Preset
	} from '$lib/settings/presets';
	import ScopeOffer from '$lib/components/settings/ScopeOffer.svelte';
	import { userDb } from '$lib/local/open';
	import type { AttemptRow, CascadeRow } from '$lib/local/rows';
	import type { RwTx } from '$lib/local/view';
	import { PLAYER_LOCK } from '$lib/sync/downloads';
	import { afterLocalWrite, downloadInBackground, ensureCascade, fetchAhead, fetchCard, fetchDistribution, playerActs, sendPending, syncState } from '$lib/sync/runtime.svelte';
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
	/** A mouse or trackpad, and the window's width: with the buttons setting, they choose the layout. */
	let pointerFine = $state(true);
	let windowWidth = $state(1280);
	let landscape = $state(false);
	let settingsOpen = $state(false);
	/** The Name field's answer: an error under it, or that the rename was saved. */
	let nameError = $state<string | null>(null);
	let nameSaved = $state(false);
	let typedText = $state('');
	let typedInput = $state<HTMLInputElement | null>(null);
	let typedFocused = $state(false);
	/** The last entry was wrong: the input shows red until the next keystroke. */
	let typedWrong = $state(false);
	/** The last entry the card took (an anagram of the question), shown under the input: green if right, red if wrong. */
	let lastEntry = $state<{ text: string; correct: boolean } | null>(null);
	/** Typed mode: the answer found most recently on this card, as the answer list spells it. */
	let lastFound = $state<string | null>(null);
	/** The scrolling quiz area, and the answer inside it that shrinks to fit it. */
	let fitArea = $state<HTMLElement | null>(null);
	let answerBox = $state<HTMLElement | null>(null);
	let maxQuiz = $state(300_000);

	// The repeat guard is a setting (repeat_guard_ms), read on every press.
	const actions = new Debounce(() => settings.value.repeat_guard_ms);
	const wheel = new Debounce(150);

	let rows = $derived<LevelRow[]>(v?.cascade ? levelRows(optsOf(v.cascade), v.quizzes, v.cascade.depth, attempts) : []);
	/** The quiz the status bar's Level row describes: the one played, or the segmented level whose segment it drills. */
	let levelQuiz = $derived(v?.bar?.level ?? v?.quiz ?? null);
	/** The Segment row, on a level studied in segments (PLAN.md § Desktop layout). */
	let segment = $derived(v?.bar?.segment ?? null);
	/** The position the Level row shows: the card shown, or the waiting level's cursor while its segment is drilled. */
	let levelPos = $derived(!levelQuiz ? 0 : v?.bar && !v.bar.played ? levelQuiz.cursor : (v?.card?.pos ?? levelQuiz.cursor));
	/** Every setting's value for this cascade on this device, from whichever place holds it. */
	let dsp = $derived(settings.value);
	/**
	 * The desktop layout, or the touch layout with its Previous, Toggle and
	 * Show / Next buttons: those on a touch screen, in a window narrower than
	 * the setting's width, or always, as the player_buttons setting asks.
	 */
	let desktop = $derived(dsp.player_buttons !== 'always' && pointerFine && windowWidth >= dsp.buttons_below_px);
/** Typed mode's "3 of 9 found", when the cascade's setting asks for it and the card is still being typed. */
	let foundCount = $derived.by(() => {
		const card = v?.card;
		if (!dsp.show_found_count || !card?.typed || card.revealed || !player) return null;
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
	let onTrack = $derived(
		correctPct === null || !v?.cascade || !levelQuiz
			? null
			: // Compared exactly, as a finish compares it: 57 of 100 at a threshold of 57 is on track.
				levelQuiz.correct_count * 100 >= v.cascade.clear_threshold * (levelQuiz.correct_count + levelQuiz.missed_count)
	);
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
	// A change of layout (a resize, the buttons setting) hides it too: the desktop's
	// panel would come back as a phone's sheet over the quiz.
	$effect(() => {
		void desktop;
		untrack(() => (menuOpen = false));
	});
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
	/** The presets to apply (Defaults first), the one chosen, and what applying it did. */
	let presets = $state<Preset[]>([]);
	let presetId = $state('');
	let applied = $state<string | null>(null);
	/** Save as preset: the name typed, and what saving, renaming or deleting one said. */
	let presetName = $state('');
	let presetSaved = $state<string | null>(null);
	let presetError = $state<string | null>(null);
	let presetBusy = $state(false);
	/** The preset being renamed, and its new name. */
	let renaming = $state<string | null>(null);
	let renameTo = $state('');
	/** Bumped when a preset changes the options under the forms, so they show the new ones. */
	let formKey = $state(0);

	async function refreshSide() {
		if (!db) return;
		attempts = await db.getAllFromIndex('quiz_attempts', 'cascade_id', id);
	}

	onMount(() => {
		const fine = matchMedia('(pointer: fine)');
		const land = matchMedia('(orientation: landscape)');
		const layout = () => {
			pointerFine = fine.matches;
			windowWidth = window.innerWidth;
			landscape = land.matches;
		};
		layout();
		fine.addEventListener('change', layout);
		land.addEventListener('change', layout);
		window.addEventListener('resize', layout);
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
			// Every scope's changes for this cascade; its own come with its row (setCascade below).
			await settings.open(d, { id, settings: {}, created_at: '' }, {
				writeCascade: (values, at) => write({ type: 'set_cascade_settings', cascade_id: id, settings: values }, at),
				afterChange: settingsChanged
			});
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
				// Read as a card is shown, which can be before the effect below has passed the
				// cascade's row to the settings: its own settings are taken from the player first.
				answer: () => {
					settings.setCascade(p.v.cascade);
					return {
						answer_mode: settings.value.answer_mode,
						reveal_correct: settings.value.reveal_correct,
						require_alphabetical: settings.value.require_alphabetical
					};
				},
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
			window.removeEventListener('resize', layout);
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
		// Every action but a Toggle of a shown answer leaves the card, or shows its answer.
		if (a !== 'toggle_grade' || !card?.revealed) {
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
		const a = actionFor(dsp.bindings, keyStroke(e));
		if (!a) return;
		e.preventDefault();
		// A key held down is one press: its repeats would show and grade cards unseen.
		if (e.repeat) return;
		void act(a);
	}

	/**
	 * A mouse button acts as it goes down, as a key does, not when it comes back
	 * up: a click's answer is not held for the length of the click.
	 */
	function onMouse(e: MouseEvent) {
		// Middle-click autoscroll and paste are off everywhere in the quiz area.
		if (e.button === 1) e.preventDefault();
		if ((e.target as HTMLElement).closest('input,button,a')) return;
		// A press on the scrollbar of an answer too long to fit scrolls it.
		if (fitArea && e.target === fitArea && e.offsetX >= fitArea.clientWidth) return;
		const s = mouseStroke(e);
		if (!s) return;
		e.preventDefault();
		const a = actionFor(dsp.bindings, s);
		if (!a) return;
		// Before the reveal, Show / Next from the mouse only focuses the typed input,
		// even while it has the focus: a click never gives a typed card up.
		const card = v?.card;
		if (a === 'show_next' && card?.typed && !card.revealed) {
			typedInput?.focus();
			return;
		}
		void act(a);
	}

	function onWheel(e: WheelEvent) {
		const s = wheelStroke(e);
		if (!s) return;
		const a = actionFor(dsp.bindings, s);
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
		lastFound = null;
	});

	async function onTypedKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !player) return;
		e.preventDefault();
		// A key held down is one press: the repeat would arrive with the input
		// just cleared, and an empty entry gives the card up.
		if (e.repeat) return;
		const text = typedText;
		const r = await player.enter(text);
		// A word that is not an anagram of the question stays in the input to fix; everything else clears it.
		if (r && r.kind !== 'not_anagram') typedText = '';
		typedWrong = r?.kind === 'wrong';
		// The word found by this entry is the green one among the found words.
		if (r?.kind === 'found' || r?.kind === 'out_of_order') lastFound = r.word;
		// An anagram of the question is taken, right or wrong, and shown under the input.
		if (r?.kind === 'found' || r?.kind === 'already' || r?.kind === 'wrong') {
			lastEntry = { text: text.trim().toUpperCase(), correct: r.kind !== 'wrong' };
		}
	}

	/**
	 * One change made from this page. False when the rules refused it (the page
	 * was showing what another tab or a sync has since changed): the page says
	 * so and reads again, so what it shows is true before the next press.
	 */
	async function write(op: NewOp, at?: Date): Promise<boolean> {
		if (!db) return false;
		const done = await applyOrRefuse(db, op, at ? () => at : undefined);
		if (done) afterLocalWrite();
		else cascadeError = CHANGE_REFUSED;
		await refreshSide();
		await player?.load(true);
		return done !== null;
	}

	/**
	 * Changes this cascade's rules, for it alone, then offers to use the same
	 * values for every cascade (§ Settings → A cascade's rules). `key` names the
	 * offer: the threshold, or the quiz options, which every level reads.
	 */
	async function setCascade(fields: CascadeSettings, key: string = Object.keys(fields)[0]) {
		const c = v?.cascade;
		if (!c || !Object.keys(fields).length) return;
		if (!(await write({ type: 'set_cascade_options', cascade_id: c.id, ...fields } as NewOp))) return;
		await offer(key, fields);
	}

	/** The cascade's own settings as the player now has them: a sync or another tab may have changed them. */
	$effect(() => settings.setCascade(v?.cascade ?? null));

	/**
	 * After a setting changed in any scope (§ Settings → Where a setting
	 * applies): the change syncs if it is for all devices, and
	 * the player shows it. Definitions, hooks or probability orders change what
	 * an answer holds: the cards in memory go, and a download pass fetches the
	 * extras the cards lack. A new answer mode resets the card's typed entries.
	 */
	async function settingsChanged(keys: SettingKey[]) {
		afterLocalWrite();
		if (keys.some((k) => k === 'show_definitions' || k === 'show_hooks' || k === 'show_probability')) {
			player?.settingsChanged();
			downloadInBackground();
		}
		if (keys.includes('answer_mode')) await player?.modeChanged();
	}

	/** Settings: what is read fresh each time it opens, then the dialog. */
	async function openSettings() {
		const c = v?.cascade;
		cascadeOptions = c ? { segment_size: clampPrefill(c.segment_size, maxQuiz), progression: c.progression } : null;
		cascadeError = null;
		offers = {};
		settings.resetOffers();
		applied = null;
		presetId = '';
		presetName = '';
		presetSaved = null;
		presetError = null;
		renaming = null;
		if (db) {
			// Duplicate makes a new cascade, which needs room; the server checks the exact figure.
			const server = await getMeta(db, 'server');
			atLimit = (server.storage_bytes ?? 0) >= (server.max_storage_bytes ?? DEFAULT_STORAGE_LIMIT);
			settings.reach = (await reachable(db)).length;
			presets = await presetList(db);
		}
		settingsOpen = true;
	}

	/** The cascade's quiz options, which every level reads, the one in progress included: saved as soon as one is changed. */
	async function saveCascadeOptions(o: QuizOptions) {
		const c = v?.cascade;
		if (!c) return;
		const fields: CascadeSettings = {};
		if (o.segment_size !== c.segment_size) fields.segment_size = o.segment_size;
		if (o.progression !== c.progression) fields.progression = o.progression;
		await setCascade(fields, 'levels');
	}

	/** After a change to this cascade alone, the offer to use it for every cascade. */
	async function offer(key: string, fields: CascadeSettings) {
		if (!db || !Object.keys(fields).length) return;
		const reach = (await reachable(db)).length;
		offers = { ...offers, [key]: { fields, reach, serial: ++offerSerial } };
	}

	/** "all 12 cascades", when there are others. */
	function widenings(o: Offer): Widening[] {
		const d = db;
		if (!d || o.reach < 2) return [];
		return [
			{
				key: 'all',
				label: `all ${o.reach} cascades`,
				done: `Used for all ${o.reach} cascades`,
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

	/**
	 * Applies the preset chosen (§ Settings → Presets): its settings for this
	 * cascade on this device, with the offer to make them more widely, and its
	 * rules for this cascade, with the offer to use them for every cascade.
	 */
	async function applyPreset() {
		const c = v?.cascade;
		const p = presets.find((o) => o.id === presetId);
		if (!db || !c || !p) return;
		applied = null;
		player?.settingsChanged();
		const values = Object.fromEntries(SETTING_KEYS.map((k) => [k, p.settings[k] ?? null]));
		let n = await settings.applyValues('preset', values);
		const rules = rulesToApply(c, p);
		if (Object.keys(rules).length) {
			if (!(await write({ type: 'set_cascade_options', cascade_id: c.id, ...rules } as NewOp))) return;
			n += Object.keys(rules).length;
			await offer('preset-rules', rules);
		}
		// The card may now be typed or hold more.
		await player?.modeChanged();
		// The forms show what the cascade has now.
		cascadeOptions = v?.cascade
			? { segment_size: clampPrefill(v.cascade.segment_size, maxQuiz), progression: v.cascade.progression }
			: cascadeOptions;
		formKey++;
		applied = n ? `Applied “${p.name}”: ${n} setting${n === 1 ? '' : 's'} changed.` : `This cascade already matches “${p.name}”.`;
	}

	/**
	 * Save as preset: every setting as this cascade shows it on this device, and
	 * its rules. Under the name typed, or over `over`, one of the user's
	 * presets chosen from the list; a name already taken, or a preset
	 * overwritten, asks first, then replaces that preset.
	 */
	async function saveAsPreset(over: Preset | null = null) {
		const c = v?.cascade;
		if (!db || !c || presetBusy) return;
		const name = over ? over.name : presetName.trim();
		presetSaved = null;
		presetError = over ? null : presetNameError(name, null, presets);
		if (presetError) return;
		if (!navigator.onLine) {
			presetError = 'Saving a preset needs a connection.';
			return;
		}
		const same = over ?? presets.find((o) => !isDefaults(o) && o.name === name);
		if (same) {
			const ok = await confirmAction({
				title: `Replace your preset “${name}”?`,
				body: 'It will hold this cascade’s settings as they are on this device, and its rules. Cascades made with it keep their settings.',
				action: 'Replace'
			});
			if (!ok) return;
		}
		presetBusy = true;
		try {
			await savePreset(db, presetFrom(same?.id ?? crypto.randomUUID(), name, settings.value, c));
			presets = await presetList(db);
			presetSaved = same ? `Replaced “${name}”.` : `Saved “${name}”.`;
			if (!over) presetName = '';
			afterLocalWrite();
		} catch (e) {
			presetError = presetFailure(e, 'Saving a preset', 'saved');
		} finally {
			presetBusy = false;
		}
	}

	async function renameThePreset(p: Preset) {
		if (!db || presetBusy) return;
		const name = renameTo.trim();
		presetSaved = null;
		if (name === p.name) {
			renaming = null;
			return;
		}
		presetError = presetNameError(name, p.id, presets);
		if (presetError) return;
		if (!navigator.onLine) {
			presetError = 'Renaming a preset needs a connection.';
			return;
		}
		presetBusy = true;
		try {
			await renamePreset(db, p.id, name);
			presets = await presetList(db);
			presetSaved = `Renamed “${p.name}” to “${name}”.`;
			renaming = null;
			afterLocalWrite();
		} catch (e) {
			presetError = presetFailure(e, 'Renaming a preset', 'renamed');
		} finally {
			presetBusy = false;
		}
	}

	async function removePreset(p: Preset) {
		if (!db || presetBusy) return;
		presetSaved = null;
		presetError = null;
		const ok = await confirmAction({
			title: `Delete the preset “${p.name}”?`,
			body: 'Cascades made with it, or that it was applied to, keep their settings.',
			action: 'Delete'
		});
		if (!ok) return;
		if (!navigator.onLine) {
			presetError = 'Deleting a preset needs a connection.';
			return;
		}
		presetBusy = true;
		try {
			await deletePreset(db, p.id);
			presets = await presetList(db);
			if (presetId === p.id) presetId = '';
			presetSaved = `Deleted “${p.name}”.`;
			afterLocalWrite();
		} catch (e) {
			presetError = presetFailure(e, 'Deleting a preset', 'deleted');
		} finally {
			presetBusy = false;
		}
	}

	async function restore() {
		cascadeError = null;
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
		if (await write({ type: 'trash_cascade', cascade_id: id })) await goto('/');
	}

	let starting = $state<{ stage: 'server' | 'device'; progress: number; count: number | null } | null>(null);

	/** Settings → Duplicate cascade: a new cascade from the same filters and settings, at Level 1. */
	/**
	 * Renames this cascade (§ Settings → Name). Online only: the server checks
	 * the name against the account's other cascades at once, then this device
	 * shows it everywhere, and the others pull it at their next sync.
	 */
	async function rename(input: HTMLInputElement) {
		const c = v?.cascade;
		if (!db || !c) return;
		const name = input.value.trim();
		nameError = null;
		nameSaved = false;
		if (name === c.name) {
			input.value = c.name;
			return;
		}
		if (!name) {
			nameError = 'A cascade needs a name.';
			input.value = c.name;
			return;
		}
		if (!navigator.onLine) {
			nameError = 'Renaming a cascade needs a connection.';
			return;
		}
		try {
			const { device_id } = await getMeta(db, 'device');
			// The same name sent again is answered the same, so a retry is safe.
			const r = await sendWithRetry(() =>
				api.post<{ cascade: { name: string } }>(`/api/cascades/${id}/name`, { name, device_id })
			);
			await storeRenamed(db, id, r.cascade.name);
			input.value = r.cascade.name;
			nameSaved = true;
			afterLocalWrite();
			await player?.load(true);
		} catch (e) {
			const field = e instanceof ApiError ? e.fieldErrors.find((f) => f.field === 'name') : undefined;
			if (field) nameError = field.message;
			else if (isRetriable(e)) nameError = 'Renaming a cascade needs a connection.';
			else nameError = 'The cascade could not be renamed. Try again.';
		}
	}

	async function duplicate() {
		if (!db || !session.userId) return;
		const ok = await confirmAction({
			title: `Duplicate “${v?.cascade?.name ?? 'this cascade'}”?`,
			body: `This makes a new cascade from the same filters, with the same threshold and options, starting at Level 1. It takes this cascade’s name with the next free number after it. This cascade isn’t changed. You’ll have both, and each counts toward your storage until it is deleted from the Trash.`,
			action: 'Duplicate'
		});
		if (!ok) return;
		const { device_id } = await getMeta(db, 'device');
		// The copy starts with this cascade's settings as they are on this device, on every device.
		const shown = Object.fromEntries(SETTING_KEYS.map((k) => [k, settings.value[k]]));
		const body = { id: crypto.randomUUID(), source_quiz_id: crypto.randomUUID(), device_id, at: new Date().toISOString(), settings: shown };
		cascadeError = null;
		if (!navigator.onLine) {
			cascadeError = 'Duplicating a cascade needs a connection.';
			return;
		}
		starting = { stage: 'server', progress: 0, count: null };
		try {
			// The server copies the rules it holds: one changed here and not yet
			// sent is sent first, and waited for a few seconds.
			await sendPending(db, id);
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
				// Refused before the search ran (the account is already full), the server knows no size to name.
				cascadeError =
					b.needed > 0
						? `Duplicating needs about ${formatBytes(b.needed)}, and ${formatBytes(Math.max(0, b.limit - b.used))} of your storage is free. Empty the Trash or delete cascades to make room.`
						: `Your storage is full: ${formatBytes(b.used)} of ${formatBytes(b.limit)} is used. Empty the Trash or delete cascades to make room.`;
			} else if (e instanceof ApiError && e.code === 'empty') {
				// The search is run again, on today's catalog: trying again finds the same.
				cascadeError = 'This cascade’s search matches nothing now, so there is nothing to duplicate.';
			} else if (e instanceof ApiError && e.code === 'over_cap') {
				cascadeError = `This cascade’s search now matches ${(e.body as { count: number }).count.toLocaleString()} questions, more than a cascade may hold.`;
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
			{@const hooked = v.cascade?.quiz_type === 'definition' && dsp.hooks_on_question ? card.word : null}
			{#if hooked}
				<!-- A Definition card shows its word once (hooks_on_question): here, with its hooks and
				     inner hooks once the answer is shown. The dots' places are kept before then and the
				     hooks sit either side, so the reveal never moves the word. -->
				<div
					class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 font-semibold"
					style={textStyle(dsp.question_font, dsp.question_size_px, dsp.question_spacing)}
					data-question
				>
					<span class="justify-self-end font-normal text-muted-foreground" style={`font-size: ${dsp.hook_size_px}px;`} data-hooks="front">
						{#if card.revealed}<TileText text={hooked.front_hooks} lower />{/if}
					</span>
					<span class="whitespace-nowrap">
						<span class:invisible={!(card.revealed && hooked.front_inner)} aria-hidden={!(card.revealed && hooked.front_inner)}>·</span><TileText
							text={card.key}
						/><span class:invisible={!(card.revealed && hooked.back_inner)} aria-hidden={!(card.revealed && hooked.back_inner)}>·</span>
					</span>
					<span class="justify-self-start font-normal text-muted-foreground" style={`font-size: ${dsp.hook_size_px}px;`} data-hooks="back">
						{#if card.revealed}<TileText text={hooked.back_hooks} lower />{/if}
					</span>
				</div>
			{:else}
				<div class="text-center font-semibold" style={textStyle(dsp.question_font, dsp.question_size_px, dsp.question_spacing)} data-question><TileText text={card.key} /></div>
			{/if}
			<!-- The answer space: typed words as they are found, bare, then the whole answer on the reveal. -->
			<div class="mt-6" bind:this={answerBox}>
				{#if card.revealed}
					{#if card.answer === null}
						<p class="text-center text-muted-foreground">Answer needs a connection.</p>
					{:else}
						<AnswerView
							quizType={v.cascade!.quiz_type}
							answer={card.answer}
							settings={dsp}
							found={card.typed?.found ?? null}
							font={dsp.answer_font}
							size={dsp.answer_size_px}
							spacing={dsp.answer_spacing}
							definition={{ font: dsp.definition_font, size: dsp.definition_size_px, spacing: dsp.definition_spacing }}
							definitionWidth={dsp.definition_width_px}
							hookSize={dsp.hook_size_px}
							word={hooked ? null : card.word}
						/>
					{/if}
				{:else if card.typed}
					<AnswerView
						quizType={v.cascade!.quiz_type}
						answer={card.answer}
						settings={dsp}
						typing={card.typed.found}
						entered={lastFound}
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
		{#if cascadeError}<p class="mt-2 text-sm text-destructive" role="alert">{cascadeError}</p>{/if}
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
				<!-- The on-screen keyboard covers the zones: two buttons sit above it. There is no
				     Toggle: the bar is gone once the answer is shown, and before that Show / Next
				     already gives the card up. -->
				<div class="mb-2 flex justify-around" data-typed-actions>
					<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('previous')}>Previous</Button>
					<Button variant="outline" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => act('show_next')}>Show / Next</Button>
				</div>
			{/if}
			<div class="mx-auto max-w-sm space-y-1">
				{#if dsp.require_alphabetical && typed.found.length}
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
					onclick={() => settings.change('status_bar_hidden', false)}
					aria-label="Show status bar"
					title="Show status bar"><PanelBottomOpenIcon class="size-4" /></button
				>
			{:else}
				<button
					class="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					onclick={() => settings.change('status_bar_hidden', true)}
					aria-label="Hide status bar"
					title="Hide status bar"><PanelBottomCloseIcon class="size-4" /></button
				>
			{/if}
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 leading-7 max-sm:gap-x-3">
				{#if !dsp.status_bar_hidden && v?.quiz && v.cascade && levelQuiz}
					{#snippet levelRow(cell: string)}
						<!-- On a phone the pass joins the row's name, which takes a line of its own, and
						     the figures share the line under it (PLAN.md § Desktop layout). -->
						<p class="font-medium max-sm:basis-full {cell}" data-status-row="level">
							Level {levelQuiz.level} of {v!.cascade!.depth}<span class="font-normal text-muted-foreground sm:hidden">{' · '}Pass {levelQuiz.attempt}</span>
						</p>
						<p class="text-muted-foreground max-sm:hidden {cell ? 'whitespace-nowrap' : ''}">Pass {levelQuiz.attempt}</p>
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
						     the same columns so the two read against each other. On a phone each row's name,
						     with its pass, takes a line of its own, and the position and grades share the line
						     under it, or stack when they are too wide to (stackWhenTooWide). A drill of the
						     segment's misses is the segment's next pass: the Level row stays on the level. -->
						<div
							class="grid grid-cols-[auto_auto] justify-start gap-x-3 tabular-nums max-sm:data-stacked:grid-cols-[auto] sm:grid-cols-[auto_auto_auto_auto] sm:gap-x-5"
							data-status-rows
							{@attach stackWhenTooWide}
						>
							{@render levelRow('max-sm:col-span-full whitespace-nowrap')}
							<p class="font-medium whitespace-nowrap max-sm:col-span-full" data-status-row="segment">
								Segment {segment.segment} of {segment.total}<span class="font-normal text-muted-foreground sm:hidden">{' · '}Pass {segment.pass}</span>
							</p>
							<p class="whitespace-nowrap text-muted-foreground max-sm:hidden" title="1 is the segment itself; each drill of its misses is the next pass">
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
				<!-- At the bar's foot when the figures take several lines, not halfway up them. -->
				<div class="ml-auto self-end"><SyncStatus quiet={dsp.status_bar_hidden || dsp.sync_status_hidden} /></div>
			</div>
		</div>
	</footer>
{/snippet}

{#snippet phoneBanner()}
	<!-- On a phone the banner follows the question in the page, so it never covers it, however
	     tall the banner or short the screen. Show clears it, and the answer takes its place. -->
	{#if v?.banner}<p class="mx-auto mt-4 max-w-[90%] rounded-md bg-muted px-3 py-2 text-center text-sm" role="status">{v.banner}</p>{/if}
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
				onmousedown={onMouse}
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
	     desktop. The three actions are tap zones (the mobile_buttons setting): by default three
	     columns, Previous, Toggle and Show / Next, each tapped anywhere in its third of the quiz
	     area, with its label at the bottom; or the question, then three rows of buttons
	     under it, Previous, Toggle and Show / Next, the last nearest the thumb. ☰ opens
	     the menu, Settings with it. -->
	<div class="flex h-dvh flex-col">
		{#if v?.status === 'ready'}
			{#if dsp.mobile_buttons === 'rows'}
				<div class="relative flex min-h-0 flex-1 select-none" class:flex-col={!landscape} style="touch-action: manipulation">
					{@render showMenu('absolute top-1 left-1')}
					<div
						bind:this={fitArea}
						data-fit-area
						class="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 {gradeBorder}"
						style={`padding-top: ${Math.max(dsp.question_top_px, 40)}px; border-width: ${dsp.border_px}px; border-style: solid;`}
						data-grade={gradeState ?? undefined}
					>
						{@render question()}
						{@render phoneBanner()}
					</div>
					<!-- Show / Next at the bottom, nearest the thumb; in landscape the rows stand at
					     the bottom of a column on the right. Each row is mobile_row_px tall. -->
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
						{@render phoneBanner()}
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
	<!-- Each section opens with a bar of its own, so they read as separate. -->
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
		<!-- Every setting there is, in one place: this cascade's rules, which are
		     always its own, and its presets, then the answer, display and control
		     settings, each saved for this cascade on this device, with an offer to
		     make the change more widely (§ Settings → Where a setting applies).
		     Each setting is saved as soon as it is changed. -->
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
				<p class="pt-4 text-sm text-muted-foreground" data-places-intro>{SCOPE.places}</p>
				{#if v?.cascade && v.quiz}
					{@const c = v.cascade}
					<section class="space-y-4" aria-labelledby="settings-cascade">
						{@render scopeHead('settings-cascade', 'This Cascade', SCOPE.cascade)}
						<SettingRow label="Name" info={INFO.cascade_name} for="cascade-name">
							<input
								id="cascade-name"
								class="w-72 max-w-full rounded-md border bg-background px-2 py-1"
								type="text"
								maxlength="200"
								value={c.name}
								aria-invalid={nameError ? 'true' : undefined}
								oninput={() => {
									nameError = null;
									nameSaved = false;
								}}
								onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
								onchange={(e) => rename(e.currentTarget)}
							/>
						</SettingRow>
						{#if nameError}<p class="text-sm text-destructive" role="alert">{nameError}</p>{/if}
						{#if nameSaved}<p class="text-sm text-muted-foreground" role="status">✓ Renamed</p>{/if}
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
						{#key formKey}
							{#if cascadeOptions}
								<QuizOptionsForm
									bind:options={cascadeOptions}
									idPrefix="cascade-"
									questionCount={c.question_count}
									maxQuizQuestions={maxQuiz}
									onchange={saveCascadeOptions}
								/>
								{@render widen('levels')}
							{/if}
						{/key}
						<div class="space-y-3" role="group" aria-labelledby="settings-presets" data-presets>
							{@render subHead('settings-presets', 'Presets', SECTION.presets)}
							<div class="flex flex-wrap items-center justify-end gap-2 text-sm">
								<label for="preset-apply" class="sr-only">Preset to apply</label>
								<select id="preset-apply" class="max-w-full min-w-0 flex-1 rounded border bg-background px-2 py-1 sm:max-w-xs" bind:value={presetId}>
									<option value="" disabled>Choose a preset</option>
									{#each presets as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
								</select>
								<Button size="sm" variant="outline" disabled={!presetId} onclick={applyPreset}>Apply preset</Button>
							</div>
							{#if applied}<p class="text-right text-xs text-green-700 dark:text-green-500" role="status" data-applied>✓ {applied}</p>{/if}
							<ScopeOffer id="preset" saved="Its settings saved for this cascade on this device" />
							{@render widen('preset-rules')}
							<div class="flex flex-wrap items-center justify-end gap-2 text-sm">
								<label for="preset-name" class="sr-only">New preset’s name</label>
								<input
									id="preset-name"
									class="max-w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1 sm:max-w-xs"
									type="text"
									maxlength="100"
									placeholder="Preset name"
									bind:value={presetName}
									oninput={() => (presetError = null)}
									onkeydown={(e) => e.key === 'Enter' && saveAsPreset()}
								/>
								<Button size="sm" variant="outline" disabled={!presetName.trim() || presetBusy} onclick={() => saveAsPreset()}>Save as preset</Button>
							</div>
							{#if presets.some((o) => !isDefaults(o))}
								<ul class="space-y-1 text-sm" data-preset-list>
									{#each presets.filter((o) => !isDefaults(o)) as o (o.id)}
										<li class="flex flex-wrap items-center justify-end gap-2" data-preset={o.name}>
											{#if renaming === o.id}
												<label for="preset-rename" class="sr-only">New name for “{o.name}”</label>
												<input
													id="preset-rename"
													class="max-w-full min-w-0 flex-1 rounded-md border bg-background px-2 py-1 sm:max-w-xs"
													type="text"
													maxlength="100"
													bind:value={renameTo}
													onkeydown={(e) => {
														if (e.key === 'Enter') void renameThePreset(o);
														if (e.key === 'Escape') {
															e.stopPropagation();
															renaming = null;
														}
													}}
													{@attach (el: HTMLInputElement) => el.focus()}
												/>
												<Button size="sm" variant="outline" disabled={presetBusy} onclick={() => renameThePreset(o)}>Save name</Button>
												<Button size="sm" variant="ghost" onclick={() => (renaming = null)}>Cancel</Button>
											{:else}
												<span class="min-w-0 flex-1 truncate">{o.name}</span>
												<Button size="sm" variant="ghost" href={`/presets/${o.id}`} aria-label={`Edit “${o.name}”`}>Edit</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={presetBusy}
													title="Save this cascade’s settings and rules into this preset"
													aria-label={`Overwrite “${o.name}” with this cascade’s settings`}
													onclick={() => saveAsPreset(o)}>Overwrite</Button
												>
												<Button
													size="sm"
													variant="ghost"
													aria-label={`Rename “${o.name}”`}
													onclick={() => {
														renaming = o.id;
														renameTo = o.name;
														presetError = null;
													}}>Rename</Button
												>
												<Button size="sm" variant="ghost" class="hover:text-destructive" aria-label={`Delete “${o.name}”`} onclick={() => removePreset(o)}>Delete</Button>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
							{#if presetError}<p class="text-right text-sm text-destructive" role="alert">{presetError}</p>{/if}
							{#if presetSaved}<p class="text-right text-xs text-green-700 dark:text-green-500" role="status" data-preset-saved>✓ {presetSaved}</p>{/if}
						</div>
						{#if cascadeError}<p class="text-sm text-destructive" role="alert">{cascadeError}</p>{/if}
						<div class="flex flex-wrap gap-2 pt-2">
							<!-- The title is on a wrapper: a disabled button takes no pointer events, so its own would never show. -->
							<span class="inline-flex" title={atLimit ? 'Duplicate cascade: your storage is full' : 'A new cascade from the same filters and settings, at Level 1'}>
								<Button variant="outline" disabled={atLimit} onclick={duplicate}>Duplicate cascade</Button>
							</span>
							<Button variant="outline" class="hover:text-destructive" onclick={moveToTrash}>Move to Trash</Button>
						</div>
					</section>
				{/if}
				{#if v?.cascade}
					{@const c = v.cascade}
					<section class="space-y-4" aria-labelledby="settings-answers">
						{@render scopeHead('settings-answers', 'Answers', SCOPE.answers)}
						<AnswerSettings quizType={c.quiz_type} />
					</section>
				{/if}
				<section class="space-y-4" aria-labelledby="settings-display">
					{@render scopeHead('settings-display', 'Display', SCOPE.display)}
					<DisplaySettings />
				</section>
				<section class="space-y-4" aria-labelledby="settings-controls">
					{@render scopeHead('settings-controls', 'Controls', SECTION.controls)}
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
			<p>After {v.completion.levels} {v.completion.levels === 1 ? 'level' : 'levels'} and {v.completion.attempts} {v.completion.attempts === 1 ? 'pass' : 'passes'}.</p>
			<div class="flex flex-col gap-2">
				<Button onclick={startOver}>Start over</Button>
				<Button variant="outline" onclick={moveToTrash}>Move to Trash</Button>
			</div>
			{#if cascadeError}<p class="text-sm text-destructive" role="alert">{cascadeError}</p>{/if}
		</div>
	</div>
{/if}

{#if starting}
	<CreatingCascade title="Duplicating" stage={starting.stage} progress={starting.progress} count={starting.count} />
{/if}
