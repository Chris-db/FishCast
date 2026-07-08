// Scoring engine. ONE engine; each mode is a config object (weights, gate
// thresholds, flags). Adding a mode (e.g. estuary) = adding a config.

import { sunTimes, moonEvents, moonIllumination, moonPhaseName } from './astro.js';
import { interp, idxRange } from './data.js';

export const BLOCKS = [
  { key: 'early', name: 'Early Morning', start: 4, end: 7 },
  { key: 'morning', name: 'Morning', start: 7, end: 10 },
  { key: 'midday', name: 'Midday', start: 10, end: 13 },
  { key: 'afternoon', name: 'Afternoon', start: 13, end: 16 },
  { key: 'evening', name: 'Evening', start: 16, end: 19 },
  { key: 'night', name: 'Night', start: 19, end: 22 },
];

export const MODES = {
  fresh: {
    key: 'fresh',
    label: 'Freshwater',
    usesTide: false,
    usesMarine: false,
    // shore base with tide's 20% redistributed to solunar + pressure
    weights: { solunar: 0.4, pressure: 0.35, tide: 0, dawnDusk: 0.15, moon: 0.1 },
    gate: {
      windStart: 24, windZero: 55, // reduced wind penalty
      gustStart: 38, gustZero: 75,
      rainStart: 4, rainZero: 14, // light rain is a bonus instead (below)
      lightRainBonus: 6,
      coldTemp: 4, hotTemp: 38,
      swellStart: null, swellZero: null,
    },
    hardGate: null,
  },
  shore: {
    key: 'shore',
    label: 'Shore',
    usesTide: true,
    usesMarine: true,
    weights: { solunar: 0.3, pressure: 0.25, tide: 0.2, dawnDusk: 0.15, moon: 0.1 },
    gate: {
      windStart: 20, windZero: 48,
      gustStart: 32, gustZero: 65,
      rainStart: 1.5, rainZero: 12,
      lightRainBonus: 0,
      coldTemp: 4, hotTemp: 38,
      swellStart: 2.0, swellZero: 3.8, // hard safety concern on the rocks
    },
    hardGate: null,
    windDirection: { onshoreBonus: 5, offshorePenalty: 4 },
  },
  boat: {
    key: 'boat',
    label: 'Boat',
    usesTide: false, // tide affects launch access, not the fish score
    usesMarine: true,
    weights: { solunar: 0.38, pressure: 0.31, tide: 0, dawnDusk: 0.19, moon: 0.12 },
    gate: {
      windStart: 15, windZero: 35,
      gustStart: 25, gustZero: 50,
      rainStart: 1.5, rainZero: 12,
      lightRainBonus: 0,
      coldTemp: 4, hotTemp: 38,
      swellStart: 1.4, swellZero: 2.6,
    },
    // go/no-go overrides everything; marginal band shows caution
    hardGate: {
      maxSwell: 2.2, maxWind: 28, maxGust: 46, minSteepPeriod: 7, steepFromSwell: 1.6,
      cautionSwell: 1.6, cautionWind: 22, cautionGust: 38,
    },
  },
};

// unit formatting for reason strings (engine thresholds stay metric)
const METRIC = { wind: (kmh) => `${Math.round(kmh)} km/h`, height: (m) => `${m.toFixed(1)} m` };
const IMPERIAL = { wind: (kmh) => `${Math.round(kmh * 0.621371)} mph`, height: (m) => `${(m * 3.28084).toFixed(1)} ft` };
let U = METRIC;
export function setUnits(units) {
  U = units === 'imperial' ? IMPERIAL : METRIC;
}

const HOUR = 3600000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ramp = (v, start, zero) => (v <= start ? 1 : v >= zero ? 0 : 1 - (v - start) / (zero - start));
const overlapMs = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// --- Factor scores (each 0–100) ---

function solunarScore(b0, b1, moonEv, phaseAmp) {
  let major = 0;
  let minor = 0;
  for (const t of [...moonEv.upper, ...moonEv.lower]) major += overlapMs(b0, b1, t - HOUR, t + HOUR);
  for (const t of [...moonEv.rises, ...moonEv.sets]) minor += overlapMs(b0, b1, t - HOUR / 2, t + HOUR / 2);
  const raw = ((major + minor * 0.65) / (1.5 * HOUR)) * 100;
  const score = clamp(raw * phaseAmp, 0, 100);
  let tag = null;
  if (major >= 30 * 60000) tag = 'major solunar period';
  else if (minor >= 20 * 60000) tag = 'minor solunar period';
  return { score, tag };
}

