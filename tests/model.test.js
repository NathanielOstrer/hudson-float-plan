'use strict';
/* Unit tests for the pure model in src/model.js. No DOM, no network. */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/model.js');

const near = (got, want, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) <= tol, `expected ${want}, got ${got}`);

function setWater(map) {
  Object.keys(M.WATER).forEach(k => delete M.WATER[k]);
  Object.assign(M.WATER, map);
}
function setWind(map) {
  Object.keys(M.WIND).forEach(k => delete M.WIND[k]);
  Object.assign(M.WIND, map);
}

/* ---------------- time ---------------- */
test('hhmm formats minutes past midnight', () => {
  assert.equal(M.hhmm(0), '00:00');
  assert.equal(M.hhmm(605), '10:05');
  assert.equal(M.hhmm(1439), '23:59');
});

test('hhmm wraps a value outside the day in both directions', () => {
  assert.equal(M.hhmm(1440), '00:00');
  assert.equal(M.hhmm(1500), '01:00');
  assert.equal(M.hhmm(-60), '23:00');
});

test('toMin reads a time field and rejects anything else', () => {
  assert.equal(M.toMin('13:05'), 785);
  assert.equal(M.toMin('9:30'), 570);
  assert.equal(M.toMin(''), null);
  assert.equal(M.toMin(null), null);
  assert.equal(M.toMin('not a time'), null);
});

