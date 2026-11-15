// Controls (PLAN.md § Taking a quiz → Controls, Typed mode → Protecting
// typing). Strokes are keys by physical position (`KeyboardEvent.code`),
// mouse buttons or wheel directions, each with an exact set of modifiers.
// Controls are a setting of this device, never synced: what suits a laptop's
// keyboard and mouse is wrong on another machine (lib/player/controls).

export interface Binding {
	action: 'show_next' | 'toggle_grade' | 'previous';
	kind: 'key' | 'mouse_button' | 'wheel';
	code: string;
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	meta: boolean;
}

export type Action = Binding['action'];
export type Stroke = Omit<Binding, 'action'>;

export const ACTIONS: Action[] = ['show_next', 'toggle_grade', 'previous'];
const KINDS: Binding['kind'][] = ['key', 'mouse_button', 'wheel'];

const binding = (action: Action, kind: Binding['kind'], code: string): Binding => ({
	action,
	kind,
	code,
	ctrl: false,
	shift: false,
	alt: false,
	meta: false
});

export const DEFAULT_BINDINGS: Binding[] = [
	binding('show_next', 'mouse_button', 'left'),
	binding('show_next', 'key', 'Space'),
	binding('show_next', 'key', 'Comma'),
	binding('show_next', 'key', 'Enter'),
	binding('toggle_grade', 'mouse_button', 'right'),
	binding('toggle_grade', 'key', 'KeyX'),
	binding('toggle_grade', 'key', 'KeyM'),
	binding('previous', 'mouse_button', 'middle'),
	binding('previous', 'key', 'Backspace'),
	binding('previous', 'key', 'KeyJ')
];

/**
 * The most bindings a device holds, over its three actions. Shared with all
 * devices, the list travels as one setting, and an account's shared settings
 * may take 16 KB in all (a request carrying more is a 400 for the whole
 * sync): 64 bindings are under 8 KB.
 */
export const MAX_BINDINGS = 64;

/**
 * A stored list made valid: well-formed bindings kept, the rest dropped, no
 * stroke twice. One that leaves an action with none, or anything unreadable,
 * is the defaults, so the player always has every action.
 */
export function normalizeBindings(stored: unknown): Binding[] {
	if (!Array.isArray(stored)) return DEFAULT_BINDINGS.map((b) => ({ ...b }));
	const out: Binding[] = [];
	for (const raw of stored as Partial<Binding>[]) {
		if (!raw || typeof raw !== 'object') continue;
		if (!ACTIONS.includes(raw.action as Action) || !KINDS.includes(raw.kind as Binding['kind']) || typeof raw.code !== 'string' || !raw.code) continue;
		const b: Binding = { action: raw.action!, kind: raw.kind!, code: raw.code, ctrl: !!raw.ctrl, shift: !!raw.shift, alt: !!raw.alt, meta: !!raw.meta };
		if (b.kind === 'key' && b.code === 'Escape') continue;
		if (out.length < MAX_BINDINGS && !out.some((o) => sameStroke(o, b))) out.push(b);
	}
	return ACTIONS.every((a) => out.some((b) => b.action === a)) ? out : DEFAULT_BINDINGS.map((b) => ({ ...b }));
}

const MOUSE = ['left', 'middle', 'right', 'back', 'forward'];

const mods = (e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }) => ({
	ctrl: e.ctrlKey,
	shift: e.shiftKey,
	alt: e.altKey,
	meta: e.metaKey
});

export function keyStroke(e: KeyboardEvent): Stroke {
	return { kind: 'key', code: e.code, ...mods(e) };
}

export function mouseStroke(e: MouseEvent): Stroke | null {
	const code = MOUSE[e.button];
	return code ? { kind: 'mouse_button', code, ...mods(e) } : null;
}

export function wheelStroke(e: WheelEvent): Stroke | null {
	if (e.deltaY === 0) return null;
	return { kind: 'wheel', code: e.deltaY < 0 ? 'up' : 'down', ...mods(e) };
}

export function sameStroke(a: Stroke, b: Stroke): boolean {
	return a.kind === b.kind && a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;
}

export function actionFor(bindings: Binding[], s: Stroke): Action | null {
	return bindings.find((b) => sameStroke(b, s))?.action ?? null;
}

/**
 * While the typed input has focus, every stroke that types, edits or submits
 * goes to the input: any key producing a character with or without Shift,
 * Space, Backspace, Delete and Enter. Strokes with Ctrl, Alt or Meta still
 * act, and so do Escape, the arrow keys and function keys.
 */
export function inputOwns(e: KeyboardEvent): boolean {
	if (e.ctrlKey || e.altKey || e.metaKey) return false;
	if (['Space', 'Backspace', 'Delete', 'Enter', 'NumpadEnter'].includes(e.code)) return true;
	return e.key.length === 1;
}

/** Drops the same action fired twice within `ms` (120 ms for actions, 150 ms for the wheel). */
export class Debounce {
	private last = new Map<string, number>();
	/** A fixed window, or one read on every press (a setting the user can change). */
	constructor(private readonly ms: number | (() => number)) {}
	pass(key: string, now: number): boolean {
		const t = this.last.get(key);
		const ms = typeof this.ms === 'function' ? this.ms() : this.ms;
		if (t !== undefined && now - t < ms) return false;
		this.last.set(key, now);
		return true;
	}
}

/** The strokes a page may never receive, which the capture box warns about. */
export function mayNotReceive(s: Stroke): boolean {
	if (s.kind === 'mouse_button') return s.code === 'back' || s.code === 'forward';
	if (s.kind !== 'key') return false;
	return (s.ctrl && ['KeyW', 'KeyT', 'KeyN', 'Tab'].includes(s.code)) || (s.meta && ['KeyQ', 'KeyW'].includes(s.code));
}

/**
 * Binding a stroke to an action: a stroke belongs to one action, so it moves
 * from any other (`moved` names that one). An action holds any number.
 */
export function bind(bindings: Binding[], action: Action, s: Stroke): { bindings: Binding[]; moved: Action | null; refused: boolean } {
	if (s.kind === 'key' && s.code === 'Escape') return { bindings, moved: null, refused: true };
	const existing = bindings.find((b) => sameStroke(b, s));
	if (existing?.action === action) return { bindings, moved: null, refused: false };
	if (!existing && bindings.length >= MAX_BINDINGS) return { bindings, moved: null, refused: true };
	const rest = bindings.filter((b) => !sameStroke(b, s));
	if (existing && rest.filter((b) => b.action === existing.action).length === 0) {
		// Every action must keep at least one binding.
		return { bindings, moved: null, refused: true };
	}
	return { bindings: [...rest, { action, ...s }], moved: existing ? existing.action : null, refused: false };
}

export function unbind(bindings: Binding[], target: Binding): Binding[] {
	const rest = bindings.filter((b) => b !== target);
	return rest.some((b) => b.action === target.action) ? rest : bindings;
}
