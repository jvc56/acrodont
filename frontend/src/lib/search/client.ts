// The page's side of the search worker (PLAN.md § Search page): one worker
// per tab, started on first use and kept, so a lexicon it has loaded stays
// loaded while the tab is open.
import type { Reply, Request } from './protocol';

export interface WorkerLike {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((ev: MessageEvent) => void) | null;
}

export class SearchClient {
	private next = 1;
	private waiting = new Map<number, (r: Reply) => void>();

	constructor(private worker: WorkerLike) {
		worker.onmessage = (ev: MessageEvent<{ id: number; reply: Reply }>) => {
			const done = this.waiting.get(ev.data.id);
			this.waiting.delete(ev.data.id);
			done?.(ev.data.reply);
		};
	}

	call(request: Request, transfer: Transferable[] = []): Promise<Reply> {
		const id = this.next++;
		return new Promise((resolve) => {
			this.waiting.set(id, resolve);
			this.worker.postMessage({ id, request }, transfer);
		});
	}
}

let client: SearchClient | null = null;

export function searchClient(): SearchClient {
	client ??= new SearchClient(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
	return client;
}
