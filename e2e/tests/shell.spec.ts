import { test, expect, devices } from '@playwright/test';
import { createCascade, login, newUser } from './support';

// PLAN.md § Deployment and Operations → Security headers: the shell loads under
// its own CSP (a missing hash would leave a blank page) with Nginx's headers.
test('the app shell boots under its CSP with the Nginx headers', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(m.text());
	});
	const resp = await page.goto('/');
	expect(resp?.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
	expect(resp?.headers()['x-content-type-options']).toBe('nosniff');
	expect(resp?.headers()['x-frame-options']).toBeUndefined();
	// There is no landing page: signed out, / is the log-in page.
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
	expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
});

// PLAN.md § On the device → App shell: once the service worker is active, a
// reload of an app route with no connection still loads the app, while /api
// navigations go to the network untouched.
test('the service worker serves the shell offline', async ({ page, context }) => {
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	// A reload so the page is controlled.
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	// The index.html the worker serves carries the build's <meta> policy: script-src
	// holds 'self' and a hash, never 'unsafe-inline'; an injected inline script is refused.
	const html = await page.evaluate(async () => (await (await caches.match('/index.html'))?.text()) ?? '');
	const policy = /<meta http-equiv="content-security-policy" content="([^"]+)"/i.exec(html)?.[1] ?? '';
	const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
	expect(scriptSrc).toContain("'self'");
	expect(scriptSrc).toMatch(/'sha256-[^']+'/);
	expect(scriptSrc).not.toContain('unsafe-inline');
	const refused = await page.evaluate(
		() =>
			new Promise<boolean>((resolve) => {
				document.addEventListener('securitypolicyviolation', () => resolve(true), { once: true });
				const s = document.createElement('script');
				s.textContent = 'window.__injected = true';
				document.body.appendChild(s);
				setTimeout(() => resolve(false), 1000);
			})
	);
	expect(refused).toBe(true);
	expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
	await context.setOffline(true);
	await page.goto('/login');
	await expect(page.getByLabel('Username')).toBeVisible();
	// A route never visited: the worker answers it with the shell, and the app,
	// signed out, goes to the log-in page. The browser's own offline page has a
	// body too, so it is the app's form that is looked for.
	await page.goto('/cascades/00000000-0000-4000-8000-000000000000').catch(() => undefined);
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByLabel('Username')).toBeVisible();
	await context.setOffline(false);
});

// PLAN.md § On the device → Installing the app: the manifest and its icons, the
// header's offline status, the browser's install offer, a closed tab reopened
// with no connection, and the iPhone's one-time tip.
test('installing: the manifest, the offline status, Install, and a tab reopened offline', async ({ page, context, browser, baseURL }) => {
	test.setTimeout(120_000);
	const manifest = await page.request.get('/manifest.webmanifest');
	expect(manifest.headers()['content-type']).toContain('application/manifest+json');
	const m = await manifest.json();
	expect(m).toMatchObject({ name: 'Acrodont', start_url: '/', display: 'standalone' });
	for (const icon of m.icons as { src: string }[]) expect((await page.request.get(icon.src)).ok()).toBe(true);
	expect((await page.request.get('/icons/apple-touch-icon.png')).ok()).toBe(true);

	const { username } = await newUser(page, 'install');
	const path = await createCascade(page, { name: 'Install cascade' });
	await page.goto('/');
	await expect(page.getByText('Available offline')).toBeVisible({ timeout: 60_000 });
	// Ready offline, and the browser asked to keep the data, whatever it answered.
	const status = page.locator('[data-offline]');
	await expect(status).toHaveAttribute('data-offline', 'ready');
	await expect(status).toHaveAttribute('data-kept', /^(true|false)$/);
	await status.hover();
	await expect(page.getByRole('tooltip')).toContainText('Acrodont opens on this device with no connection.');
	await page.mouse.move(0, 400);
	await expect(page.getByRole('tooltip')).toHaveCount(0);

	// The browser's install offer is an Install button, which opens the browser's own dialog.
	await expect(page.getByRole('button', { name: 'Install Acrodont' })).toHaveCount(0);
	await page.evaluate(() => {
		const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
			prompt: async () => {
				(window as unknown as { prompted: boolean }).prompted = true;
			},
			userChoice: Promise.resolve({ outcome: 'dismissed' })
		});
		dispatchEvent(offer);
	});
	await page.getByRole('button', { name: 'Install Acrodont' }).click();
	expect(await page.evaluate(() => (window as unknown as { prompted?: boolean }).prompted)).toBe(true);
	await expect(page.getByRole('button', { name: 'Install Acrodont' })).toHaveCount(0);

	// Closed with no connection and opened again: the cascade is there to study.
	await context.setOffline(true);
	await page.close();
	const again = await context.newPage();
	await again.goto(path);
	await expect(again.getByText('1 / 18')).toBeVisible({ timeout: 20_000 });
	await context.setOffline(false);

	// On an iPhone, which never offers to install, a tip says how, once.
	const phone = await browser.newContext({ ...devices['iPhone 13'], baseURL });
	const p = await phone.newPage();
	await login(p, username);
	const tip = p.locator('[data-install-tip]');
	await expect(tip).toContainText('tap Share, then Add to Home Screen');
	await tip.getByRole('button', { name: 'Dismiss' }).click();
	await expect(tip).toHaveCount(0);
	await p.reload();
	await expect(p.getByRole('heading', { name: 'Cascades' })).toBeVisible();
	await expect(tip).toHaveCount(0);
	await phone.close();
});
