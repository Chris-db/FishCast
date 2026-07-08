// Local astronomy — no API calls. Formulas after Astronomy Answers / SunCalc
// (Agafonkin, BSD-2). Accuracy is minutes-level, plenty for bite windows.

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the Earth

const toJulian = (ms) => ms / dayMs - 0.5 + J1970;
const fromJulian = (j) => (j + 0.5 - J1970) * dayMs;
const toDays = (ms) => toJulian(ms) - J2000;

const rightAscension = (l, b) =>
  Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) =>
  Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const altitude = (H, phi, dec) =>
  Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

// --- Sun ---

const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of the Earth
  return M + C + P + Math.PI;
}

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, dec) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));

/**
 * Sunrise / sunset / solar noon for the day containing `ms` (a UTC epoch near
 * the spot's local noon works best). Returns epoch ms or null (polar day/night).
 */
export function sunTimes(ms, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(ms);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);

  const h0 = -0.833 * rad; // refraction + solar disc
  const w = hourAngle(h0, phi, dec);
  if (Number.isNaN(w)) return { sunrise: null, sunset: null, noon: fromJulian(Jnoon) };

  const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset), noon: fromJulian(Jnoon) };
}

// --- Moon ---

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = rad * (134.963 + 13.064993 * d); // mean anomaly
  const F = rad * (93.272 + 13.22935 * d); // mean distance
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M); // km
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

export function moonAltitude(ms, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(ms);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitude(H, phi, c.dec);
  const hr = h < 0 ? 0 : h;
  h += 0.0002967 / Math.tan(hr + 0.00312536 / (hr + 0.08901179)); // astro refraction
  return h;
}

/** phase: 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter */
export function moonIllumination(ms) {
  const d = toDays(ms);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000; // km, Earth–Sun
  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
  );
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
  );
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
}

export function moonPhaseName(phase) {
  if (phase < 0.033 || phase >= 0.967) return 'New moon';
  if (phase < 0.217) return 'Waxing crescent';
  if (phase < 0.283) return 'First quarter';
  if (phase < 0.467) return 'Waxing gibbous';
  if (phase < 0.533) return 'Full moon';
  if (phase < 0.717) return 'Waning gibbous';
  if (phase < 0.783) return 'Last quarter';
  return 'Waning crescent';
}

const STEP = 10 * 60000; // 10-min sampling

function bisectHorizon(t0, t1, lat, lng) {
  let a = t0, b = t1;
  for (let i = 0; i < 22; i++) {
    const m = (a + b) / 2;
    const ha = moonAltitude(a, lat, lng);
    const hm = moonAltitude(m, lat, lng);
    if ((ha < 0) === (hm < 0)) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

function refineExtremum(t, lat, lng) {
  // Parabolic refinement around a sampled extremum.
  const p = moonAltitude(t - STEP, lat, lng);
  const c = moonAltitude(t, lat, lng);
  const n = moonAltitude(t + STEP, lat, lng);
  const denom = p - 2 * c + n;
  if (Math.abs(denom) < 1e-12) return t;
  return t + (STEP / 2) * ((p - n) / denom);
}

/**
 * Moon events within [startMs, endMs]:
 *  - rises/sets   → solunar minors
 *  - upper/lower transits (overhead / underfoot) → solunar majors
 */
export function moonEvents(startMs, endMs, lat, lng) {
  const samples = [];
  for (let t = startMs - STEP; t <= endMs + STEP; t += STEP) {
    samples.push({ t, h: moonAltitude(t, lat, lng) });
  }
  const ev = { rises: [], sets: [], upper: [], lower: [] };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.h < 0 && b.h >= 0) ev.rises.push(bisectHorizon(a.t, b.t, lat, lng));
    if (a.h >= 0 && b.h < 0) ev.sets.push(bisectHorizon(a.t, b.t, lat, lng));
  }
  for (let i = 1; i < samples.length - 1; i++) {
    const p = samples[i - 1].h;
    const c = samples[i].h;
    const n = samples[i + 1].h;
    if (c > p && c >= n) ev.upper.push(refineExtremum(samples[i].t, lat, lng));
    if (c < p && c <= n) ev.lower.push(refineExtremum(samples[i].t, lat, lng));
  }
  const inRange = (t) => t >= startMs && t <= endMs;
  ev.rises = ev.rises.filter(inRange);
  ev.sets = ev.sets.filter(inRange);
  ev.upper = ev.upper.filter(inRange);
  ev.lower = ev.lower.filter(inRange);
  return ev;
}
