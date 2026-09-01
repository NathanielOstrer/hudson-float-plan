"use strict";
/* The page: state, the forecast form, analysis and rendering. The pure model
   lives in model.js, which build.py concatenates ahead of this file. */
const $ = s => document.querySelector(s);

/* ---------------- data ---------------- */
/* The whole feed is one file, rebuilt every three hours by a GitHub Action and
   committed to the repo. Fetch it once, then a date change is a lookup. */
let BUNDLE = null;

async function loadBundle() {
  document.body.classList.add('loading');
  try {
    const r = await fetch('data/conditions.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    BUNDLE = await r.json();
    Object.assign(WATER, BUNDLE.water || {});
    Object.assign(WIND, BUNDLE.wind || {});
    clampDateInput();
  } catch (e) {
    BUNDLE = null;
  } finally {
    document.body.classList.remove('loading');
  }
  renderBuildLine();
}

/* The file covers a fixed window. Hold the picker inside it, and keep a day of
   overhang at each end, because timeline() reads the day before and the day
   after the sail date. */
function clampDateInput() {
  const dates = (BUNDLE && BUNDLE.waterDates) || [];
  if (dates.length < 3) return;
  const el = $('#f-date');
  el.min = dates[1];
  el.max = dates[dates.length - 2];
  if (el.value && el.value < el.min) el.value = el.min;
  if (el.value && el.value > el.max) el.value = el.max;
  state.date = el.value;
}

function loadDay(ds) {
  if (!ds) return;
  readDay(ds);
  autofillWind(ds);
  render();
}

/* A static site can go quiet without saying so. If the workflow stops, the page
   keeps serving old numbers, so say how old they are. */
function renderBuildLine() {
  const line = $('#buildline');
  if (!line) return;
  if (!BUNDLE || !BUNDLE.generated) {
    line.className = 'fcstline stale';
    line.textContent = 'The data did not load. Reload the page. Do not sail on this plan.';
    return;
  }
  const ageMin = Math.round((Date.now() - new Date(BUNDLE.generated).getTime()) / 60000);
  if (ageMin <= 360) { line.className = 'fcstline'; line.textContent = ''; line.hidden = true; return; }
  line.hidden = false;
  line.className = 'fcstline stale';
  line.textContent = 'The data is ' + Math.round(ageMin / 60) + ' hours old. '
    + 'The page updates every 3 hours. Check the NOAA and NWS forecasts before you cast off.';
}
/* ---------------- state ---------------- */
const FIELDS = ['date', 'depart', 'return', 'winddir', 'windlo', 'windhi', 'shift', 'sky', 'vis',
  'airtemp', 'watertemp', 'storm', 'advisory', 'fcsttime', 'fcstsrc'];
const KEY = 'hudson-float-plan-v1';
let state = {};

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign({}, JSON.parse(raw));
  } catch (e) { /* private mode, blocked storage: carry on with defaults */ }
}
function saveState() {
  FIELDS.forEach(f => { const el = $('#f-' + f); if (el) state[f] = el.value; });
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { }
}
function applyState() {
  FIELDS.forEach(f => { const el = $('#f-' + f); if (el && state[f] != null) el.value = state[f]; });
}

/* ---------------- checklists ---------------- */

function applyForecast() {
  const box = $('#f-paste'), out = $('#readback');
  const raw = box.value.trim();
  out.classList.remove('hit', 'miss');
  if (!raw) {
    out.textContent = 'Use this when you trust another source, or when the date is beyond the NWS forecast. The page reads a marine forecast, a point forecast, a METAR line or a Windfinder row.';
    state.paste = '';
    autofillWind($('#f-date').value);
    render();
    return;
  }
  const { got, notes } = parseForecast(raw);
  if (got.winddir === undefined && got.windlo === undefined) {
    out.classList.add('miss');
    out.textContent = 'No wind found in that text. Give the values in the fields below.';
    return;
  }
  const OWNED = ['winddir', 'windlo', 'windhi', 'shift', 'sky', 'vis', 'airtemp',
    'watertemp', 'storm', 'advisory', 'fcstsrc'];
  OWNED.forEach(id => { const el = $('#f-' + id); if (el) { el.value = ''; state[id] = ''; } });
  const setField = (id, val) => {
    if (val === undefined) return;
    const el = $('#f-' + id);
    if (!el) return;
    el.value = String(val);
    state[id] = el.value;
  };
  Object.keys(got).forEach(k => { if (k[0] !== '_') setField(k, got[k]); });
  $('#f-fcsttime').value = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date());
  state.fcsttime = $('#f-fcsttime').value;
  const line = $('#fcstline');
  line.className = 'fcstline';
  line.textContent = 'A pasted forecast is in use. Clear the box below to go back to the NWS forecast.';

  const read = [];
  if (got.winddir !== undefined) read.push('wind from ' + compass(got.winddir));
  if (got.windlo !== undefined && got.windhi !== undefined && !got._gust) read.push(got.windlo + ' to ' + got.windhi + ' kt');
  else {
    if (got.windlo !== undefined) read.push(got.windlo + ' kt');
    if (got.windhi !== undefined) read.push('gusts to ' + got.windhi + ' kt');
  }
  if (got.shift) read.push('the wind ' + got.shift.split(',')[0].toLowerCase());
  if (got.sky) read.push(got.sky.toLowerCase());
  if (got.vis) read.push('visibility ' + got.vis.toLowerCase());
  if (got.storm) read.push('thunderstorms ' + got.storm.toLowerCase());
  if (got.advisory) read.push(got.advisory);
  if (got.watertemp !== undefined) read.push('water ' + got.watertemp + '°F');
  out.classList.add('hit');
  out.textContent = 'The page read: ' + read.join(', ') + '.' + (notes.length ? ' (' + notes.join('; ') + ')' : '');
  saveState();
  render();
}

