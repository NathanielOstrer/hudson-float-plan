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
const hh = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

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
       follow the tide, and both hues have to survive the theme swap. The two
       windows come from the data, one around a maximum flood and one around a
       maximum ebb, so the test does not age out of the water window. */
    const roseDate = bundle.waterDates[3];
    const around = type => {
      const e = bundle.water[roseDate].current.find(x => x.type === type && x.m >= 180 && x.m <= 1200);
      return [hh(e.m - 60), hh(e.m + 60)];
    };
    const [fDep, fBack] = around('f'), [eDep, eBack] = around('e');
    const HUE = {
      light: { flood: '#15607F', ebb: '#9A5A12', wind: '#B01D6B' },
      dark:  { flood: '#5BB6D6', ebb: '#DFA05A', wind: '#F0629F' },
    };
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newPage({ colorScheme: scheme });
      await themed.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
      await settle(themed);
      for (const [tide, word, depart, back] of
           [['flood', 'blue', fDep, fBack], ['ebb', 'amber', eDep, eBack]]) {
        await themed.fill('#f-date', roseDate);
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

    /* ---- 6. the turn is drawn as a band across the three depth bins ---- */
    /* The deep water turns first and the surface last. The page draws the
       mid-depth slack as a dashed line and the spread as a grey band, and the
       plan gives the spread as "between A and B". Recompute the expected band
       from the data with the same rule: the nearest slack within three hours
       that leads into the same set. */
    const day = bundle.water[sailDate];
    const mid = day.current;
    const si = mid.findIndex((e, i) => e.type === 's' && e.m >= 150 && e.m <= 1250 && mid[i + 1] && mid[i + 1].type !== 's');
    const sl = mid[si], to = mid[si + 1].type;
    const match = other => {
      let best = null;
      other.forEach((e, k) => {
        if (e.type !== 's' || Math.abs(e.m - sl.m) > 180) return;
        const n = other[k + 1];
        if (!(n && n.type === to)) return;
        if (best === null || Math.abs(e.m - sl.m) < Math.abs(best - sl.m)) best = e.m;
      });
      return best;
    };
    const ms = [sl.m, match(day.currentDeep), match(day.currentSurface)].filter(x => x !== null);
    const early = Math.min(...ms), late = Math.max(...ms);
    await page.fill('#f-date', sailDate);
    await page.fill('#f-depart', hh(sl.m - 90));
    await page.fill('#f-return', hh(sl.m + 90));
    await settle(page);
    const bands = await page.$$eval('#strip rect.band', rs => rs.map(r => +r.getAttribute('width')));
    const slackLabels = await page.$$eval('#strip text.slack', ts => ts.map(t => t.textContent));
    const lead = await page.textContent('#rec-lead');
    if (late - early >= 15) {
      check('the bins disagree on this slack and the strip draws a band', bands.length === 1 && bands[0] > 0, JSON.stringify(bands));
      check('the strip labels the slack with the spread',
        slackLabels.includes(`slack ${hh(early)} to ${hh(late)}`), slackLabels.join(' | '));
      check('the plan gives the turn as a spread',
        lead.includes(`between ${hh(early)} and ${hh(late)}`), lead);
    } else {
      check('the bins agree on this slack and the strip draws no band', bands.length === 0, JSON.stringify(bands));
      check('the plan gives the turn as one time', lead.includes(`at ${hh(sl.m)}`), lead);
    }

    /* the steps must stay in time order however the band falls against the
       window: with the deep slack before cast off, and the surface slack
       after the return */
    const stepsInOrder = async () => {
      const whens = await page.$$eval('#rec-steps .when', ws => ws.map(w => w.textContent));
      const mins = whens.map(w => +w.slice(0, 2) * 60 + +w.slice(3, 5));
      return { whens, ok: mins.every((m, i) => i === 0 || m >= mins[i - 1]) };
    };
    for (const [dep, back, why] of [
      [hh(sl.m - 90), hh(sl.m + 90), 'band inside the window'],
      [hh(Math.min(sl.m - 30, early + 20)), hh(sl.m + 90), 'deep slack before cast off'],
      [hh(sl.m - 90), hh(Math.max(sl.m + 30, late - 20)), 'surface slack after the return'],
    ]) {
      await page.fill('#f-depart', dep);
      await page.fill('#f-return', back);
      await settle(page);
      const r = await stepsInOrder();
      check(`the plan steps stay in time order: ${why}`, r.ok, r.whens.join(' > '));
    }
    await page.fill('#f-depart', hh(sl.m - 90));
    await page.fill('#f-return', hh(sl.m + 90));
    await settle(page);

    /* ---- 7. the axis labels sit on the centreline, not in the corners ---- */
    const axis = await page.$$eval('#strip text.axis', ts => ts.map(t => ({
      t: t.textContent, x: +t.getAttribute('x'), y: +t.getAttribute('y') })));
    check('the strip carries a flood label and an ebb label',
      axis.length === 2 && axis[0].t.startsWith('FLOOD') && axis[1].t.startsWith('EBB'), JSON.stringify(axis));
    check('the flood label sits above the ebb label at the same x',
      axis.length === 2 && axis[0].y < axis[1].y && axis[0].x === axis[1].x, JSON.stringify(axis));
    check('neither label is in the top corners', axis.every(a => a.y > 40), JSON.stringify(axis));
    check('still no uncaught errors after the band', errors.length === 0, errors.join('; '));

    /* ---- 8. a stale build raises the banner ---- */
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

    /* ---- 9. a missing data file does not leave a silent blank page ---- */
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
