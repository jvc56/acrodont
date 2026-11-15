// Pins the Nginx rules production taught birdtest (BIRDTEST_LESSONS_PLAN.md
// EDGE-1..4), so they cannot drift back unnoticed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '..');
const conf = readFileSync(resolve(root, 'docker/nginx.conf.template'), 'utf8');
const headers = readFileSync(resolve(root, 'docker/acrodont-headers.inc'), 'utf8');
const alb = readFileSync(resolve(root, 'infra/alb.tf'), 'utf8');
const config = readFileSync(resolve(root, 'backend/src/config.rs'), 'utf8');
const exportRs = readFileSync(resolve(root, 'backend/src/export/mod.rs'), 'utf8');

/** The location that answers a server export's download. */
const EXPORT = '~ ^/api/cascades/[^/]+/export$';

/** The directives of one `location … {}` block, without its comments. */
function location(spec: string): string {
	const start = conf.indexOf(`location ${spec} {`);
	expect(start, `location ${spec}`).toBeGreaterThanOrEqual(0);
	const end = conf.indexOf('\n    }', start);
	return conf
		.slice(start, end)
		.split('\n')
		.filter((l) => !l.trim().startsWith('#'))
		.join('\n');
}

function seconds(source: string, re: RegExp): number {
	const m = source.match(re);
	expect(m, String(re)).not.toBeNull();
	return Number(m![1]);
}

describe('docker/nginx.conf.template', () => {
	it('keeps connections open longer than the ALB does, or the ALB reuses closed ones and answers 502', () => {
		const keepalive = seconds(conf, /^\s*keepalive_timeout\s+(\d+)s;/m);
		const idle = seconds(alb, /^\s*idle_timeout\s*=\s*(\d+)/m);
		expect(keepalive).toBeGreaterThan(idle);
	});

	it('never caches a missing chunk as immutable, and never answers one with index.html', () => {
		const immutable = location('/_app/immutable/');
		expect(immutable).toMatch(/try_files \$uri =404;/);
		const cache = immutable.split('\n').find((l) => l.includes('Cache-Control'));
		expect(cache).toContain('immutable');
		expect(cache).not.toMatch(/\balways\b/);
	});

	it('revalidates the shell and the service worker on every visit', () => {
		for (const spec of ['/', '= /index.html', '= /service-worker.js']) {
			expect(location(spec)).toMatch(/Cache-Control "no-cache" always/);
		}
	});

	it('compresses the build but leaves the API to the backend', () => {
		expect(conf).toMatch(/^\s*gzip on;/m);
		expect(conf).toMatch(/gzip_types[^;]*application\/javascript/);
		expect(location('/api/')).toMatch(/gzip off;/);
	});

	it('sends the security headers from every location that sets its own', () => {
		for (const spec of ['/api/', EXPORT, '= /health', '= /service-worker.js', '= /index.html', '/_app/immutable/', '/']) {
			expect(location(spec), spec).toContain('include /etc/nginx/conf.d/acrodont-headers.inc;');
		}
		for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security']) {
			expect(headers).toContain(h);
		}
		expect(conf).toMatch(/absolute_redirect off;/);
		expect(conf).toMatch(/server_tokens off;/);
	});

	it('buffers an export, so a slow download does not hold the backend\'s only export permit', () => {
		const exp = location(EXPORT);
		expect(exp).toMatch(/^\s*proxy_buffering on;/m);
		// The rest of the API is read straight through (the event stream needs it).
		const api = location('/api/');
		expect(api).toMatch(/^\s*proxy_buffering off;/m);
		// Everything else the API location tells the backend, the export location tells it too.
		for (const line of api.split('\n').filter((l) => /^\s*proxy_(pass|http_version|set_header)\b/.test(l))) {
			expect(exp, line.trim()).toContain(line.trim());
		}
		expect(exp).toMatch(/^\s*gzip off;/m);
		// Buffering to a file is logged as a warning that quotes the URL, token and all.
		expect(exp).toMatch(/^\s*error_log \/var\/log\/nginx\/error\.log error;/m);

		// The download, and nothing else: the token request stays unbuffered under /api/.
		const re = new RegExp(EXPORT.slice(2));
		expect(re.test('/api/cascades/0b9c2c5e-6f0f-4d53-9d39-0c1f6a1c3f11/export')).toBe(true);
		for (const other of [
			'/api/cascades/0b9c2c5e-6f0f-4d53-9d39-0c1f6a1c3f11/export-token',
			'/api/cascades/0b9c2c5e-6f0f-4d53-9d39-0c1f6a1c3f11/cards',
			'/api/cascades/a/b/export',
			'/api/sync/events'
		]) {
			expect(re.test(other), other).toBe(false);
		}
	});

	it('bounds the disk buffered exports can take, well inside the task\'s 20 GiB', () => {
		const exp = location(EXPORT);
		const fileMb = seconds(exp, /proxy_max_temp_file_size\s+(\d+)m;/);
		const atOnce = seconds(exp, /limit_conn\s+acrodont_exports\s+(\d+);/);
		expect(conf).toMatch(/^limit_conn_zone \$server_name zone=acrodont_exports:/m);
		expect(exp).toMatch(/limit_conn_status 503;/);
		expect(fileMb * atOnce).toBeLessThanOrEqual(10 * 1024);
		// Room for the largest export many times over (tens of megabytes).
		expect(fileMb).toBeGreaterThanOrEqual(256);
	});

	it('waits for the backend longer than the backend waits for a reader that has stalled', () => {
		const backendWait = seconds(exportRs, /const EXPORT_SEND_WAIT: std::time::Duration = std::time::Duration::from_secs\((\d+)\);/);
		expect(backendWait).toBe(30);
		expect(seconds(location(EXPORT), /proxy_read_timeout\s+(\d+)s;/)).toBeGreaterThan(backendWait);
	});

	it('accepts an admin upload of ADMIN_UPLOAD_MAX_BYTES', () => {
		const limitMb = seconds(conf, /client_max_body_size\s+(\d+)m;/);
		const uploadBytes = seconds(config.replace(/(\d)_(\d)/g, '$1$2'), /"ADMIN_UPLOAD_MAX_BYTES",\s*(\d+)/);
		expect(limitMb * 1024 * 1024).toBeGreaterThan(uploadBytes);
	});
});