test('addDays crosses months, years and a leap day', () => {
  assert.equal(M.addDays('2026-09-01', 1), '2026-09-02');
  assert.equal(M.addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(M.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(M.addDays('2028-02-28', 1), '2028-02-29');
});

test('addDays does not drift across the daylight-saving change', () => {
  /* The whole app is wall-clock minutes. A local Date here would give 10-31. */
  assert.equal(M.addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(M.addDays('2026-11-01', 1), '2026-11-02');
});

test('nyOffset knows summer time from winter time', () => {
  assert.equal(M.nyOffset('2026-07-01'), -240);
  assert.equal(M.nyOffset('2026-01-01'), -300);
});

/* ---------------- sun ---------------- */
test('sunEvent puts sunrise before sunset and both inside the day', () => {
  const rise = M.sunEvent('2026-06-21', false);
  const set = M.sunEvent('2026-06-21', true);
  assert.ok(rise > 0 && rise < set && set < 1440);
});

test('sunEvent matches the published New York times to a few minutes', () => {
  /* 21 Jun 2026: sunrise 05:25, sunset 20:31 New York. */
  assert.ok(Math.abs(M.sunEvent('2026-06-21', false) - (5 * 60 + 25)) <= 3);
  assert.ok(Math.abs(M.sunEvent('2026-06-21', true) - (20 * 60 + 31)) <= 3);
  /* 21 Dec 2026: sunrise 07:17, sunset 16:32. */
  assert.ok(Math.abs(M.sunEvent('2026-12-21', false) - (7 * 60 + 17)) <= 3);
  assert.ok(Math.abs(M.sunEvent('2026-12-21', true) - (16 * 60 + 32)) <= 3);
});

/* ---------------- the current curve ---------------- */
const slack = m => ({ m, type: 's', v: 0 });
const flood = (m, v) => ({ m, type: 'f', v });
const ebb = (m, v) => ({ m, type: 'e', v });

test('slack to maximum follows a sine, not a straight line', () => {
  /* This is the rule in CLAUDE.md. A linear reading here would be silently
     wrong by 41% at the midpoint, which is a whole knot on a 2.4 kt flood. */
  const tl = [slack(0), flood(180, 2.0)];
  near(M.currentAt(tl, 90), 2.0 * Math.sin(Math.PI / 4));
  assert.ok(M.currentAt(tl, 90) > 1.4);
});

test('maximum to slack follows a cosine', () => {
  const tl = [flood(0, 2.0), slack(180)];
  near(M.currentAt(tl, 90), 2.0 * Math.cos(Math.PI / 4));
});

test('the ends of a leg read exactly zero and exactly the maximum', () => {
  const tl = [slack(0), flood(180, 2.0)];
  near(M.currentAt(tl, 0), 0);
  near(M.currentAt(tl, 180), 2.0);
});

test('flood is positive and ebb is negative', () => {
  near(M.currentAt([slack(0), flood(180, 2.0)], 180), 2.0);
  near(M.currentAt([slack(0), ebb(180, 3.2)], 180), -3.2);
});

test('slack to slack is zero throughout', () => {
  const tl = [slack(0), slack(180)];
  near(M.currentAt(tl, 90), 0);
});

test('maximum to maximum interpolates linearly through the sign change', () => {
  const tl = [flood(0, 2.0), ebb(200, 2.0)];
  near(M.currentAt(tl, 100), 0);
  near(M.currentAt(tl, 50), 1.0);
});

test('a time outside the timeline returns null rather than a guess', () => {
  const tl = [slack(60), flood(240, 2.0)];
  assert.equal(M.currentAt(tl, 0), null);
  assert.equal(M.currentAt(tl, 1000), null);
  assert.equal(M.currentAt([], 100), null);
});

test('a zero-width leg returns zero instead of dividing by zero', () => {
  assert.equal(M.currentAt([slack(100), flood(100, 2.0)], 100), 0);
});

test('the direction and the name follow the sign', () => {
  assert.equal(M.setDir(1), M.FLOOD);
  assert.equal(M.setDir(-1), M.EBB);
  assert.equal(M.setName(0.05), 'slack');
  assert.equal(M.setName(-0.05), 'slack');
  assert.equal(M.setName(1.2), 'flood');
  assert.equal(M.setName(-1.2), 'ebb');
  assert.equal(M.upDown(1), 'up-river');
  assert.equal(M.upDown(-1), 'down-river');
});

/* ---------------- the three-day timeline ---------------- */
test('timeline shifts the neighbouring days by a whole day each', () => {
  setWater({
    '2026-08-31': { current: [flood(600, 1)], tide: [] },
    '2026-09-01': { current: [slack(300), ebb(600, 2)], tide: [] },
    '2026-09-02': { current: [slack(60)], tide: [] },
  });
  const tl = M.timeline('2026-09-01');
  assert.deepEqual(tl.map(e => e.m), [600 - 1440, 300, 600, 60 + 1440]);
});

test('timeline sorts the result', () => {
  setWater({
    '2026-08-31': { current: [flood(1400, 1)], tide: [] },
    '2026-09-01': { current: [ebb(10, 2), slack(700)], tide: [] },
    '2026-09-02': { current: [slack(5)], tide: [] },
  });
  const mins = M.timeline('2026-09-01').map(e => e.m);
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b));
});

test('a missing neighbouring day degrades to the days that are present', () => {
  /* Past the end of the generated window, the day after has no data. The plan
     for the day itself still has to render. */
  setWater({ '2026-09-01': { current: [slack(300), ebb(600, 2)], tide: [] },
             '2026-09-02': null });
  const tl = M.timeline('2026-09-01');
  assert.equal(tl.length, 2);
  assert.deepEqual(tl.map(e => e.m), [300, 600]);
});

test('dayEvents and dayTides tolerate a null or absent day', () => {
  setWater({ '2026-09-01': null });
  assert.deepEqual(M.dayEvents('2026-09-01'), []);
  assert.deepEqual(M.dayTides('2026-09-01'), []);
  assert.deepEqual(M.dayEvents('2099-01-01'), []);
});

/* ---------------- readDay ---------------- */
test('readDay marks a date the file does not cover', () => {
  setWater({ '2026-09-01': { current: [], tide: [] } });
  setWind({});
  M.readDay('2026-09-01');
  assert.equal(M.WATER['2026-08-31'], null);
  assert.equal(M.WATER['2026-09-02'], null);
  assert.equal(M.WIND['2026-09-01'], null);
});

test('readDay leaves data that is already loaded alone', () => {
  const block = { current: [slack(10)], tide: [] };
  setWater({ '2026-08-31': block, '2026-09-01': block, '2026-09-02': block });
  setWind({ '2026-09-01': { hours: [{ m: 0, kt: 5 }] } });
  M.readDay('2026-09-01');
  assert.equal(M.WATER['2026-09-01'], block);
  assert.equal(M.WIND['2026-09-01'].hours.length, 1);
});

test('a date inside the water window but past the wind horizon marks wind only', () => {
  setWater({ '2026-10-14': { current: [], tide: [] },
             '2026-10-15': { current: [], tide: [] },
             '2026-10-16': { current: [], tide: [] } });
  setWind({});
  M.readDay('2026-10-15');
  assert.notEqual(M.WATER['2026-10-15'], null);
  assert.equal(M.WIND['2026-10-15'], null);
});

test('readDay ignores an empty date', () => {
  setWater({});
  M.readDay('');
  assert.deepEqual(Object.keys(M.WATER), []);
});

/* ---------------- hourly wind ---------------- */
test('windAt interpolates the direction as a vector across north', () => {
  /* Averaging 350 and 010 as plain numbers gives 180, the exact opposite. */
  setWind({ '2026-09-01': { hours: [{ m: 0, dir: 350, kt: 10 }, { m: 60, dir: 10, kt: 10 }] } });
  const w = M.windAt('2026-09-01', 30);
  assert.ok(w.dir === 0 || w.dir === 360, `expected north, got ${w.dir}`);
});

test('windAt interpolates speed linearly', () => {
  setWind({ '2026-09-01': { hours: [{ m: 0, kt: 6 }, { m: 60, kt: 12 }] } });
  near(M.windAt('2026-09-01', 30).kt, 9);
});

test('windAt clamps below the first row and above the last', () => {
  setWind({ '2026-09-01': { hours: [{ m: 300, kt: 6 }, { m: 360, kt: 12 }] } });
  assert.equal(M.windAt('2026-09-01', 0).kt, 6);
  assert.equal(M.windAt('2026-09-01', 1400).kt, 12);
});

test('windAt tolerates a null on either side of a gap', () => {
  setWind({ '2026-09-01': { hours: [{ m: 0, kt: 6, gust: null }, { m: 60, kt: 12, gust: 20 }] } });
  const w = M.windAt('2026-09-01', 30);
  assert.equal(w.gust, 20);
});

test('windAt takes the worse of the two thunder readings', () => {
  setWind({ '2026-09-01': { hours: [{ m: 0, kt: 6, thunder: 5 }, { m: 60, kt: 6, thunder: 40 }] } });
  assert.equal(M.windAt('2026-09-01', 30).thunder, 40);
});

test('windAt returns null when the date has no forecast', () => {
  setWind({ '2026-09-01': null, '2026-09-02': { hours: [] } });
  assert.equal(M.windAt('2026-09-01', 720), null);
  assert.equal(M.windAt('2026-09-02', 720), null);
  assert.equal(M.windAt('2099-01-01', 720), null);
});

/* ---------------- geometry ---------------- */
test('angDiff takes the short way round', () => {
  assert.equal(M.angDiff(10, 350), 20);
  assert.equal(M.angDiff(0, 180), 180);
  assert.equal(M.angDiff(90, 90), 0);
});

test('nearestPoint snaps to the sixteen compass points', () => {
  assert.equal(M.nearestPoint(0), 0);
  assert.equal(M.nearestPoint(20), 22.5);
  assert.equal(M.nearestPoint(359), 0);
  assert.equal(M.nearestPoint(200), 202.5);
});

/* ---------------- the forecast reader ---------------- */
const got = s => M.parseForecast(s).got;

test('reads an abbreviated marine forecast', () => {
  const g = got('SW winds 10 to 15 kt. Seas 2 ft.');
  assert.equal(g.winddir, 225);
  assert.equal(g.windlo, 10);
  assert.equal(g.windhi, 15);
});

test('reads a worded NWS point forecast and converts mph to knots', () => {
  const g = got('North northwest wind 8 to 14 mph.');
  assert.equal(g.winddir, 337.5);
  assert.equal(g.windlo, 7);
  assert.equal(g.windhi, 12);
  assert.ok(M.parseForecast('North northwest wind 8 to 14 mph.').notes
    .includes('mph converted to kt'));
});

test('a knot forecast is left in knots', () => {
  const g = got('South wind 10 to 15 kt.');
  assert.equal(g.windlo, 10);
  assert.equal(g.windhi, 15);
});

test('reads a METAR wind group with a gust', () => {
  const g = got('KNYC 011551Z 24012G20KT 10SM FEW045 24/17 A3005');
  assert.equal(g.winddir, 247.5);
  assert.equal(g.windlo, 12);
  assert.equal(g.windhi, 20);
  assert.ok(M.parseForecast('KNYC 011551Z 24012G20KT 10SM').notes.includes('METAR line'));
});

test('a variable METAR wind gives a speed but no direction', () => {
  const g = got('KNYC 011551Z VRB05KT 10SM CLR');
  assert.equal(g.winddir, undefined);
  assert.equal(g.windlo, 5);
});

test('a gust overrides the top of a range', () => {
  const g = got('SW winds 10 to 15 kt, gusting to 25 kt.');
  assert.equal(g.windhi, 25);
});

test('the top of a range is never below the bottom', () => {
  const g = got('SW winds 15 to 10 kt.');
  assert.ok(g.windhi >= g.windlo);
});

test('reads the shift, the sky, the visibility and a warning', () => {
  const g = got('Small Craft Advisory. S winds 15 kt becoming W. '
    + 'Areas of fog. Visibility 0.5 nm. Chance of thunderstorms likely.');
  assert.equal(g.advisory, 'Small Craft Advisory');
  assert.equal(g.sky, 'Fog or haze');
  assert.equal(g.vis, 'Poor, less than 1 nm');
  assert.equal(g.storm, 'Likely in the window');
});

test('the visibility bands meet at 1 nm and at 5 nm', () => {
  assert.equal(got('Visibility 0.9 nm.').vis, 'Poor, less than 1 nm');
  assert.equal(got('Visibility 1 nm.').vis, 'Moderate, 1 to 5 nm');
  assert.equal(got('Visibility 5 nm.').vis, 'Moderate, 1 to 5 nm');
  assert.equal(got('Visibility 10 nm.').vis, 'Good, more than 5 nm');
});

test('a veer and a back are read from becoming', () => {
  assert.equal(got('S winds 10 kt becoming W.').shift, 'Veers, clockwise');
  assert.equal(got('W winds 10 kt becoming S.').shift, 'Backs, anticlockwise');
});

test('a marine zone in the text names the source', () => {
  assert.equal(got('ANZ338 New York Harbor. SW winds 10 kt.').fcstsrc, 'NWS marine ANZ338');
});

test('text with no weather in it returns nothing rather than guessing', () => {
  const g = got('The dock gate code is 4321. Bring the tiller extension.');
  assert.equal(g.winddir, undefined);
  assert.equal(g.windlo, undefined);
  assert.equal(g.sky, undefined);
});

test('an empty string is safe', () => {
  assert.deepEqual(M.parseForecast('').got, {});
});