/* ---------------- analysis ---------------- */
function readInputs() {
  const ds = $('#f-date').value;
  let dep = toMin($('#f-depart').value), ret = toMin($('#f-return').value);
  const ok = !!(ds && dayEvents(ds).length && dep !== null && ret !== null);
  if (ret !== null && dep !== null && ret <= dep) ret = dep + 60;
  const wd = $('#f-winddir').value === '' ? null : +$('#f-winddir').value;
  const lo = $('#f-windlo').value === '' ? null : +$('#f-windlo').value;
  const hi = $('#f-windhi').value === '' ? null : +$('#f-windhi').value;
  return { ds, dep, ret, ok, windDir: wd, windLo: lo, windHi: hi };
}

function analyze() {
  const I = readInputs();
  if (!I.ok) return { I, valid: false };
  const tl = timeline(I.ds);
  const step = 5, samples = [];
  for (let m = I.dep; m <= I.ret; m += step) samples.push({ m, v: currentAt(tl, m) });
  const slacks = tl.filter(e => e.type === 's' && e.m > I.dep + 10 && e.m < I.ret - 10);
  const maxes = tl.filter(e => e.type !== 's' && e.m >= I.dep && e.m <= I.ret);
  let peak = 0, peakAt = I.dep;
  samples.forEach(s => { if (Math.abs(s.v) > Math.abs(peak)) { peak = s.v; peakAt = s.m; } });
  const vStart = currentAt(tl, I.dep), vEnd = currentAt(tl, I.ret);

  /* phases: split the window at each slack */
  const bounds = [I.dep, ...slacks.map(s => s.m), I.ret];
  const phases = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const mid = (bounds[i] + bounds[i + 1]) / 2;
    const v = currentAt(tl, mid);
    let pk = 0;
    samples.filter(s => s.m >= bounds[i] && s.m <= bounds[i + 1])
      .forEach(s => { if (Math.abs(s.v) > Math.abs(pk)) pk = s.v; });
    phases.push({ from: bounds[i], to: bounds[i + 1], v, peak: pk, dir: v > 0 ? 1 : -1 });
  }

  /* hour-by-hour rows */
  const rows = [];
  const first = Math.ceil(I.dep / 30) * 30;
  const marks = [I.dep];
  for (let m = first; m < I.ret; m += 30) if (m > I.dep) marks.push(m);
  marks.push(I.ret);
  marks.forEach(m => {
    const v = currentAt(tl, m);
    const w = windAt(I.ds, m);
    const dir = w && w.dir != null ? w.dir : I.windDir;
    let opp = null;
    if (dir === null || dir === undefined) opp = null;
    else if (Math.abs(v) <= 0.4) opp = 'weak';
    else opp = angDiff((dir + 180) % 360, setDir(v)) > 130;
    rows.push({ m, v, opp, w, dir: dir == null ? null : dir });
  });

  const sunset = sunEvent(I.ds, true), sunrise = sunEvent(I.ds, false);
  return { I, valid: true, tl, samples, slacks, maxes, phases, peak, peakAt, vStart, vEnd, rows, sunset, sunrise };
}

