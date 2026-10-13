// node shot.mjs <in.html> <out.png>: screenshots the .win element of a page (the drawn terminal window).
// A terminal has few colors, so the PNG goes through pngquant: ~4× lighter and the text stays pixel-sharp.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
const [, , inp, out] = process.argv;
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1400, height: 900 } });
await p.goto('file://' + resolve(inp));
const png = await p.locator('.win').screenshot({ omitBackground: true });
await b.close();
execFileSync('pngquant', ['--quality', '60-85', '--speed', '1', '--force', '--output', out, '-'], { input: png });
