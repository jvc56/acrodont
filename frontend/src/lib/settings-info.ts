// What each setting does, behind an ⓘ beside its name (SettingRow), and where
// settings apply (PLAN.md § Settings → Where a setting applies), in one place.

/** Where settings apply, said once at the top of Settings and beside each group's heading. */
export const SCOPE = {
	places:
		'Under each setting, two switches say where its value applies: this cascade or all cascades, on this device or all devices. A setting not yet changed starts at this cascade on this device; a change is saved where its switches point, and switching one moves the value.',
	cascade:
		'This cascade’s name, and its rules: the clear threshold and the options of its levels. They decide how a pass is judged, so they are the same on every device. After you change one you can optionally use it for every cascade too.',
	answers:
		'What a revealed answer shows and how a reveal grades it. Each can be set for this cascade on this device, this cascade, this device, or everywhere; the first of those that has a value is used.',
	display:
		'How the player looks and responds. Each can be set for this cascade on this device, this cascade, this device, or everywhere; the first of those that has a value is used.'
} as const;

/** What each part of a cascade's Settings is for, behind an ⓘ beside its heading. */
export const SECTION = {
	level: 'These options belong to the level you are studying. Changes apply to this quiz only, from the current card.',
	new_levels: 'Each new level this cascade makes from your misses starts with these. Levels it already has keep their own.',
	copy: 'Gives this cascade the other one’s rules, and the same settings of its own (the ones set for “This cascade”). The level you are studying keeps its own options.',
	controls:
		'The keys, mouse buttons and wheel directions for each action. They are one setting, which can be set for this cascade on this device, this cascade, this device, or everywhere.'
} as const;

export const INFO = {
	// A cascade's rules and answer settings
	leave_value_decimals:
		'How many decimal places leave values show, rounded half away from zero: at one place, 1.25 shows as 1.3 and −8.35 as −8.4.',
	show_definitions: 'Shows each anagram’s definition under it when the answer is revealed.',
	show_hooks:
		'Shows the letters that can go before and after each anagram (its hooks), and a dot on a side where removing the end letter still leaves a word (its inner hooks).',
	answer_mode:
		'Flashcard: reveal the answer and grade yourself. Typed (anagram cascades only): type each anagram, then press Enter on an empty box when you are finished; the card is correct only if you found them all and typed nothing else.',
	reveal_correct:
		'The grade a card gets when you reveal its answer, before you toggle it. “Correct” suits studying words you mostly know; “Missed” makes you mark the ones you got.',
	hooks_on_question:
		'Definition cascades: once the answer is shown, the question (the word) shows its hooks and inner hooks, and the answer is the definition alone, so the word is shown once.',
	show_probability:
		'Shows each word’s probability order to the left of its front hooks: its rank among the lexicon’s words of the same length, 1 being the likeliest to be drawn.',
	definition_column:
		'Puts each word’s definition in a column of its own to the right of its back hooks. Off, the definition is centred under the word. On a narrow screen, such as a phone held upright, it is always under the word.',
	found_count:
		'In typed mode, shows "3 of 9 found" in the status bar. Off by default, since knowing how many anagrams are left is a hint.',
	cascade_name:
		'What this cascade is called, on the Cascades page and everywhere else. Each of your cascades needs its own name, the Trash included. Renaming needs a connection; your other devices show the new name at their next sync.',
	clear_threshold:
		'The score a pass needs to clear a level of this cascade. A change applies at once, to every level, including the pass you are in.',
	// Quiz options
	segmented:
		'Studies a level a segment at a time. After each segment, the cards you missed are drilled before the next segment starts: a segment size of 40 means you study 40 at a time and drill what you missed before going on.',
	segment_size: 'How many cards each segment holds.',
	progression:
		'What a pass below the clear threshold does. Ladder: keep the quiz and go down a level with the misses; come back up to clear it. Drill: replace the quiz with its misses and keep going until nothing is missed.',
	alphabetical: 'In typed mode, each anagram must be entered after the ones before it in alphabetical order. One typed out of order marks the card missed at once.',
	// Display
	font: 'The typeface. Inter is bundled and works offline; the others use what this device has.',
	size: 'The text size in pixels.',
	spacing: 'Extra space between letters, in em (a fraction of the text size). 0 is the font’s normal spacing.',
	question_top: 'How far below the top of the quiz area the question sits.',
	border_correct: 'Draws a green border around the quiz area when a revealed card is marked correct.',
	border_missed: 'Draws a red border around the quiz area when a revealed card is marked missed.',
	border_width: 'How thick the green and red grade borders are, in pixels.',
	status_bar:
		'The bar under the quiz with the level, pass, progress, score and sync status. Hiding it leaves the quiz area the same size, and quiets the sync status too.',
	sync_status:
		'“Synced”, “Syncing…” and “Waiting to sync” at the bottom right of the quiz. Hidden, only what needs your attention still shows there: offline, log in, reload, or no room on this device.',
	definition_width:
		'The widest a definition may be, in pixels, in a column of its own or centred under its word; a longer definition wraps. 0, the default, lets a definition use all the room it has: in its column, all of the page to the right of the back hooks; under its word, the page’s whole width.',
	player_buttons:
		'The Previous, Toggle and Show / Next buttons, and the layout that holds them (the one a phone has). Automatically, they are shown on a touch screen and in a window narrower than the width below; Always shows them at any size, with a mouse too.',
	buttons_below:
		'With the buttons shown automatically: the window width, in pixels, below which they are, whatever the pointer. 900 by default.',
	hook_size: 'The text size of the front and back hooks, and of the probability order, in pixels.',
	mobile_buttons:
		'On a phone or tablet. Columns: Previous, Toggle and Show / Next side by side, each a third of the screen, tapped anywhere in its column. Rows: the question, then Previous, Toggle and Show / Next in rows under it, Show / Next at the bottom, nearest your thumb.',
	mobile_row_px: 'In the rows layout, how tall each of the three rows of buttons is.',
	repeat_guard:
		'Ignores the same action pressed again within this many milliseconds. 0, the default, counts every press; raise it if a bouncing mouse button or an accidental double tap skips cards.',
	// Account
	remove_data:
		'Deletes this account’s copy on this device only. Everything synced stays on the server and downloads again when you log in.'
} as const;