/* the plan, written as instructions */
function buildPlan(A) {
  const { I, phases, slacks } = A;
  const axis = d => d > 0 ? 'up-river' : 'down-river';
  const toward = d => d > 0 ? 'toward Pier 86 and the 79th St Basin' : 'toward Pier 40 and the Battery';
  let lead, why, steps = [], leash = false;

  if (phases.length === 1) {
    const p = phases[0];
    const out = -p.dir;                       /* go against it while the crew is fresh */
    const bs = boatSpeed(I), pk = Math.abs(p.peak), w = I.windLo ?? I.windHi;
    if (bs !== null && bs < pk + 0.5) {
      const margin = bs - pk;
      lead = 'Stay near the dock. You cannot sail back against this ' + setName(p.v) + '.';
      why = 'The ' + setName(p.v) + ' runs for the full window. The peak is ' + pk.toFixed(1) + ' kt. ' +
        'A wind of ' + w + ' kt gives you about ' + bs.toFixed(1) + ' kt through the water. ' +
        'At the peak you have ' + (margin <= 0 ? 'no headway against the current' : 'about ' + margin.toFixed(1) + ' kt of headway against the current') +
        '. You cannot sail back past the point the river carries you to.';
      leash = true;
      steps.push([hhmm(I.dep), 'Cast off. Stay <em>' + axis(out) + '</em> of the dock. Keep inshore of the pier line, in the weaker current.']);
      steps.push([hhmm(Math.round((I.dep + I.ret) / 2)), 'Check your position against the pier numbers. If you are down-tide of Pier 66, come back now.']);
      steps.push([hhmm(I.ret), 'Come alongside. Approach into the ' + setName(p.v) + '.']);
    } else {
      lead = 'Sail ' + axis(out) + ' first. Ride the ' + setName(p.v) + ' home.';
      why = 'The ' + setName(p.v) + ' runs for the full window. The peak is ' + pk.toFixed(1) + ' kt. ' +
        'The current does not turn while you are out. Push against it while the crew is fresh. The current then carries you home.';
      steps.push([hhmm(I.dep), 'Cast off. Go <em>' + axis(out) + '</em>, ' + toward(out) + '.']);
      steps.push([hhmm(Math.max(I.dep + 15, Math.round((I.dep + I.ret) / 2 - 15))), 'Turn back at this time, or earlier. From here the current is behind you, so the leg home is the fast one.']);
      steps.push([hhmm(I.ret), 'Come alongside. Approach into the ' + setName(p.v) + '.']);
    }
  } else if (phases.length === 2) {
    const a = phases[0], b = phases[1], T = slacks[0].m;
    lead = 'Go ' + axis(a.dir) + ' on the ' + setName(a.v) + '. Turn at slack water at ' + hhmm(T) + '. Ride the ' + setName(b.v) + ' home.';
    why = 'The current turns inside your window. Go out with it. Turn at slack water. The new ' + setName(b.v) +
      ' then pushes you back to Pier 66. Both legs run downstream.';
    steps.push([hhmm(I.dep), 'Cast off. Go <em>' + axis(a.dir) + '</em>, ' + toward(a.dir) + '. The ' + setName(a.v) + ' gives you up to ' + Math.abs(a.peak).toFixed(1) + ' kt.']);
    if (T - 20 > I.dep + 10) steps.push([hhmm(T - 20), 'Turn back. The current is weak from this time.']);
    steps.push([hhmm(T), 'Slack water. Turn here.']);
    steps.push([hhmm(I.ret), 'Come alongside. The ' + setName(b.v) + ' gives you up to ' + Math.abs(b.peak).toFixed(1) + ' kt. Approach into it.']);
  } else {
    lead = 'The current turns ' + slacks.length + ' times in your window.';
    why = 'The window is too long for one strategy. Plan each leg around the slack times below.';
    steps.push([hhmm(I.dep), 'Cast off on the ' + setName(phases[0].v) + '. Go <em>' + axis(phases[0].dir) + '</em>.']);
    slacks.forEach((sl, i) => steps.push([hhmm(sl.m),
      'Slack water. The current turns to ' + setName(phases[i + 1].v) + '. It sets <em>' + axis(phases[i + 1].dir) + '</em>, up to ' + Math.abs(phases[i + 1].peak).toFixed(1) + ' kt.']));
    steps.push([hhmm(I.ret), 'Come alongside.']);
  }

  /* what the wind does to the leg out */
  const outDir = phases.length === 1 ? -phases[0].dir : phases[0].dir;
  const outCourse = outDir > 0 ? FLOOD : EBB;
  if (I.windDir !== null && !leash) {
    const d = angDiff(I.windDir, outCourse);
    if (d < 50) why += ' The wind is from ' + compass(I.windDir) + '. The leg out is a beat. You run home.';
    else if (d < 115) why += ' The wind is from ' + compass(I.windDir) + '. The leg out is a reach. You reach home.';
    else why += ' The wind is from ' + compass(I.windDir) + '. The leg out is a run. You must beat home.';
  }
  return { lead, why, steps, outDir, outCourse, leash };
}

/* the speed a club keelboat makes through the water in a given wind */
function boatSpeed(I) {
  const w = I.windLo ?? I.windHi;
  if (w == null) return null;
  return Math.min(5.5, 0.9 + 0.38 * w);
}

