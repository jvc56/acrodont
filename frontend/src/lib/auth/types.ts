/** `GET /api/auth/me` (PLAN.md § API → Auth and account). */
export interface Me {
	user_id: string;
	username: string;
	is_admin: boolean;
	trash_retention_days: number;
	max_quiz_questions: number;
	/** The account's storage and its limit, in bytes (PLAN.md § Storage limit). */
	storage_bytes: number;
	max_storage_bytes: number;
}
