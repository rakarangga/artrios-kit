#!/usr/bin/env node
// Renders client/public/favicon.svg to the PNG icons (favicon-32, apple-touch-icon 180, icon-512) with a headless
// Chromium. Run after changing the SVG: node bin/make-icons.mjs [path to playwright-core] (CHROME = browser exe).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'client', 'public');
const require = createRequire(process.argv[2] ? path.resolve(process.argv[2], 'package.json') : path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.screenshot({ path: path.join(pub, name), omitBackground: true });
  await page.close();
  console.log(`wrote client/public/${name}`);
}
await browser.close();