function compass(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/* go or no-go */
function buildFlags(A) {
  const { I } = A, out = [];
  const add = (k, t) => out.push({ k, t });
  const wind = I.windHi ?? I.windLo;

  if (A.sunset != null) {
    if (I.ret > A.sunset) add('stop', 'Move the window earlier, or make the sail shorter. You are back at ' + hhmm(I.ret) + '. Sunset is at ' + hhmm(A.sunset) + '.');
    else if (A.sunset - I.ret < 45) add('caution', 'Add margin to the window. Only ' + Math.round(A.sunset - I.ret) + ' minutes separate your return from sunset at ' + hhmm(A.sunset) + '.');
  }
  if ($('#f-storm').value === 'Likely in the window') add('stop', 'Do not go. Thunderstorms are in the forecast for your window. The Hudson gives no shelter, and a squall arrives faster than you can get back.');
  else if ($('#f-storm').value === 'Possible later') add('caution', 'Set a hard turn-back time. Thunderstorms are possible later. Watch the sky to the west.');
  const adv = $('#f-advisory').value;
  if (adv === 'Gale Warning' || adv === 'Special Marine Warning') add('stop', 'Do not go. A ' + adv + ' is in force.');
  else if (adv === 'Small Craft Advisory') add('caution', 'Speak to the dock first. A Small Craft Advisory is in force.');
  const vis = $('#f-vis').value;
  if (vis.startsWith('Poor')) add('stop', 'Do not go. Visibility is less than 1 nm. Ferries and tugs cannot see you, and they cannot stop for you.');
  else if (vis.startsWith('Moderate')) add('caution', 'Stay out of the channel. Visibility is reduced. Keep a lookout astern.');
  if (wind != null) {
    if (wind >= 25) add('stop', 'Do not go. ' + wind + ' kt is above the limit for a club keelboat and a new crew.');
    else if (wind >= 20) add('caution', 'Reef at the dock. ' + wind + ' kt needs a crew with experience in this wind.');
  }
  if (Math.abs(A.peak) >= 3) add('note', 'The peak current is ' + Math.abs(A.peak).toFixed(1) + ' kt ' + setName(A.peak) + ' at ' + hhmm(A.peakAt) + '. On the Hudson the ebb is stronger and longer than the flood.');
  if (I.windLo != null && I.windLo <= 8 && Math.abs(A.peak) >= 2)
    add('caution', 'Plan each leg with the current behind you. A wind of ' + I.windLo + ' kt cannot push you against ' + Math.abs(A.peak).toFixed(1) + ' kt of current.');
  const oppHours = A.rows.filter(r => r.opp === true);
  if (oppHours.length) {
    const a0 = oppHours[0].m, a1 = oppHours[oppHours.length - 1].m;
    add('caution', 'Expect short steep chop ' + (a0 === a1 ? 'at ' + hhmm(a0) : 'from ' + hhmm(a0) + ' to ' + hhmm(a1)) + '. The wind opposes the current.');
  }
  const wt = $('#f-watertemp').value;
  if (wt !== '' && +wt < 60) add('caution', 'Every person must wear a PFD. The water is ' + wt + '&deg;F, and it takes the use of your hands quickly.');
  if (!out.some(f => f.k === 'stop' || f.k === 'caution')) add('clear', 'No entry on this page stops the sail. Take the go or no-go decision from the dock.');
  return out;
}

function sailPlan(I) {
  const hi = I.windHi ?? I.windLo, lo = I.windLo ?? I.windHi;
  if (hi == null) return null;
  const spread = (I.windHi != null && I.windLo != null && I.windHi - I.windLo >= 8)
    ? ' The lulls are ' + lo + ' kt and the gusts are ' + hi + ' kt. This is squally. Rig for the gusts. Expect low power between them.' : '';
  if (hi < 6) return ['Use the full main and the large headsail',
    'The current moves you more than the wind does. Plan this sail around the current.' + spread];
  if (hi < 12) return ['Use the full main and the full headsail',
    'These are comfortable conditions for a club keelboat. Keep the crew weight inboard and forward in the lulls.' + spread];
  if (hi < 16) return ['Use the full main, and flatten it',
    'The boat is powered up. Put the backstay on. Pull the outhaul hard. Put the crew weight on the rail before you need it. Use the small headsail if you have one.' + spread];
  if (hi < 21) return ['Reef the main at the dock',
    'Do not reef under way with a new crew. Put the reef in before you cast off.' + spread];
  return ['Reef the main. Use the smallest headsail. Ask the dock first',
    'Gusts to ' + hi + ' kt are at or above the limit for a club keelboat.' + spread];
}

function windCell(r) {
  if (r.w && r.w.kt != null) {
    const g = r.w.gust != null && r.w.gust - r.w.kt >= 3 ? ' g' + Math.round(r.w.gust) : '';
    return (r.dir != null ? compass(r.dir) + ' ' : '') + Math.round(r.w.kt) + ' kt' + g;
  }
  if (r.dir != null) return compass(r.dir);
  return 'not given';
}

/* Fill the wind fields from the forecast across the sail window. The skipper
   can still edit any of them, and a pasted forecast overrides all of them. */
function autofillWind(ds) {
  const w = WIND[ds], line = $('#fcstline');
  const dep = toMin($('#f-depart').value), ret = toMin($('#f-return').value);
  if (!w || !w.hours || !w.hours.length) {
    /* The whole feed is one file. If it loaded, a date with no wind is a date
       past the NWS horizon. If it did not load, nothing works, and the banner
       under the masthead already says so. */
    line.className = 'fcstline none';
    line.textContent = BUNDLE
      ? 'The wind forecast does not reach that date. It reaches about 8 days ahead. Give the wind values yourself, or paste a forecast below.'
      : 'The forecast did not load. Reload the page, or give the wind values yourself.';
    return;
  }
  if (state.paste) { line.className = 'fcstline'; line.textContent = 'A pasted forecast is in use. Clear it below to go back to the NWS forecast.'; return; }
  const inWindow = w.hours.filter(h => dep === null || ret === null || (h.m >= dep - 60 && h.m <= ret + 60));
  const rows = inWindow.length ? inWindow : w.hours;

  let sx = 0, sy = 0, wsum = 0, lo = null, hi = null, sky = 0, thunder = 0, vis = null, temp = null;
  rows.forEach(h => {
    if (h.dir != null && h.kt != null) {
      const r = h.dir * Math.PI / 180;
      sx += Math.cos(r) * (h.kt + 0.5); sy += Math.sin(r) * (h.kt + 0.5); wsum += h.kt + 0.5;
    }
    if (h.kt != null) { lo = lo === null ? h.kt : Math.min(lo, h.kt); hi = Math.max(hi ?? 0, h.kt); }
    if (h.gust != null) hi = Math.max(hi ?? 0, h.gust);
    if (h.sky != null) sky = Math.max(sky, h.sky);
    if (h.thunder != null) thunder = Math.max(thunder, h.thunder);
    if (h.visNm != null) vis = vis === null ? h.visNm : Math.min(vis, h.visNm);
    if (h.tempF != null) temp = temp === null ? h.tempF : temp;
  });
  const set = (id, val) => { const el = $('#f-' + id); if (el && val !== null && val !== undefined) { el.value = String(val); state[id] = el.value; } };
  if (wsum > 0) {
    const deg = ((Math.atan2(sy, sx) * 180 / Math.PI) % 360 + 360) % 360;
    set('winddir', Math.round(deg / 22.5) % 16 * 22.5);
  }
  if (lo !== null) set('windlo', Math.round(lo));
  if (hi !== null) set('windhi', Math.round(hi));
  set('sky', sky >= 88 ? 'Overcast' : sky >= 38 ? 'Partly cloudy' : 'Clear');
  set('storm', thunder >= 30 ? 'Likely in the window' : thunder >= 10 ? 'Possible later' : '');
  if (vis !== null) set('vis', vis < 1 ? 'Poor, less than 1 nm' : vis <= 5 ? 'Moderate, 1 to 5 nm' : 'Good, more than 5 nm');
  if (temp !== null) set('airtemp', Math.round(temp));
  set('fcstsrc', w.source || 'NWS');

  if (w.issued) {
    const issued = new Date(w.issued);
    const ageMin = Math.round((Date.now() - issued.getTime()) / 60000);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(issued);
    set('fcsttime', clock);
    const age = ageMin < 90 ? ageMin + ' minutes old' : Math.round(ageMin / 60) + ' hours old';
    line.className = 'fcstline ' + (ageMin > 720 ? 'stale' : 'live');
    line.textContent = 'The wind comes from the NWS forecast for Pier 66, issued at ' + clock + '. It is ' + age + '.';
  } else {
    line.className = 'fcstline live';
    line.textContent = 'The wind comes from the NWS forecast for Pier 66.';
  }
  saveState();
}

/* ---------------- rendering ---------------- */
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function renderWindow(A) {
  const dl = $('#ro-window'); dl.innerHTML = '';
  const put = (t, v, sub) => {
    const d = document.createElement('div'); d.className = 'ro';
    const dt = document.createElement('dt'); dt.textContent = t;
    const dd = document.createElement('dd'); dd.textContent = v;
    if (sub) { const s = document.createElement('small'); s.textContent = ' ' + sub; dd.appendChild(s); }
    d.append(dt, dd); dl.appendChild(d);
  };
  if (!A.valid) { put('Status', 'None', 'give a date and the times'); return; }
  put('Time on the water', ((A.I.ret - A.I.dep) / 60).toFixed(1), 'hrs');
  if (A.sunrise != null) put('Sunrise', hhmm(A.sunrise));
  if (A.sunset != null) put('Sunset', hhmm(A.sunset));
  if (A.sunset != null) {
    const marg = Math.round(A.sunset - A.I.ret);
    put('Spare daylight', (marg >= 0 ? '' : '−') + Math.floor(Math.abs(marg) / 60) + 'h' + pad(Math.abs(marg) % 60));
  }
}

function renderTideEvents(A) {
  const box = $('#tide-events'); box.innerHTML = '';
  if (!A.valid) {
    const ds = $('#f-date').value;
    box.innerHTML = '<p style="margin:0;font-size:13.5px;color:var(--muted)">' +
      (ds && WATER[ds] === null ? 'NOAA did not answer for that date. Try again, or select another date.'
        : 'Give a date and the times. The page then reads the predictions from NOAA.') + '</p>';
    $('#src-current').textContent = 'NOAA';
    return;
  }
  $('#src-current').textContent = 'NOAA NYH1928 / 8518750';
  const mk = (title, items) => {
    const h = document.createElement('p');
    h.style.cssText = 'margin:12px 0 0;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600';
    h.textContent = title;
    const row = document.createElement('div'); row.className = 'evrow';
    items.forEach(([cls, t, label]) => {
      const s = document.createElement('span'); s.className = 'ev ' + cls;
      const a = document.createElement('span'); a.className = 't'; a.textContent = t;
      const b = document.createElement('span'); b.textContent = label;
      s.append(a, b); row.appendChild(s);
    });
    box.append(h, row);
  };
  const tides = dayTides(A.I.ds);
  if (tides.length) {
    mk('Tide at the Battery', tides.map(t =>
      ['slack', hhmm(t.m), (t.type === 'H' ? 'high ' : 'low ') + t.ft + ' ft']));
  }
  const evs = dayEvents(A.I.ds);
  if (evs.length) {
    mk('Current at Pier 92', evs.map(e => {
      const cls = e.type === 'f' ? 'flood' : e.type === 'e' ? 'ebb' : 'slack';
      const label = e.type === 's' ? 'slack'
        : (e.type === 'f' ? 'max flood ' : 'max ebb ') + e.v.toFixed(1) + ' kt';
      return [cls, hhmm(e.m), label];
    }));
  }
}

function renderStrip(A) {
  const el = $('#strip'); el.innerHTML = '';
  const box = el.parentElement.getBoundingClientRect().width;
  const W = Math.max(300, Math.round(box) || 660), H = 190, L = 44, R = W - 12, CY = 92, HH = 58;
  el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const cap = $('#strip-cap');
  if (!A.valid) {
    el.appendChild(svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' }));
    el.appendChild(svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: cssVar('--faint'), 'font-size': 14, 'font-family': 'Public Sans, sans-serif' }, 'The current in your sail window shows here'));
    cap.textContent = '';
    return;
  }
  const t0 = A.I.dep - 25, t1 = A.I.ret + 25, span = t1 - t0;
  const x = m => L + (m - t0) / span * (R - L);
  const maxV = Math.max(1.2, Math.abs(A.peak) * 1.15);
  const y = v => CY - v / maxV * HH;
  const line = cssVar('--line'), line2 = cssVar('--line-2'), muted = cssVar('--muted'), faint = cssVar('--faint');
  const cf = cssVar('--flood'), ce = cssVar('--ebb'), acc = cssVar('--accent');
  const F = 'IBM Plex Mono, monospace';

  /* half-hour grid */
  for (let m = Math.ceil(t0 / 30) * 30; m <= t1; m += 30) {
    const hour = m % 60 === 0;
    el.appendChild(svg('line', { x1: x(m), y1: 16, x2: x(m), y2: CY + HH + 8, stroke: hour ? line : line2, 'stroke-width': 1 }));
    if (hour) el.appendChild(svg('text', { x: x(m), y: CY + HH + 22, 'text-anchor': 'middle', fill: faint, 'font-size': 11, 'font-family': F }, hhmm(m)));
  }
  /* speed guides */
  [1, 2, 3].forEach(k => {
    if (k > maxV) return;
    [1, -1].forEach(s => {
      el.appendChild(svg('line', { x1: L, y1: y(k * s), x2: R, y2: y(k * s), stroke: line2, 'stroke-dasharray': '2 4', 'stroke-width': 1 }));
    });
    el.appendChild(svg('text', { x: L - 6, y: y(k) + 4, 'text-anchor': 'end', fill: faint, 'font-size': 10, 'font-family': F }, k + 'kt'));
    el.appendChild(svg('text', { x: L - 6, y: y(-k) + 4, 'text-anchor': 'end', fill: faint, 'font-size': 10, 'font-family': F }, k + 'kt'));
  });

  /* filled curve, split by sign */
  const pts = [];
  for (let m = t0; m <= t1; m += 3) pts.push([m, currentAt(A.tl, m) || 0]);
  let seg = [];
  const flush = () => {
    if (seg.length < 2) { seg = []; return; }
    const up = seg[Math.floor(seg.length / 2)][1] > 0;
    let d = 'M ' + x(seg[0][0]).toFixed(1) + ' ' + CY;
    seg.forEach(p => { d += ' L ' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); });
    d += ' L ' + x(seg[seg.length - 1][0]).toFixed(1) + ' ' + CY + ' Z';
    el.appendChild(svg('path', { d, fill: up ? cf : ce, 'fill-opacity': .22, stroke: up ? cf : ce, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    seg = [];
  };
  pts.forEach((p, i) => {
    if (i && Math.sign(p[1]) !== Math.sign(pts[i - 1][1]) && Math.abs(p[1]) > 0.02) { seg.push([p[0], 0]); flush(); }
    seg.push(p);
  });
  flush();

  /* centreline + axis labels */
  el.appendChild(svg('line', { x1: L, y1: CY, x2: R, y2: CY, stroke: muted, 'stroke-width': 1.2 }));
  el.appendChild(svg('text', { x: L, y: 13, fill: cf, 'font-size': 10.5, 'font-weight': 600, 'font-family': F, 'letter-spacing': '.06em' }, '▲ FLOOD · UP-RIVER'));
  el.appendChild(svg('text', { x: R, y: 13, 'text-anchor': 'end', fill: ce, 'font-size': 10.5, 'font-weight': 600, 'font-family': F, 'letter-spacing': '.06em' }, 'EBB · DOWN-RIVER ▼'));

  /* slack markers */
  A.tl.filter(e => e.type === 's' && e.m > t0 && e.m < t1).forEach(e => {
    el.appendChild(svg('line', { x1: x(e.m), y1: 20, x2: x(e.m), y2: CY + HH, stroke: muted, 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
    el.appendChild(svg('text', { x: x(e.m), y: 31, 'text-anchor': 'middle', fill: muted, 'font-size': 10.5, 'font-family': F }, 'slack ' + hhmm(e.m)));
  });

  /* window ends */
  [[A.I.dep, 'CAST OFF'], [A.I.ret, 'BACK']].forEach(([m, lab]) => {
    el.appendChild(svg('line', { x1: x(m), y1: 8, x2: x(m), y2: CY + HH + 8, stroke: acc, 'stroke-width': 2 }));
    const tx = svg('text', { x: x(m) + (lab === 'BACK' ? -5 : 5), y: CY + HH + 2, fill: acc, 'font-size': 10, 'font-weight': 600, 'font-family': F, 'letter-spacing': '.07em', 'text-anchor': lab === 'BACK' ? 'end' : 'start' }, lab);
    el.appendChild(tx);
  });

  cap.textContent = 'This is the predicted current at Pier 92 in your sail window. Above the line, the current sets up-river. '
    + 'Below the line, it sets down-river. The peak is ' + Math.abs(A.peak).toFixed(1) + ' kt ' + setName(A.peak) + ' at ' + hhmm(A.peakAt) + '.';
}

function renderTable(A) {
  const tb = $('#tbl-current tbody'); tb.innerHTML = '';
  if (!A.valid) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" style="color:var(--muted);white-space:normal">Give the sail window. The page then shows the current and the wind every half hour.</td>';
    tb.appendChild(tr); return;
  }
  A.rows.forEach(r => {
    const tr = document.createElement('tr');
    if (r.opp === true) tr.className = 'opposing';
    const nm = setName(r.v);
    const arrow = nm === 'slack' ? '' : (r.v > 0 ? '↑ ' : '↓ ');
    const cells = [
      ['num', hhmm(r.m)],
      ['dir', arrow + nm + (nm === 'slack' ? '' : ' ' + String(setDir(r.v)).padStart(3, '0') + '°')],
      ['num', Math.abs(r.v).toFixed(1) + ' kt'],
      ['num', windCell(r)],
      ['txt', r.opp === null ? 'no wind data' : r.opp === 'weak' ? 'current weak' : (r.opp ? 'against, chop' : 'with')]
    ];
    cells.forEach(([k, v], i) => {
      const td = document.createElement('td');
      if (k === 'num') td.className = 'num';
      if (i === 1) { td.innerHTML = '<span class="dirmark ' + nm + '">' + v + '</span>'; }
      else td.textContent = v;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

function renderRose(A) {
  const el = $('#rose'); el.innerHTML = '';
  const txt = $('#rose-text');
  const C = 59, R = 44;
  const line = cssVar('--line'), faint = cssVar('--faint'), acc = cssVar('--accent');
  const cf = cssVar('--flood'), ce = cssVar('--ebb'), ink = cssVar('--ink');
  el.appendChild(svg('circle', { cx: C, cy: C, r: R, fill: 'none', stroke: line, 'stroke-width': 1 }));
  el.appendChild(svg('circle', { cx: C, cy: C, r: R - 12, fill: 'none', stroke: line, 'stroke-width': 1, 'stroke-dasharray': '2 4' }));
  ['N', 'E', 'S', 'W'].forEach((c, i) => {
    const a = i * 90 * Math.PI / 180;
    el.appendChild(svg('text', {
      x: C + Math.sin(a) * (R + 9), y: C - Math.cos(a) * (R + 9) + 4,
      'text-anchor': 'middle', fill: faint, 'font-size': 10, 'font-weight': 600, 'font-family': 'IBM Plex Mono, monospace'
    }, c));
  });
  const arrow = (deg, colour, len, w, dash) => {
    const a = deg * Math.PI / 180;
    const x2 = C + Math.sin(a) * len, y2 = C - Math.cos(a) * len;
    const x1 = C - Math.sin(a) * len * .45, y1 = C + Math.cos(a) * len * .45;
    el.appendChild(svg('line', Object.assign({ x1, y1, x2, y2, stroke: colour, 'stroke-width': w, 'stroke-linecap': 'round' }, dash ? { 'stroke-dasharray': dash } : {})));
    const hx = C + Math.sin(a) * (len - 8), hy = C - Math.cos(a) * (len - 8);
    const px = Math.cos(a) * 5, py = Math.sin(a) * 5;
    el.appendChild(svg('polygon', { points: [x2 + ',' + y2, (hx + px) + ',' + (hy + py), (hx - px) + ',' + (hy - py)].join(' '), fill: colour }));
  };
  const I = A.I;
  if (A.valid && Math.abs(A.vStart) > 0.15) arrow(setDir(A.vStart), A.vStart > 0 ? cf : ce, R - 6, 2.5);
  if (I.windDir !== null) arrow((I.windDir + 180) % 360, acc, R - 16, 2.5, '4 3');

  if (I.windDir === null) { txt.textContent = 'Select a wind direction. The page then compares it with the current at cast off.'; return; }
  if (!A.valid) { txt.textContent = 'The wind is from ' + compass(I.windDir) + '. Give the sail window to compare it with the current.'; return; }
  const nm = setName(A.vStart);
  if (nm === 'slack') { txt.innerHTML = 'The wind is from <strong>' + compass(I.windDir) + '</strong>. The current is slack at cast off.'; return; }
  const opp = angDiff((I.windDir + 180) % 360, setDir(A.vStart)) > 130;
  /* Name the arrow by its colour, because solid against dashed is hard to tell
     apart at this size. The current arrow takes --flood or --ebb, so the word
     has to follow the tide. Both hold their hue in the light and dark themes. */
  const hue = nm === 'flood' ? 'blue' : 'amber';
  txt.innerHTML = 'The ' + hue + ' arrow shows the ' + nm + '. It sets <strong>' + setDir(A.vStart) + '\u00B0</strong> at ' + hhmm(I.dep) +
    '. The pink dashed arrow shows where the wind pushes you. The wind is from ' + compass(I.windDir) + '. ' +
    (opp ? '<strong>The wind opposes the current.</strong> Wind against current makes short steep chop near the pier heads.'
      : 'The wind and the current agree. The water stays flatter than the wind speed shows.');
}

function renderRec(A) {
  const lead = $('#rec-lead'), why = $('#rec-why'), steps = $('#rec-steps'), flags = $('#rec-flags');
  steps.innerHTML = ''; flags.innerHTML = '';
  if (!A.valid) {
    lead.textContent = 'Give a date and a sail window.';
    why.textContent = 'The page calculates the plan from the NOAA current for that day and from the wind you give above.';
    return;
  }
  const P = buildPlan(A);
  lead.textContent = P.lead;
  why.innerHTML = P.why;
  P.steps.forEach(([w, t]) => {
    const li = document.createElement('li');
    const a = document.createElement('span'); a.className = 'when'; a.textContent = w;
    const b = document.createElement('span'); b.className = 'what'; b.innerHTML = t;
    li.append(a, b); steps.appendChild(li);
  });
  buildFlags(A).forEach(f => {
    const d = document.createElement('div'); d.className = 'flag-item ' + f.k;
    const t = document.createElement('span'); t.className = 'tag';
    t.textContent = { stop: 'stop', caution: 'warning', note: 'note', clear: 'clear' }[f.k];
    const s = document.createElement('span'); s.innerHTML = f.t;
    d.append(t, s); flags.appendChild(d);
  });
}

function renderSailPlan(A) {
  const box = $('#sailplan');
  if (!box) return;
  box.innerHTML = '';
  const sp = sailPlan(A.I);
  if (!sp) return;
  const d = document.createElement('div');
  d.className = 'flag-item note';
  d.style.marginTop = '12px';
  d.innerHTML = '<span class="tag">sail</span><span><strong>' + sp[0] + '.</strong> ' + sp[1] + '</span>';
  box.appendChild(d);
}

/* ---------------- wiring ---------------- */
let LAST = null;
function render() {
  const A = analyze();
  LAST = A;
  renderWindow(A); renderTideEvents(A); renderStrip(A); renderTable(A);
  renderRose(A); renderRec(A); renderSailPlan(A);
}

function init() {
  loadState();
  if (!state.date) {
    state.date = todayNY();
    state.depart = '13:00'; state.return = '16:00';
  }
  applyState();
  $('#f-paste').value = state.paste || '';
  $('#f-paste').addEventListener('input', () => {
    state.paste = $('#f-paste').value;
    applyForecast();
    saveState();
  });
  if (state.paste) applyForecast();
  FIELDS.forEach(f => {
    const el = $('#f-' + f);
    if (!el) return;
    const onChange = () => {
      saveState();
      if (f === 'date') { loadDay($('#f-date').value); }
      else if (f === 'depart' || f === 'return') { autofillWind($('#f-date').value); }
      render();
    };
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderStrip(LAST || analyze()), 120); });
  loadBundle().then(() => loadDay($('#f-date').value));
  render();
}
init();
