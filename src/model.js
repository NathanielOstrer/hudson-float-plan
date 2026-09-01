"use strict";
/* The pure model: time, sun, the tidal-current curve, the hourly wind and the
   forecast reader. No DOM in this file, so Node can load it and test it.
   WATER is keyed by date and holds tide and current. WIND holds the hourly
   forecast. Both are filled once, from docs/data/conditions.json. */
const FLOOD = 26, EBB = 212;
const LAT = 40.7513, LON = -74.0095;
const WATER = {}, WIND = {};
/* ---------------- time helpers (all wall-clock New York) ---------------- */
const pad = n => String(n).padStart(2, '0');
const hhmm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
const toMin = s => { const p = /^(\d{1,2}):(\d{2})/.exec(s || ''); return p ? +p[1] * 60 + +p[2] : null; };
function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function nyOffset(ds) {
  const d = new Date(ds + 'T16:00:00Z');
  const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' }).format(d);
  return (h - 16) * 60;
}
function prettyDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
/* ---------------- sun ---------------- */
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
/* NOAA solar-position spreadsheet, good to about a minute. Returns minutes past
   local midnight in New York, or null above the polar circles. */
function sunEvent(ds, sunset) {
  const [y, m, d] = ds.split('-').map(Number);
  const tz = nyOffset(ds) / 60;
  const jc = (julianDay(y, m, d) + 0.5 - tz / 24 - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc)
    + Math.sin(rad(3 * M)) * 0.000289;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const vy = Math.tan(rad(eps / 2)) ** 2;
  const eqt = 4 * deg(vy * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M))
    + 4 * e * vy * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * vy * vy * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const c = Math.cos(rad(90.833)) / (Math.cos(rad(LAT)) * Math.cos(rad(decl))) - Math.tan(rad(LAT)) * Math.tan(rad(decl));
  if (c > 1 || c < -1) return null;
  const ha = deg(Math.acos(c));
  const noon = 720 - 4 * LON - eqt + tz * 60;
  return Math.round(noon + (sunset ? ha : -ha) * 4);
}
function todayNY() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/* ---------------- current model ---------------- */
function dayEvents(ds) {
  const w = WATER[ds];
  return w && w.current ? w.current : [];
}
function dayTides(ds) {
  const w = WATER[ds];
  return w && w.tide ? w.tide : [];
}
/* A date outside the file reads as a failed load, which the page already
   handles. Mark it so dayEvents and windAt do not keep asking. */
function readDay(ds) {
  if (!ds) return;
  [addDays(ds, -1), ds, addDays(ds, 1)].forEach(d => {
    if (WATER[d] === undefined) WATER[d] = null;
  });
  if (WIND[ds] === undefined) WIND[ds] = null;
}

/* ---------------- hourly wind ---------------- */
function windAt(ds, minutes) {
  const w = WIND[ds];
  if (!w || !w.hours || !w.hours.length) return null;
  const rows = w.hours;
  let a = rows[0], b = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i++) {
    if (minutes >= rows[i].m && minutes <= rows[i + 1].m) { a = rows[i]; b = rows[i + 1]; break; }
  }
  if (minutes <= rows[0].m) return rows[0];
  if (minutes >= rows[rows.length - 1].m) return rows[rows.length - 1];
  const f = (minutes - a.m) / Math.max(1, b.m - a.m);
  const lerp = (x, y) => x == null ? y : (y == null ? x : x + (y - x) * f);
  /* directions are angles, so interpolate the vector, not the number */
  let dir = a.dir;
  if (a.dir != null && b.dir != null) {
    const ra = a.dir * Math.PI / 180, rb = b.dir * Math.PI / 180;
    const sx = Math.cos(ra) * (1 - f) + Math.cos(rb) * f;
    const sy = Math.sin(ra) * (1 - f) + Math.sin(rb) * f;
    dir = ((Math.atan2(sy, sx) * 180 / Math.PI) % 360 + 360) % 360;
  }
  return { m: minutes, dir: dir == null ? null : Math.round(dir),
    kt: lerp(a.kt, b.kt), gust: lerp(a.gust, b.gust),
    sky: lerp(a.sky, b.sky), thunder: Math.max(a.thunder ?? 0, b.thunder ?? 0),
    visNm: lerp(a.visNm, b.visNm), tempF: lerp(a.tempF, b.tempF) };
}
function timeline(ds) {
  const out = [];
  [[-1, -1440], [0, 0], [1, 1440]].forEach(([o, sh]) => {
    dayEvents(addDays(ds, o)).forEach(e => out.push({ m: e.m + sh, type: e.type, v: e.v }));
  });
  return out.sort((a, b) => a.m - b.m);
}
/* signed knots: + = flood (sets up-river 026), - = ebb (sets down-river 206) */
function currentAt(tl, m) {
  if (!tl.length) return null;
  let i = -1;
  for (let k = 0; k < tl.length - 1; k++) if (m >= tl[k].m && m <= tl[k + 1].m) { i = k; break; }
  if (i < 0) return null;
  const a = tl[i], b = tl[i + 1], span = b.m - a.m;
  if (span <= 0) return 0;
  const f = (m - a.m) / span;
  if (a.type === 's' && b.type !== 's') return (b.type === 'f' ? 1 : -1) * b.v * Math.sin(f * Math.PI / 2);
  if (a.type !== 's' && b.type === 's') return (a.type === 'f' ? 1 : -1) * a.v * Math.cos(f * Math.PI / 2);
  if (a.type === 's' && b.type === 's') return 0;
  const sa = (a.type === 'f' ? 1 : -1) * a.v, sb = (b.type === 'f' ? 1 : -1) * b.v;
  return sa + (sb - sa) * f;
}
const setDir = v => v >= 0 ? FLOOD : EBB;
const setName = v => Math.abs(v) < 0.15 ? 'slack' : (v > 0 ? 'flood' : 'ebb');
const upDown = v => v > 0 ? 'up-river' : 'down-river';

