// The per-user database (PLAN.md § On the device → IndexedDB stores): one per
// user id, opened only for the signed-in account, upgraded by versioned
// migrations. A tab still on an old build closes its connection on
// `versionchange`, so the new build's upgrade is never blocked.
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { userDbName } from './accounts';
import type {
	AttemptRow,
	CardRow,
	CascadeRow,
	DistributionRow,
	OutboxEntry,
	QuestionKey,
	QuestionRow,
	QuizRow
} from './rows';
import { CASCADE_SETTING_DEFAULTS, touchesOf } from './rows';

type QuestionKeyPath = [string, number];

interface RowStores {
	cascades: { key: string; value: CascadeRow };
	quizzes: { key: string; value: QuizRow; indexes: { cascade_id: string } };
	quiz_questions: {
		key: QuestionKeyPath;
		value: QuestionRow;
		indexes: { quiz_id: string; cascade_id: string; quiz_position: [string, number] };
	};
	quiz_attempts: { key: QuestionKeyPath; value: AttemptRow; indexes: { quiz_id: string; cascade_id: string } };
}

export interface UserSchema extends DBSchema {
	meta: { key: string; value: unknown };
	distributions: { key: string; value: DistributionRow };
	cascades: RowStores['cascades'];
	quizzes: RowStores['quizzes'];
	quiz_questions: RowStores['quiz_questions'];
	quiz_attempts: RowStores['quiz_attempts'];
	overlay_cascades: RowStores['cascades'];
	overlay_quizzes: RowStores['quizzes'];
	overlay_quiz_questions: RowStores['quiz_questions'];
	overlay_quiz_attempts: RowStores['quiz_attempts'];
	staging_cascades: RowStores['cascades'];
	staging_quizzes: RowStores['quizzes'];
	staging_quiz_questions: RowStores['quiz_questions'];
	staging_quiz_attempts: RowStores['quiz_attempts'];
	questions: { key: QuestionKeyPath; value: QuestionKey; indexes: { cascade_id: string } };
	cards: { key: QuestionKeyPath; value: CardRow; indexes: { cascade_id: string } };
	outbox: { key: number; value: OutboxEntry; indexes: { cascade_id: string; cursor_quiz: string; touches: string } };
}

export type UserDb = IDBPDatabase<UserSchema>;
export type StoreName = StoreNames<UserSchema>;

export const BASE = ['cascades', 'quizzes', 'quiz_questions', 'quiz_attempts'] as const;
export const OVERLAY = ['overlay_cascades', 'overlay_quizzes', 'overlay_quiz_questions', 'overlay_quiz_attempts'] as const;
export const STAGING = ['staging_cascades', 'staging_quizzes', 'staging_quiz_questions', 'staging_quiz_attempts'] as const;

function rowStores(db: IDBPDatabase<UserSchema>, [c, q, qq, qa]: readonly [string, string, string, string]) {
	// The generic names defeat idb's typing here; the shapes are RowStores'.
	const d = db as unknown as IDBPDatabase;
	d.createObjectStore(c, { keyPath: 'id' });
	const quizzes = d.createObjectStore(q, { keyPath: 'id' });
	quizzes.createIndex('cascade_id', 'cascade_id');
	const questions = d.createObjectStore(qq, { keyPath: ['quiz_id', 'question_idx'] });
	questions.createIndex('quiz_id', 'quiz_id');
	questions.createIndex('cascade_id', 'cascade_id');
	questions.createIndex('quiz_position', ['quiz_id', 'position']);
	const attempts = d.createObjectStore(qa, { keyPath: ['quiz_id', 'attempt'] });
	attempts.createIndex('quiz_id', 'quiz_id');
	attempts.createIndex('cascade_id', 'cascade_id');
}

/**
 * Versioned migrations; index i upgrades from version i to i + 1, inside the
 * upgrade transaction. One that rewrites rows returns when it is done, and the
 * next starts only then (`upgradeFrom`), so two never walk the same store at once.
 */
export const MIGRATIONS: Array<
	(db: IDBPDatabase<UserSchema>, tx: IDBPTransaction<UserSchema, StoreName[], 'versionchange'>) => void | Promise<void>
> = [
	(db) => {
		db.createObjectStore('meta');
		// The account's preferences, until version 3 moved them onto each cascade.
		(db as unknown as IDBPDatabase).createObjectStore('preferences');
		db.createObjectStore('distributions', { keyPath: 'name' });
		rowStores(db, BASE);
		rowStores(db, OVERLAY);
		rowStores(db, STAGING);
		db.createObjectStore('questions', { keyPath: ['cascade_id', 'idx'] }).createIndex('cascade_id', 'cascade_id');
		db.createObjectStore('cards', { keyPath: ['cascade_id', 'idx'] }).createIndex('cascade_id', 'cascade_id');
		const outbox = db.createObjectStore('outbox', { keyPath: 'device_seq' });
		outbox.createIndex('cascade_id', 'cascade_id');
		outbox.createIndex('cursor_quiz', 'cursor_quiz');
	},
	// 2: what each pending operation touches, for the rebase's fast path; the
	// entries already queued are given theirs.
	async (_db, tx) => {
		const outbox = tx.objectStore('outbox');
		outbox.createIndex('touches', 'touches', { multiEntry: true });
		let cursor = await outbox.openCursor();
		while (cursor) {
			await cursor.update({ ...cursor.value, touches: touchesOf(cursor.value.op) });
			cursor = await cursor.continue();
		}
	},
	// 3: no account preferences (PLAN.md § Settings): their store goes, with any
	// change to them still waiting to be sent, and each cascade the device holds
	// takes the per-cascade settings at their defaults until its next pull.
	async (db, tx) => {
		(db as unknown as IDBPDatabase).deleteObjectStore('preferences');
		let entry = await tx.objectStore('outbox').openCursor();
		while (entry) {
			if (entry.value.op.type === 'set_preferences') await entry.delete();
			entry = await entry.continue();
		}
		for (const store of [BASE[0], OVERLAY[0], STAGING[0]]) {
			let row = await tx.objectStore(store).openCursor();
			while (row) {
				await row.update({ ...CASCADE_SETTING_DEFAULTS, ...row.value });
				row = await row.continue();
			}
		}
	}
];

/**
 * Runs the migrations from `from` up to `to` one after another in the upgrade
 * transaction. Each starts in a callback of the last one's final request, so
 * the transaction is still active for its schema changes.
 */
export function upgradeFrom(
	db: IDBPDatabase<UserSchema>,
	tx: IDBPTransaction<UserSchema, StoreName[], 'versionchange'>,
	from: number,
	to = MIGRATIONS.length
): Promise<void> {
	let chain: Promise<void> = Promise.resolve();
	for (let v = from; v < to; v++) chain = chain.then(() => MIGRATIONS[v](db, tx));
	return chain;
}
export const USER_DB_VERSION = MIGRATIONS.length;

/**
 * Opens the signed-in account's database. `onVersionChange` runs when a newer
 * build in another tab needs the database: the connection is already closed
 * by then, and the caller shows "Acrodont was updated in another tab — reload
 * to continue".
 */
export async function openUserDb(userId: string, onVersionChange?: () => void): Promise<UserDb> {
	const db = await openDB<UserSchema>(userDbName(userId), USER_DB_VERSION, {
		upgrade(db, oldVersion, _newVersion, transaction) {
			void upgradeFrom(db, transaction, oldVersion);
		}
	});
	db.addEventListener('versionchange', () => {
		db.close();
		onVersionChange?.();
	});
	return db;
}