function pressureScore(wx, tMid) {
  const now = interp(wx.epochs, wx.pressure, tMid);
  const past = interp(wx.epochs, wx.pressure, tMid - 4 * HOUR); // 4h trend, not spot reading
  if (now == null || past == null) return { score: 55, tag: 'steady pressure' };
  const d = now - past;
  if (d <= -4) return { score: 88, tag: 'pressure dropping fast' };
  if (d <= -0.8) return { score: 100, tag: 'falling pressure' };
  if (d < 0.8) {
    if (now >= 1018) return { score: 65, tag: 'stable high pressure' };
    return { score: 52, tag: 'steady pressure' };
  }
  if (d < 3) return { score: 38, tag: 'rising pressure' };
  return { score: 22, tag: 'pressure rising fast' };
}

/** Find tide extrema (highs/lows) from the hourly sea-level curve. */
export function tideExtrema(marine) {
  if (!marine || !marine.seaLevel) return null;
  const { epochs, seaLevel } = marine;
  const ext = [];
  let maxRate = 0;
  for (let i = 1; i < epochs.length; i++) {
    if (seaLevel[i] == null || seaLevel[i - 1] == null) continue;
    maxRate = Math.max(maxRate, Math.abs(seaLevel[i] - seaLevel[i - 1])); // m per hour
  }
  for (let i = 1; i < epochs.length - 1; i++) {
    const p = seaLevel[i - 1];
    const c = seaLevel[i];
    const n = seaLevel[i + 1];
    if (p == null || c == null || n == null) continue;
    if (c >= p && c > n) ext.push({ t: parabolicT(epochs[i], p, c, n), type: 'high', h: c });
    if (c <= p && c < n) ext.push({ t: parabolicT(epochs[i], p, c, n), type: 'low', h: c });
  }
  return { extrema: ext, maxRate: Math.max(maxRate, 0.01) };
}

function parabolicT(t, p, c, n) {
  const denom = p - 2 * c + n;
  if (Math.abs(denom) < 1e-12) return t;
  return t + (HOUR / 2) * ((p - n) / denom);
}

function tideScore(b0, b1, marine, tides) {
  if (!tides) return null;
  const pts = [b0 + (b1 - b0) * 0.2, (b0 + b1) / 2, b0 + (b1 - b0) * 0.8];
  let sum = 0;
  const tags = { incoming: 0, outgoing: 0, slack: 0, push: 0 };
  for (const t of pts) {
    const rate = (interp(marine.epochs, marine.seaLevel, t + HOUR / 2) ?? 0) -
      (interp(marine.epochs, marine.seaLevel, t - HOUR / 2) ?? 0);
    const nextHigh = tides.extrema.find((x) => x.type === 'high' && x.t >= t);
    if (rate > 0 && nextHigh && nextHigh.t - t <= 2 * HOUR) {
      sum += 100; // last 2h of the push to high water — best
      tags.push++;
      continue;
    }
    const norm = clamp(Math.abs(rate) / tides.maxRate, 0, 1);
    if (norm < 0.2) {
      sum += 25;
      tags.slack++;
    } else if (rate > 0) {
      sum += 55 + 40 * norm;
      tags.incoming++;
    } else {
      sum += 45 + 35 * norm;
      tags.outgoing++;
    }
  }
  const tag =
    tags.push >= 2 ? 'incoming tide' :
    tags.incoming >= 2 ? 'rising tide' :
    tags.outgoing >= 2 ? 'outgoing tide' :
    tags.slack >= 2 ? 'slack tide' : 'turning tide';
  return { score: sum / pts.length, tag };
}

function dawnDuskScore(b0, b1, sun) {
  let ov = 0;
  let tag = null;
  if (sun.sunrise != null) {
    const o = overlapMs(b0, b1, sun.sunrise - HOUR, sun.sunrise + HOUR);
    if (o > 30 * 60000) tag = 'dawn window';
    ov += o;
  }
  if (sun.sunset != null) {
    const o = overlapMs(b0, b1, sun.sunset - HOUR, sun.sunset + HOUR);
    if (o > 30 * 60000) tag = 'dusk window';
    ov += o;
  }
  return { score: clamp((ov / (1.5 * HOUR)) * 100, 0, 100), tag };
}

