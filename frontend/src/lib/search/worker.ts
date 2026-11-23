// The search worker (PLAN.md § Search page): the server's search engine as
// WebAssembly (backend/search-wasm), holding the lexicons this tab has loaded
// and the latest search's words. The page sends one request at a time
// (`client.ts`); each runs to the end before the next, so a newer search
// simply follows an older one, which the page then ignores.
import wasmUrl from './search.wasm?url';
import type { Reply, Request } from './protocol';

interface Exports {
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	dealloc(ptr: number, len: number): void;
	output_ptr(): number;
	output_len(): number;
	index_format(): number;
	load(req: number, reqLen: number, core: number, coreLen: number, defs: number, defsLen: number): number;
	load_encoded(req: number, reqLen: number, bytes: number, bytesLen: number): number;
	add_definitions(name: number, nameLen: number, defs: number, defsLen: number): number;
	encode(name: number, nameLen: number): number;
	unload(name: number, nameLen: number): number;
	search(req: number, reqLen: number): number;
	sort(req: number, reqLen: number): number;
	rows(from: number, n: number): number;
	export(req: number, reqLen: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function instantiate(): Promise<Exports> {
	const imports = { env: { now: () => performance.now() } };
	const res = await fetch(wasmUrl);
	// Streaming needs application/wasm; a server that labels it otherwise still works, slower.
	const { instance } = res.headers.get('content-type')?.startsWith('application/wasm')
		? await WebAssembly.instantiateStreaming(res, imports)
		: await WebAssembly.instantiate(await res.arrayBuffer(), imports);
	return instance.exports as unknown as Exports;
}

const ready = instantiate();

/** Bytes copied into the module's memory, freed after `f`. */
function withBytes<T>(x: Exports, parts: (string | ArrayBuffer | Uint8Array)[], f: (args: number[]) => T): T {
	const placed = parts.map((p) => {
		const b = typeof p === 'string' ? encoder.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p);
		const ptr = b.length ? x.alloc(b.length) : 0;
		// Read the buffer after alloc: growing memory replaces it.
		if (b.length) new Uint8Array(x.memory.buffer, ptr, b.length).set(b);
		return [ptr, b.length] as const;
	});
	try {
		return f(placed.flat());
	} finally {
		for (const [ptr, len] of placed) if (len) x.dealloc(ptr, len);
	}
}

const outputBytes = (x: Exports) => new Uint8Array(x.memory.buffer, x.output_ptr(), x.output_len());
const outputJson = (x: Exports) => JSON.parse(decoder.decode(outputBytes(x)));

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
	return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function gunzip(bytes: ArrayBuffer): Promise<Uint8Array> {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function handle(r: Request): Promise<{ reply: Reply; transfer?: Transferable[] }> {
	const x = await ready;
	// The module's reply: `{ok: true, …}`, or a failure's JSON.
	const json = (_code?: number) => ({ reply: outputJson(x) as Reply });
	switch (r.type) {
		case 'format':
			return { reply: { ok: true, format: x.index_format() } };
		case 'build': {
			const req = JSON.stringify({ name: r.name, distribution: r.distribution });
			withBytes(x, [req, r.core, new Uint8Array()], ([a, b, c, d, e, f]) => x.load(a, b, c, d, e, f));
			return json(0);
		}
		case 'restore': {
			const bytes = await gunzip(r.gzipped);
			const req = JSON.stringify({ name: r.name, distribution: r.distribution, definitions: r.definitions });
			withBytes(x, [req, bytes], ([a, b, c, d]) => x.load_encoded(a, b, c, d));
			return json(0);
		}
		case 'add_definitions':
			withBytes(x, [r.name, r.definitions], ([a, b, c, d]) => x.add_definitions(a, b, c, d));
			return json(0);
		case 'save': {
			const code = withBytes(x, [r.name], ([a, b]) => x.encode(a, b));
			if (code !== 0) return json(code);
			// Copied out before compressing: the stream reads it after this turn.
			const gzipped = await gzip(outputBytes(x).slice());
			return { reply: { ok: true, gzipped }, transfer: [gzipped] };
		}
		case 'unload':
			withBytes(x, [r.name], ([a, b]) => x.unload(a, b));
			return json(0);
		case 'search': {
			const req = JSON.stringify({ lexicon: r.lexicon, filters: r.filters, sort: r.sort, deadline_ms: r.deadline_ms });
			withBytes(x, [req], ([a, b]) => x.search(a, b));
			return json(0);
		}
		case 'sort':
			withBytes(x, [JSON.stringify(r.sort)], ([a, b]) => x.sort(a, b));
			return json(0);
		case 'rows':
			x.rows(r.from, r.n);
			return { reply: { ok: true, rows: outputJson(x) } };
		case 'export': {
			const code = withBytes(x, [JSON.stringify({ format: r.format, columns: r.columns })], ([a, b]) => x.export(a, b));
			if (code !== 0) return json(code);
			const type = r.format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
			return { reply: { ok: true, file: new Blob([outputBytes(x).slice()], { type }) } };
		}
	}
}

// One request at a time, in the order they came.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<{ id: number; request: Request }>) => {
	const { id, request } = ev.data;
	queue = queue.then(async () => {
		try {
			const { reply, transfer } = await handle(request);
			(self as unknown as Worker).postMessage({ id, reply }, transfer ?? []);
		} catch (e) {
			(self as unknown as Worker).postMessage({ id, reply: { ok: false, message: e instanceof Error ? e.message : String(e) } });
		}
	});
};
