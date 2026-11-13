import { api } from '$lib/api';

export interface AdminCatalog {
	letter_distributions: { id: number; name: string }[];
	lexicons: { id: number; name: string; letter_distribution: string; has_leave_set: boolean }[];
	leave_sets: { id: number; name: string; lexicon: string }[];
}

export const loadAdminCatalog = () => api.get<AdminCatalog>('/api/admin/catalog');
