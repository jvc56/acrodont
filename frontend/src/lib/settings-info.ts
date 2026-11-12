// What each setting does, written under its name (SettingRow), and where each of the
// two groups of settings applies (PLAN.md § Settings), in one place.

/** Where a group of settings applies, said once above the group in a cascade's Settings. */
export const SCOPE = {
	cascade:
		'Saved with this cascade and synced to your other devices. Your other cascades keep their own: after a change you can use it for every cascade too, or copy all of another cascade’s settings here.',
	device: 'Kept on this device only and not synced, so your other devices keep their own. They apply to every cascade you study here.'
} as const;

export const INFO = {
	// A cascade's settings (synced)
	leave_value_decimals:
		'How many decimal places leave values show, rounded half away from zero: at one place, 1.25 shows as 1.3 and −8.35 as −8.4.',
	show_definitions: 'Shows each anagram’s definition under it when the answer is revealed.',
	show_hooks:
		'Shows the letters that can go before and after each anagram (its hooks), and a dot on a side where removing the end letter still leaves a word (its inner hooks).',
	answer_mode:
		'Flashcard: reveal the answer and grade yourself. Typed (anagram cascades only): type each anagram, then press Enter on an empty box when you are finished; the card is correct only if you found them all and typed nothing else.',
	reveal_correct:
		'The grade a card gets when you reveal its answer, before you toggle it. “Correct” suits studying words you mostly know; “Missed” makes you mark the ones you got.',
	found_count:
		'In typed mode, shows "3 of 9 found" in the status bar. Off by default, since knowing how many anagrams are left is a hint.',
	clear_threshold:
		'The score a pass needs to clear a level of this cascade. A change applies at once, to every level, including the pass you are in.',
	// Quiz options
	segmented:
		'Studies a level a run at a time. After each run, the cards you missed are drilled before the next run starts.',
	segment_size: 'How many cards each run holds.',
	progression:
		'What a pass below the clear threshold does. Ladder keeps the level and sends its misses down to a new level; Drill replaces the level with just its misses until nothing is missed.',
	alphabetical: 'In typed mode, each anagram must be entered after the ones before it in alphabetical order. One typed out of order marks the card missed at once.',
	// This device's display
	font: 'The typeface. Inter is bundled and works offline; the others use what this device has.',
	size: 'The text size in pixels.',
	spacing: 'Extra space between letters, in em (a fraction of the text size). 0 is the font’s normal spacing.',
	question_top: 'How far below the top of the quiz area the question sits.',
	border_correct: 'Draws a green border around the quiz area when a revealed card is marked correct.',
	border_missed: 'Draws a red border around the quiz area when a revealed card is marked missed.',
	border_width: 'How thick the green and red grade borders are, in pixels.',
	status_bar: 'The bar under the quiz with the level, pass, progress, score and sync status. Hiding it leaves the quiz area the same size.',
	mobile_buttons:
		'On a phone or tablet. Columns: Previous, Toggle and Show / Next side by side, each a third of the screen, tapped anywhere in its column. Rows: Previous above the question, the question itself for Show / Next, and Toggle below.',
	repeat_guard:
		'Ignores the same action pressed again within this many milliseconds, to stop an accidental double press from skipping a card. 0 turns it off.',
	// Account
	remove_data:
		'Deletes this account’s copy on this device only. Everything synced stays on the server and downloads again when you log in.'
} as const;