function moonPhaseScore(phase) {
  const d = Math.min(Math.abs(phase), Math.abs(phase - 0.5), Math.abs(phase - 1));
  const closeness = 1 - d / 0.25; // 1 at new/full, 0 at quarters
  const score = 25 + 75 * closeness;
  let tag = null;
  if (closeness > 0.75) tag = phase > 0.25 && phase < 0.75 ? 'full moon' : 'new moon';
  return { score, tag, amp: 0.85 + 0.35 * closeness };
}

// --- Weather gate: multiplier 1 → 0 on the composite, not a factor ---

function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function blockWeather(wx, marine, b0, b1) {
  const idx = idxRange(wx.epochs, b0, b1);
  const pick = (arr, f, init) => idx.reduce((acc, i) => (arr?.[i] == null ? acc : f(acc, arr[i])), init);
  const avg = (arr) => {
    const vals = idx.map((i) => arr?.[i]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  let swell = null;
  let swellPeriod = null;
  if (marine) {
    const mi = idxRange(marine.epochs, b0, b1);
    const mmax = (arr) => mi.reduce((acc, i) => (arr?.[i] == null ? acc : Math.max(acc, arr[i])), -1);
    const mmin = (arr) => mi.reduce((acc, i) => (arr?.[i] == null ? acc : Math.min(acc, arr[i])), 99);
    const s = Math.max(mmax(marine.swellHeight), mmax(marine.waveHeight));
    swell = s < 0 ? null : s;
    const p = mmin(marine.swellPeriod);
    swellPeriod = p > 90 ? null : p;
  }
  return {
    wind: avg(wx.wind),
    gust: pick(wx.gust, Math.max, 0),
    rain: avg(wx.precip), // mm/h average over the block
    rainProb: pick(wx.rainProb, Math.max, 0),
    temp: avg(wx.temp),
    cloud: avg(wx.cloud),
    code: pick(wx.code, Math.max, 0),
    cape: pick(wx.cape, Math.max, 0),
    windDir: avg(wx.windDir),
    swell,
    swellPeriod,
  };
}

function weatherGate(w, cfg, mode) {
  let gate = 1;
  const reasons = [];
  if (w.code >= 95 || w.cape > 3500) {
    return { gate: 0, reasons: ['lightning risk'], severity: 'danger' };
  }
  if (w.cape > 2000) {
    gate *= 0.6;
    reasons.push('storm potential');
  }
  if (w.wind != null) {
    const g = ramp(w.wind, cfg.windStart, cfg.windZero);
    if (g < 1) reasons.push(`${U.wind(w.wind)} wind`);
    gate *= g;
  }
  if (w.gust != null) {
    const g = ramp(w.gust, cfg.gustStart, cfg.gustZero);
    if (g < 0.85) reasons.push('strong gusts');
    gate *= g;
  }
  if (w.rain != null && w.rain > cfg.rainStart) {
    gate *= Math.max(ramp(w.rain, cfg.rainStart, cfg.rainZero), 0.15);
    reasons.push(w.rain > 6 ? 'heavy rain' : 'rain');
  }
  if (w.temp != null && (w.temp < cfg.coldTemp || w.temp > cfg.hotTemp)) {
    gate *= 0.85;
    reasons.push(w.temp < cfg.coldTemp ? 'bitter cold' : 'extreme heat');
  }
  if (cfg.swellStart != null && w.swell != null) {
    const g = ramp(w.swell, cfg.swellStart, cfg.swellZero);
    if (g < 1) reasons.push(`${U.height(w.swell)} swell`);
    gate *= g;
  }
  const severity = gate === 0 ? 'danger' : gate < 0.5 ? 'warn' : null;
  return { gate, reasons, severity };
}

function boatCheck(w, hg) {
  if (w.code >= 95 || w.cape > 3000) return { status: 'nogo', reason: 'lightning risk' };
  if (w.swell != null && w.swell > hg.maxSwell) return { status: 'nogo', reason: `${U.height(w.swell)} swell` };
  if (w.swell != null && w.swellPeriod != null && w.swell > hg.steepFromSwell && w.swellPeriod < hg.minSteepPeriod) {
    return { status: 'nogo', reason: `steep ${U.height(w.swell)} swell @ ${Math.round(w.swellPeriod)} s` };
  }
  if (w.wind != null && w.wind > hg.maxWind) return { status: 'nogo', reason: `${U.wind(w.wind)} wind` };
  if (w.gust != null && w.gust > hg.maxGust) return { status: 'nogo', reason: `gusts to ${U.wind(w.gust)}` };
  if (
    (w.swell != null && w.swell > hg.cautionSwell) ||
    (w.wind != null && w.wind > hg.cautionWind) ||
    (w.gust != null && w.gust > hg.cautionGust)
  ) {
    return { status: 'caution', reason: 'marginal sea conditions' };
  }
  return { status: 'go', reason: null };
}

// --- Composite ---

export function labelFor(score) {
  if (score >= 75) return 'Excellent';
  if (score >= 55) return 'Good';
  if (score >= 35) return 'Fair';
  return 'Poor';
}

/**
 * Score all six blocks of one spot-local day.
 * dayStr: 'YYYY-MM-DD' in spot-local time.
 */
export function scoreDay({ mode, spot, wx, marine, dayStr, nowMs }) {
  const cfg = MODES[mode];
  const off = wx.offsetSec * 1000;
  const localEpoch = (h) => Date.parse(`${dayStr}T00:00:00Z`) + h * HOUR - off;

  const dayStart = localEpoch(0);
  const dayEnd = localEpoch(24);
  const sun = sunTimes(localEpoch(12), spot.lat, spot.lng);
  const moonEv = moonEvents(dayStart, dayEnd, spot.lat, spot.lng);
  const illum = moonIllumination(localEpoch(12));
  const moon = moonPhaseScore(illum.phase);

  const tides = cfg.usesTide ? tideExtrema(marine) : null;
  const tideAvailable = cfg.usesTide && tides && tides.extrema.length > 0;
  // tide times stay visible in boat mode (launch access) even though the
  // score ignores them
  const displayTides = cfg.usesMarine && marine ? tideExtrema(marine) : tides;

  // no tide data (or freshwater): fold tide weight into solunar + pressure
  const weights = { ...cfg.weights };
  if (cfg.usesTide && !tideAvailable) {
    weights.solunar += weights.tide * 0.55;
    weights.pressure += weights.tide * 0.45;
    weights.tide = 0;
  }

  const blocks = BLOCKS.map((b) => {
    const b0 = localEpoch(b.start);
    const b1 = localEpoch(b.end);
    const tMid = (b0 + b1) / 2;

    const f = {
      solunar: solunarScore(b0, b1, moonEv, moon.amp),
      pressure: pressureScore(wx, tMid),
      tide: tideAvailable ? tideScore(b0, b1, marine, tides) : { score: 0, tag: null },
      dawnDusk: dawnDuskScore(b0, b1, sun),
      moon: { score: moon.score, tag: moon.tag },
    };

    let composite = 0;
    for (const k of Object.keys(weights)) composite += weights[k] * f[k].score;

    const w = blockWeather(wx, cfg.usesMarine ? marine : null, b0, b1);

    // freshwater: light steady rain stirs the bite
    let bonusTag = null;
    if (cfg.gate.lightRainBonus && w.rain != null && w.rain > 0.1 && w.rain <= 1.5) {
      composite += cfg.gate.lightRainBonus;
      bonusTag = 'light rain';
    }

    // shore: wind direction vs the water the angler faces
    if (cfg.windDirection && spot.facing != null && w.windDir != null && w.wind > 8) {
      const diff = angDiff(w.windDir, spot.facing);
      if (diff < 60) {
        composite += cfg.windDirection.onshoreBonus;
        if (!bonusTag) bonusTag = 'onshore wind stirring the surf';
      } else if (diff > 120 && w.wind > 15) {
        composite -= cfg.windDirection.offshorePenalty;
      }
    }

    const gateRes = weatherGate(w, cfg.gate, mode);
    const boat = cfg.hardGate ? boatCheck(w, cfg.hardGate) : null;

    let score = Math.round(clamp(composite, 0, 100) * gateRes.gate);
    let label = labelFor(score);
    if (boat && boat.status === 'nogo') {
      score = 0;
      label = "Don't launch";
    }

    // reason line: top weighted contributors, then the gate cap
    const contribs = Object.keys(weights)
      .filter((k) => weights[k] > 0 && f[k].tag && f[k].score >= 55)
      .sort((a, b) => weights[b] * f[b].score - weights[a] * f[a].score)
      .slice(0, 3)
      .map((k) => f[k].tag);
    if (bonusTag) contribs.push(bonusTag);
    const dragPhrases = {
      solunar: 'no solunar period',
      pressure: f.pressure.tag,
      tide: f.tide.tag || 'slack tide',
      dawnDusk: 'flat light hours',
      moon: 'quarter moon',
    };
    let reason;
    if (boat && boat.status === 'nogo') {
      reason = `Unsafe: ${boat.reason}`;
    } else if (contribs.length) {
      reason = contribs.slice(0, 3).join(' + ');
      if (gateRes.gate < 0.8 && gateRes.reasons.length) {
        reason += ` — capped by ${gateRes.reasons[0]}`;
      } else if (score < 55 && contribs.length < 2) {
        // one good sign on a weak block: say what's dragging it down
        const drag = Object.keys(weights)
          .filter((k) => weights[k] > 0 && f[k].score <= 40 && !contribs.includes(f[k].tag))
          .sort((a, b) => weights[b] * (100 - f[b].score) - weights[a] * (100 - f[a].score))[0];
        if (drag) reason += `, but ${dragPhrases[drag]}`;
      }
    } else if (gateRes.gate < 0.8 && gateRes.reasons.length) {
      reason = `held back by ${gateRes.reasons.join(' + ')}`;
    } else {
      // nothing strong: name the weakest major factor honestly
      const weakest = Object.keys(weights)
        .filter((k) => weights[k] > 0)
        .sort((a, b) => f[a].score - f[b].score)[0];
      reason = `quiet spell — ${dragPhrases[weakest] || 'no strong drivers'}`;
    }
    reason = reason.charAt(0).toUpperCase() + reason.slice(1);

    return {
      ...b,
      b0, b1, score, label, reason,
      conditions: w,
      gate: gateRes.gate,
      gateSeverity: gateRes.severity,
      boat,
      past: b1 <= nowMs,
      current: nowMs >= b0 && nowMs < b1,
    };
  });

  return {
    blocks,
    sun,
    moonPhase: illum.phase,
    moonPhaseName: moonPhaseName(illum.phase),
    moonFraction: illum.fraction,
    tideAvailable,
    tides: displayTides ? displayTides.extrema.filter((x) => x.t >= dayStart && x.t < dayEnd) : [],
    waterTemp: cfg.usesMarine && marine ? interp(marine.epochs, marine.sst, localEpoch(12)) : null,
  };
}

/**
 * Boat weather window: scan hourly from `fromMs`, report how long conditions
 * hold ("Good until 11:00 — wind picks up after") in spot-local time.
 */
export function weatherWindow({ wx, marine, fromMs, hours = 36 }) {
  const hg = MODES.boat.hardGate;
  const states = [];
  for (let i = 0; i < hours; i++) {
    const t0 = fromMs + i * HOUR;
    const w = blockWeather(wx, marine, t0, t0 + HOUR);
    if (w.wind == null) break;
    states.push({ t: t0, ...boatCheck(w, hg) });
  }
  if (!states.length) return null;
  const fmt = (t) => {
    const d = new Date(t + wx.offsetSec * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  };
  const first = states[0];
  const changeIdx = states.findIndex((s) => (s.status === 'nogo') !== (first.status === 'nogo'));
  if (first.status !== 'nogo') {
    if (changeIdx === -1) return { status: first.status, text: `Conditions hold for the next ${states.length} h` };
    const turn = states[changeIdx];
    return { status: first.status, text: `Good until ${fmt(turn.t)} — ${turn.reason} after` };
  }
  if (changeIdx === -1) return { status: 'nogo', text: `No launch window in the next ${states.length} h — ${first.reason}` };
  return { status: 'nogo', text: `${first.reason} now — opens around ${fmt(states[changeIdx].t)}` };
}
