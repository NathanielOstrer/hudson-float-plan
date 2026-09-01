/* End-to-end check against the built static site.
 *
 * Serves docs/ the way GitHub Pages does, drives the form, and reads the
 * computed output. playwright-core is not installed in this repo. Install it in
 * a scratch directory and point NODE_PATH at it:
 *
 *   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
 *   PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core node tests/e2e.mjs
 *
 * ESM ignores NODE_PATH, so the package location comes from PLAYWRIGHT_CORE.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';
import path from 'node:path';

const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const chromium = pw.chromium || pw.default.chromium;   // the package is CommonJS

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data', 'conditions.json');
const PORT = 8021;

const EXE = globSync(
  path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell')
).sort().pop();
if (!EXE) throw new Error('no headless_shell found under ~/Library/Caches/ms-playwright');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : '  <- ' + detail}`);
  if (!ok) failures++;
};

const serve = () => spawn('python3', ['-m', 'http.server', String(PORT), '-d', DOCS],
  { stdio: 'ignore' });

const settle = page => page.waitForTimeout(400);

async function main() {
  if (!existsSync(DATA)) throw new Error('run generate.py and build.py first');
  const original = readFileSync(DATA, 'utf8');
  const bundle = JSON.parse(original);
  const server = serve();
  const browser = await chromium.launch({ executablePath: EXE });

  try {
    await new Promise(r => setTimeout(r, 700));
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    /* ---- 1. the page loads and reads its one data file ---- */
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await settle(page);

    check('no uncaught page errors', errors.length === 0, errors.join('; '));
    check('the page fetches conditions.json', requests.some(u => u.includes('conditions.json')));
    check('the page makes no /api call', !requests.some(u => u.includes('/api/')));

    /* ---- 2. a normal sail window computes a plan ---- */
    const sailDate = bundle.waterDates[3];
    await page.fill('#f-date', sailDate);
    await page.fill('#f-depart', '13:00');
    await page.fill('#f-return', '16:00');
    await settle(page);

    const windDir = await page.inputValue('#f-winddir');
    const windLo = await page.inputValue('#f-windlo');
    check('the wind direction autofills from the forecast', windDir !== '', `got "${windDir}"`);
    check('the wind speed autofills from the forecast', windLo !== '', `got "${windLo}"`);

    const fcst = await page.textContent('#fcstline');
    check('the forecast line names the NWS', /NWS/.test(fcst), fcst);
    const cls = await page.getAttribute('#fcstline', 'class');
    check('the forecast line is marked live, not stale', /live/.test(cls), cls);

    const plan = await page.textContent('#sec-window');
    check('the sail window renders content', plan.trim().length > 40);
    const body = await page.textContent('body');
    check('the plan names the flood or the ebb', /flood|ebb|slack/i.test(body));
    check('the plan gives a heading or a turn time', /\d{2}:\d{2}/.test(body));

    /* ---- 3. the date picker cannot leave the generated window ---- */
    const min = await page.getAttribute('#f-date', 'min');
    const max = await page.getAttribute('#f-date', 'max');
    check('the picker minimum is the second generated date',
      min === bundle.waterDates[1], `${min} vs ${bundle.waterDates[1]}`);
    check('the picker maximum is the second-to-last generated date',
      max === bundle.waterDates[bundle.waterDates.length - 2], max);

    /* ---- 4. inside the water window, past the wind horizon ---- */
    const windDates = Object.keys(bundle.wind).sort();
    const beyond = bundle.waterDates[bundle.waterDates.length - 2];
    check('the chosen date really is past the wind horizon',
      beyond > windDates[windDates.length - 1]);
    await page.fill('#f-date', beyond);
    await settle(page);

    const lateLine = await page.textContent('#fcstline');
    check('the page says the wind forecast does not reach that date',
      /does not reach that date/.test(lateLine), lateLine);
    const lateBody = await page.textContent('body');
    check('the tide and current still render past the wind horizon',
      /flood|ebb|slack/i.test(lateBody));
    check('still no uncaught errors', errors.length === 0, errors.join('; '));

    /* ---- 5. the rose names each arrow by the colour it is actually drawn in ---- */
    /* Solid against dashed is hard to read at 118px, so the copy leads with the
       colour. The current arrow takes --flood or --ebb, so the word has to
       follow the tide, and both hues have to survive the theme swap. */
    const HUE = {
      light: { flood: '#15607F', ebb: '#9A5A12', wind: '#B01D6B' },
      dark:  { flood: '#5BB6D6', ebb: '#DFA05A', wind: '#F0629F' },
    };
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newPage({ colorScheme: scheme });
      await themed.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
      await settle(themed);
      for (const [tide, word, depart, back] of
           [['flood', 'blue', '12:30', '15:30'], ['ebb', 'amber', '06:30', '09:30']]) {
        await themed.fill('#f-date', '2026-09-02');
        await themed.fill('#f-depart', depart);
        await themed.fill('#f-return', back);
        await themed.selectOption('#f-winddir', '247.5');
        await themed.fill('#f-windlo', '8');
        await settle(themed);
        const text = await themed.textContent('#rose-text');
        const strokes = await themed.$$eval('#rose line', ls => ls.map(l => ({
          colour: l.getAttribute('stroke'), dashed: !!l.getAttribute('stroke-dasharray') })));
        const current = strokes.find(a => !a.dashed);
        const wind = strokes.find(a => a.dashed);
        check(`${scheme}: the ${tide} sentence names the ${word} arrow`,
          text.startsWith(`The ${word} arrow shows the ${tide}.`), text.slice(0, 60));
        check(`${scheme}: the ${tide} arrow is drawn ${word}`,
          current && current.colour === HUE[scheme][tide],
          `${current && current.colour} vs ${HUE[scheme][tide]}`);
        check(`${scheme}: the wind arrow is drawn pink and dashed`,
          wind && wind.colour === HUE[scheme].wind,
          `${wind && wind.colour} vs ${HUE[scheme].wind}`);
      }
      await themed.close();
    }

    /* ---- 6. a stale build raises the banner ---- */
    const stale = JSON.parse(original);
    stale.generated = new Date(Date.now() - 20 * 3600 * 1000)
      .toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(DATA, JSON.stringify(stale));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await settle(page);

    const banner = await page.textContent('#buildline');
    const bannerCls = await page.getAttribute('#buildline', 'class');
    check('the build-age banner appears', /20 hours old/.test(banner), banner);
    check('the build-age banner is marked stale', /stale/.test(bannerCls), bannerCls);

    /* ---- 7. a missing data file does not leave a silent blank page ---- */
    writeFileSync(DATA, '{ not json');
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await settle(page);
    const broken = await page.textContent('#buildline');
    check('a broken data file tells the reader not to sail on it',
      /Do not sail on this plan/.test(broken), broken);

  } finally {
    await browser.close();
    server.kill();
  }
}

const original = readFileSync(DATA, 'utf8');
try {
  await main();
} finally {
  writeFileSync(DATA, original);   // always put the real data back
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
