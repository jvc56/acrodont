// Renders the app's PNG icons from static/icons/*.svg (PLAN.md § On the device →
// Installing the app). Run after changing an SVG, from frontend/:
//   node scripts/icons.mjs
// It uses the end-to-end suite's Playwright (cd ../e2e && npm ci first).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../e2e/package.json', import.meta.url)));
const { chromium } = require('playwright');
const dir = fileURLToPath(new URL('../static/icons/', import.meta.url));

const outputs = [
	['icon.svg', 'icon-192.png', 192],
	['icon.svg', 'icon-512.png', 512],
	['icon-maskable.svg', 'icon-maskable-512.png', 512],
	// iOS draws its own rounded corners over a square icon.
	['icon-maskable.svg', 'apple-touch-icon.png', 180],
	// The browser tab's icon, for a browser that asks for /favicon.ico.
	['favicon.svg', 'favicon-32.png', 32]
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, png, size] of outputs) {
	await page.setViewportSize({ width: size, height: size });
	const markup = readFileSync(dir + svg, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
	await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
	await page.locator('svg').screenshot({ path: dir + png, omitBackground: true });
	console.log(png);
}
await browser.close();

// /favicon.ico: one 32 px PNG in an ICO container (an ICO may hold a PNG).
const png = readFileSync(dir + 'favicon-32.png');
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); // reserved
head.writeUInt16LE(1, 2); // an icon
head.writeUInt16LE(1, 4); // one image
head.writeUInt8(32, 6); // width
head.writeUInt8(32, 7); // height
head.writeUInt8(0, 8); // no palette
head.writeUInt8(0, 9); // reserved
head.writeUInt16LE(1, 10); // colour planes
head.writeUInt16LE(32, 12); // bits per pixel
head.writeUInt32LE(png.length, 14);
head.writeUInt32LE(22, 18); // where the image starts
writeFileSync(fileURLToPath(new URL('../static/favicon.ico', import.meta.url)), Buffer.concat([head, png]));
console.log('favicon.ico');
