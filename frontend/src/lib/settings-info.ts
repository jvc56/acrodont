// What each setting does, for the ⓘ beside it (InfoTip). One place, so the
// Account page and the player's dialogs explain a setting the same way.

export const INFO = {
	// Preferences (synced to every device)
	default_clear_threshold:
		'The score a new cascade needs to clear a level, prefilled in the builder. Each cascade keeps its own, which you can change later in its Levels dialog.',
	default_segment_size:
		'Prefills “Study in segments” for new cascades. 0 studies each level in one pass; 40 studies 40 cards at a time and drills each run’s misses before moving on.',
	default_progression:
		'Prefills what a new cascade does with a pass below its clear threshold: Ladder keeps the level and sends the misses down a level; Drill replaces it with just the misses.',
	default_alphabetical:
		'Prefills whether typed answers must be entered in alphabetical order in new cascades.',
	leave_value_decimals:
		'How many decimal places leave values show, rounded half away from zero: at one place, 1.25 shows as 1.3 and −8.35 as −8.4.',
	anagram_show_definitions: 'Shows each anagram’s definition under it when the answer is revealed.',
	anagram_show_hooks:
		'Shows the letters that can go before and after each anagram (its hooks), and a dot on a side where removing the end letter still leaves a word (its inner hooks).',
	anagram_answer_mode:
		'Flashcard: reveal the answer and grade yourself. Typed: type each anagram, and the card is marked from what you found.',
	reveal_correct:
		'The grade a card gets when you reveal its answer, before you toggle it. “Correct” suits studying words you mostly know; “Missed” makes you mark the ones you got.',
	// A cascade
	clear_threshold:
		'The score a pass needs to clear a level of this cascade. A change applies at once, to every level, including the pass you are in.',
	keep_offline:
		'Keeps this cascade’s questions and answers on this device even when you haven’t opened it for a while, so you can study it with no connection.',
	// Quiz options
	segmented:
		'Studies a level a run at a time. After each run, the cards you missed are drilled before the next run starts.',
	segment_size: 'How many cards each run holds.',
	progression:
		'What a pass below the clear threshold does. Ladder keeps the level and sends its misses down to a new level; Drill replaces the level with just its misses until nothing is missed.',
	alphabetical: 'In typed mode, each anagram must be entered after the ones before it in alphabetical order, or it counts as out of order.',
	// This device's display
	font: 'The typeface. Inter is bundled and works offline; the others use what this device has.',
	size: 'The text size in pixels.',
	spacing: 'Extra space between letters, in em (a fraction of the text size). 0 is the font’s normal spacing.',
	question_top: 'How far below the top of the quiz area the question sits.',
	border_correct: 'Draws a green border around the quiz area when a revealed card is marked correct.',
	border_missed: 'Draws a red border around the quiz area when a revealed card is marked missed.',
	border_width: 'How thick the green and red grade borders are, in pixels.',
	status_bar: 'The bar under the quiz with the level, pass, progress, score and sync status. Hiding it leaves the quiz area the same size.',
	repeat_guard:
		'Ignores the same action pressed again within this many milliseconds, to stop an accidental double press from skipping a card. 0 turns it off.',
	// Account
	remove_data:
		'Deletes this account’s copy on this device only. Everything synced stays on the server and downloads again when you log in.'
} as const;