/* ---------------- geometry ---------------- */
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/* ---------------- forecast reader ---------------- */
const POINTS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
/* NWS point forecasts spell the direction out: "North northwest wind 8 to 14 mph" */
const WORDED = [['NORTH NORTHEAST', 22.5], ['EAST NORTHEAST', 67.5], ['EAST SOUTHEAST', 112.5],
  ['SOUTH SOUTHEAST', 157.5], ['SOUTH SOUTHWEST', 202.5], ['WEST SOUTHWEST', 247.5],
  ['WEST NORTHWEST', 292.5], ['NORTH NORTHWEST', 337.5], ['NORTHEAST', 45], ['SOUTHEAST', 135],
  ['SOUTHWEST', 225], ['NORTHWEST', 315], ['NORTH', 0], ['EAST', 90], ['SOUTH', 180], ['WEST', 270]];
const nearestPoint = deg => Math.round(((deg % 360) + 360) % 360 / 22.5) % 16 * 22.5;

/* Reads a marine forecast, a point forecast, a METAR line or a forecast table row.
   Returns only the fields it actually found. */
function parseForecast(raw) {
  const txt = ' ' + raw.replace(/\s+/g, ' ') + ' ';
  const t = txt.toUpperCase();
  const got = {}, notes = [];

  /* METAR wind group: 24012G20KT, or VRB05KT */
  const metar = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(t);
  /* mph appears in NWS point forecasts, kt in marine forecasts */
  const mph = /\bMPH\b/.test(t) && !/\b(KT|KNOT)/.test(t);
  const toKt = n => mph ? Math.round(n * 0.8690) : n;

  if (metar) {
    if (metar[1] !== 'VRB') got.winddir = nearestPoint(+metar[1]);
    got.windlo = +metar[2];
    if (metar[3]) { got.windhi = +metar[3]; got._gust = true; }
    notes.push('METAR line');
  } else {
    /* direction: a compass point beside the word WIND, else the first one in the text */
    let dm = /\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)(?:ERLY)?\s*(?:WINDS?|WND)\b/.exec(t)
      || /\bWINDS?\s*(?:FROM\s*THE\s*)?(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)(?:ERLY)?\b/.exec(t)
      || /\b(\d{1,2})\s*(?:KT|KNOTS|MPH)\s*(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/.exec(t);
    if (!dm) dm = /\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+(?:AT\s+)?\d{1,2}\s*(?:KT|KNOTS|MPH)\b/.exec(t);
    if (dm) { const k = dm[2] && POINTS[dm[2]] !== undefined ? dm[2] : dm[1]; if (POINTS[k] !== undefined) got.winddir = POINTS[k]; }
    if (got.winddir === undefined) {
      const w = WORDED.find(([name]) => new RegExp('\\b' + name.replace(' ', '[ -]?') + '(?:ERLY)?\\s+WINDS?\\b').test(t));
      if (w) got.winddir = w[1];
    }
    if (got.winddir === undefined) {
      const deg = /\b(\d{3})\s*(?:DEG|°)/.exec(t);
      if (deg && +deg[1] <= 360) got.winddir = nearestPoint(+deg[1]);
    }
    /* speed: a range, else a single number */
    const range = /\b(\d{1,2})\s*(?:TO|-|–)\s*(\d{1,2})\s*(?:KT|KNOTS|MPH)\b/.exec(t);
    const one = /\b(\d{1,2})\s*(?:KT|KNOTS|MPH)\b/.exec(t);
    if (range) { got.windlo = toKt(+range[1]); got.windhi = toKt(+range[2]); }
    else if (one) got.windlo = toKt(+one[1]);
    /* gusts override the top of a range */
    const gust = /\bGUST(?:S|ING)?\s*(?:AS\s+HIGH\s+AS|UP\s+TO|TO)?\s*(\d{1,3})\b/.exec(t)
      || /\bG\s?(\d{2,3})\s*(?:KT|KNOTS|MPH)\b/.exec(t);
    if (gust) { got.windhi = toKt(+gust[1]); got._gust = true; }
    if (got.windhi !== undefined && got.windlo !== undefined && got.windhi < got.windlo) got.windhi = got.windlo;
  }

  /* shift */
  if (/\bSEA\s?BREEZE\b/.test(t)) got.shift = 'Sea breeze fills in';
  else if (/\bVEER/.test(t)) got.shift = 'Veers, clockwise';
  else if (/\bBACK(?:ING|S)\b/.test(t)) got.shift = 'Backs, anticlockwise';
  else if (/\b(INCREAS|BUILD|FRESHEN)/.test(t)) got.shift = 'Increases';
  else if (/\b(DIMINISH|SUBSID|DECREAS|EAS(?:ING|E)\b)/.test(t)) got.shift = 'Decreases';
  else {
    const bec = /\bBECOMING\s+(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/.exec(t);
    if (bec && got.winddir !== undefined && POINTS[bec[1]] !== undefined) {
      const delta = ((POINTS[bec[1]] - got.winddir) % 360 + 360) % 360;
      if (delta > 0 && delta < 180) got.shift = 'Veers, clockwise';
      else if (delta > 180) got.shift = 'Backs, anticlockwise';
    }
  }

  /* sky */
  if (/\b(FOG|MIST|HAZE|BR\b)/.test(t)) got.sky = 'Fog or haze';
  else if (/\b(RAIN|SHOWER|DRIZZLE|PRECIP)/.test(t)) got.sky = 'Rain';
  else if ((/\b(OVERCAST|CLOUDY)\b/.test(t) || /\bOVC\d{3}\b/.test(t)) && !/PARTLY/.test(t)) got.sky = 'Overcast';
  else if (/\b(PARTLY|MOSTLY\s+SUNNY|SCATTERED\s+CLOUDS?)\b/.test(t) || /\b(FEW|SCT|BKN)\d{3}\b/.test(t)) got.sky = 'Partly cloudy';
  else if (/\b(SUNNY|CLEAR|SKC|CLR)\b/.test(t)) got.sky = 'Clear';

  /* visibility */
  const visNm = /\bVISIBILITY\s*(?:OF\s*)?(\d{1,2}(?:\.\d)?)\s*(?:NM|MILE|SM)/.exec(t) || /\b(\d{1,2})SM\b/.exec(t);
  if (visNm) got.vis = +visNm[1] < 1 ? 'Poor, less than 1 nm' : (+visNm[1] <= 5 ? 'Moderate, 1 to 5 nm' : 'Good, more than 5 nm');
  else if (/\b(DENSE\s+FOG|VISIBILITY\s+1NM\s+OR\s+LESS)\b/.test(t)) got.vis = 'Poor, less than 1 nm';
  else if (/\b(FOG|MIST|HAZE)\b/.test(t)) got.vis = 'Moderate, 1 to 5 nm';

  /* thunderstorms */
  if (/\b(TSTM|THUNDERSTORM|TS\b|SEVERE\s+STORM)/.test(t)) {
    got.storm = /\b(LIKELY|SEVERE|WARNING|NUMEROUS)\b/.test(t) ? 'Likely in the window' : 'Possible later';
  }

  /* warnings */
  if (/\bGALE\s+WARNING\b/.test(t)) got.advisory = 'Gale Warning';
  else if (/\bSPECIAL\s+MARINE\s+WARNING\b/.test(t)) got.advisory = 'Special Marine Warning';
  else if (/\bSMALL\s+CRAFT\s+ADVISORY\b/.test(t)) got.advisory = 'Small Craft Advisory';

  /* temperatures */
  const air = /\b(?:AIR\s*TEMP|TEMPERATURE|TEMP)\D{0,6}(\d{2,3})\s*(?:°|DEG)?\s*F\b/.exec(t);
  if (air) got.airtemp = +air[1];
  const wat = /\b(?:WATER|SEA|SST)\s*(?:TEMP\w*)?\D{0,6}(\d{2,3})\s*(?:°|DEG)?\s*F\b/.exec(t);
  if (wat) got.watertemp = +wat[1];

  /* source */
  const zone = /\b(ANZ\d{3})\b/.exec(t);
  if (zone) got.fcstsrc = 'NWS marine ' + zone[1];
  else if (/WINDFINDER/.test(t)) got.fcstsrc = 'Windfinder';
  else if (/\bNDBC|BUOY\b/.test(t)) got.fcstsrc = 'NDBC buoy';
  else if (mph || /WEATHER\.GOV|NATIONAL WEATHER SERVICE/.test(t)) got.fcstsrc = 'NWS point forecast';

  if (mph) notes.push('mph converted to kt');
  return { got, notes };
}

/* Node loads this file directly for the unit tests. A browser has no `module`,
   so the guard makes the line a no-op in the page. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { FLOOD, EBB, LAT, LON, WATER, WIND, hhmm, toMin, addDays,
    nyOffset, prettyDate, sunEvent, todayNY, dayEvents, dayTides, readDay, windAt,
    timeline, currentAt, setDir, setName, upDown, angDiff, nearestPoint,
    parseForecast };
}
