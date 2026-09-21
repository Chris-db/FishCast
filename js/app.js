import { fetchForecast, fetchMarine, geocode, interp } from './data.js';
import { BLOCKS, MODES, scoreDay, weatherWindow, setUnits, tideExtrema } from './engine.js';
import { tideChart, windChart, tempChart, rainChart, sunArc, moonIcon, attachScrub, fmtHM } from './charts.js';
import { moonEvents } from './astro.js';

const STORE_KEY = 'fishcast:state:v1';
const DAY_MS = 86400000;

const DEFAULT_STATE = {
  units: 'metric',
  activeSpotId: 'umhlanga',
  spots: [
    { id: 'umhlanga', name: 'Umhlanga Rocks', region: 'KwaZulu-Natal, South Africa', lat: -29.7269, lng: 31.0925, mode: 'shore', facing: 135 },
    { id: 'inanda', name: 'Inanda Dam', region: 'KwaZulu-Natal, South Africa', lat: -29.6955, lng: 30.8666, mode: 'fresh', facing: null },
  ],
};

let state = loadState();
let dayOffset = 0;
let wx = null; // forecast for active spot
let marine = null;
let loadToken = 0;
let lastDay = null; // last scored day (feeds the share text)

/** Fire-and-forget analytics event; no-op until GoatCounter is configured. */
function track(name) {
  try {
    window.goatcounter?.count?.({ path: name, event: true });
  } catch { /* never break the app for analytics */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.spots && s.spots.length) return s;
    }
  } catch { /* fall through */ }
  return structuredClone(DEFAULT_STATE);
}

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const $ = (sel) => document.querySelector(sel);
const activeSpot = () => state.spots.find((s) => s.id === state.activeSpotId) || state.spots[0];

function fmtTime(ms) {
  return new Date(ms + wx.offsetSec * 1000).toISOString().slice(11, 16);
}

function fmtTemp(c) {
  if (c == null) return '—';
  return state.units === 'imperial' ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const windVal = (kmh) => Math.round(state.units === 'imperial' ? kmh * 0.621371 : kmh);
const windUnit = () => (state.units === 'imperial' ? 'mph' : 'km/h');
const heightStr = (m) => (state.units === 'imperial' ? `${(m * 3.28084).toFixed(1)} ft` : `${m.toFixed(1)} m`);

/** Tiny condition icons (stroke/fill follows text color). */
const IC = {
  temp: '<svg class="cic" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.75 1.9a1.25 1.25 0 0 1 2.5 0v4a2.6 2.6 0 1 1-2.5 0Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  rain: '<svg class="cic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.3C6 1.3 2.8 5.4 2.8 7.6a3.2 3.2 0 0 0 6.4 0C9.2 5.4 6 1.3 6 1.3Z" fill="currentColor"/></svg>',
  cloud: '<svg class="cic" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.6 9.5a2.4 2.4 0 0 1-.3-4.7 3 3 0 0 1 5.9.8A2.05 2.05 0 0 1 8.9 9.5Z" fill="currentColor"/></svg>',
  swell: '<svg class="cic" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 7.5q2.5-3 5 0t5 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

function windGlyph(windDir) {
  if (windDir == null) return '';
  const rot = Math.round((windDir + 180) % 360);
  return `<svg class="warrow" viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(${rot}deg)"><path d="M6 1l3.4 8-3.4-2.2L2.6 9Z"/></svg>`;
}

/** Compact per-block conditions: wind, temp, rain, cloud, swell — with icons. */
function condLine(w) {
  if (!w) return '';
  const parts = [];
  if (w.wind != null) {
    let wind = windGlyph(w.windDir);
    if (w.windDir != null) wind += `${compass(w.windDir)} `;
    wind += `${windVal(w.wind)}`;
    if (w.gust != null && w.gust >= w.wind + 9) wind += `–${windVal(w.gust)}`;
    parts.push(`${wind} ${windUnit()}`);
  }
  if (w.temp != null) parts.push(`${IC.temp}${fmtTemp(w.temp)}`);
  if (w.rainProb != null && (w.rainProb >= 15 || (w.rain ?? 0) > 0.2)) parts.push(`${IC.rain}${Math.round(w.rainProb)}%`);
  if (w.cloud != null) parts.push(`${IC.cloud}${Math.round(w.cloud)}%`);
  if (w.swell != null) parts.push(`${IC.swell}${heightStr(w.swell)}${w.swellPeriod ? ` @ ${Math.round(w.swellPeriod)} s` : ''}`);
  return parts.join('<span class="dot">·</span>');
}

function localDayStr(plusDays) {
  return new Date(Date.now() + wx.offsetSec * 1000 + plusDays * DAY_MS).toISOString().slice(0, 10);
}

// --- rendering ---

function renderModeControl() {
  const spot = activeSpot();
  const el = $('#mode-control');
  el.innerHTML = '';
  for (const m of Object.values(MODES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.textContent = m.label;
    btn.setAttribute('aria-pressed', String(spot.mode === m.key));
    btn.addEventListener('click', () => {
      if (spot.mode === m.key) return;
      spot.mode = m.key;
      persist();
      renderModeControl();
      loadAndRender();
    });
    el.appendChild(btn);
  }
}

function renderDayTabs() {
  const el = $('#day-tabs');
  el.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const dayStr = localDayStr(i);
    const d = new Date(`${dayStr}T12:00:00Z`);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-btn';
    btn.textContent = label;
    btn.setAttribute('aria-pressed', String(i === dayOffset));
    btn.addEventListener('click', () => {
      dayOffset = i;
      renderDayTabs();
      renderDay();
    });
    el.appendChild(btn);
  }
}

function renderSpotButton() {
  const spot = activeSpot();
  $('#spot-name').textContent = spot.name;
  $('#spot-region').textContent = spot.region || `${spot.lat.toFixed(3)}, ${spot.lng.toFixed(3)}`;
}

function skeleton() {
  $('#banner').hidden = true;
  $('#shape-card').hidden = true;
  $('#hero').hidden = true;
  document.querySelectorAll('#view-weather .chart-card').forEach((c) => { c.hidden = true; });
  $('#summary').innerHTML = '';
  const list = $('#blocks');
  list.innerHTML = '';
  for (let i = 0; i < BLOCKS.length; i++) {
    const li = document.createElement('li');
    li.className = 'row skeleton';
    li.innerHTML = '<div class="sk-line w40"></div><div class="sk-line w70"></div>';
    list.appendChild(li);
  }
  $('#notice').hidden = true;
}

function showError(msg) {
  const list = $('#blocks');
  list.innerHTML = '';
  $('#summary').innerHTML = '';
  $('#banner').hidden = true;
  const li = document.createElement('li');
  li.className = 'row error-block';
  li.innerHTML = `<p class="row-reason">${msg}</p>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = 'Retry';
  btn.addEventListener('click', loadAndRender);
  li.appendChild(btn);
  list.appendChild(li);
}

function ratingKey(block) {
  if (block.boat && block.boat.status === 'nogo') return 'nogo';
  if (block.score >= 75) return 'excellent';
  if (block.score >= 55) return 'good';
  if (block.score >= 35) return 'fair';
  return 'poor';
}

function renderDay() {
  if (!wx) return;
  const spot = activeSpot();
  const mode = MODES[spot.mode];
  const nowMs = Date.now();
  const dayStr = localDayStr(dayOffset);

  setUnits(state.units);
  const day = scoreDay({ mode: spot.mode, spot, wx, marine, dayStr, nowMs });
  lastDay = day;

  // hero: lead with the answer — the best upcoming window
  const hero = $('#hero');
  {
    const upcoming = day.blocks.filter((b) => !(b.past && dayOffset === 0));
    const pool = upcoming.length ? upcoming : day.blocks;
    const best = pool.reduce((a, b) => (b.score > a.score ? b : a));
    const dayWord = dayOffset === 0 ? 'today' : dayOffset === 1 ? 'tomorrow' : 'this day';
    hero.hidden = false;
    hero.dataset.rating = ratingKey(best);
    hero.innerHTML = `
      <p class="hero-kicker">Best window ${dayWord}</p>
      <div class="hero-main">
        <div class="hero-when">
          <p class="hero-block">${best.name} · ${String(best.start).padStart(2, '0')}:00–${String(best.end).padStart(2, '0')}:00</p>
          <p class="hero-reason">${best.reason}</p>
        </div>
        <div class="hero-score">
          <span class="hero-num">${best.score}<em>/100</em></span>
          <span class="label-pill">${best.label}</span>
        </div>
      </div>
      <div class="hero-meter" role="presentation"><i style="--w:${best.score}%"></i></div>`;
  }

  // summary strip
  const parts = [];
  if (day.sun.sunrise) parts.push(`<span><b>Sun</b> ${fmtTime(day.sun.sunrise)} – ${fmtTime(day.sun.sunset)}</span>`);
  parts.push(`<span><b>Moon</b> ${day.moonPhaseName} · ${Math.round(day.moonFraction * 100)}%</span>`);
  if (day.tides.length) {
    const t = day.tides.map((x) => `${x.type === 'high' ? 'H' : 'L'} ${fmtTime(x.t)}`).join(' · ');
    parts.push(`<span><b>Tide</b> ${t}</span>`);
  }
  if (day.waterTemp != null) parts.push(`<span><b>Water</b> ${fmtTemp(day.waterTemp)}</span>`);
  $('#summary').innerHTML = parts.join('');

  // boat go/no-go banner + weather window
  const banner = $('#banner');
  if (spot.mode === 'boat') {
    const from = dayOffset === 0 ? nowMs : Date.parse(`${dayStr}T04:00:00Z`) - wx.offsetSec * 1000;
    const win = weatherWindow({ wx, marine, fromMs: from });
    if (win) {
      banner.hidden = false;
      banner.dataset.status = win.status;
      banner.querySelector('.banner-title').textContent =
        win.status === 'go' ? 'Go' : win.status === 'caution' ? 'Caution' : "Don't launch";
      banner.querySelector('.banner-text').textContent = win.text;
    } else {
      banner.hidden = true;
    }
  } else {
    banner.hidden = true;
  }

  // day shape: six bars showing how the day's bite curve runs (tap → card)
  $('#shape-card').hidden = false;
  const shape = $('#dayshape');
  shape.innerHTML = day.blocks.map((b, i) => `
    <button type="button" class="bar${b.past && dayOffset === 0 ? ' past' : ''}${b.current && dayOffset === 0 ? ' current' : ''}"
      data-rating="${ratingKey(b)}" data-i="${i}" aria-label="${b.name}: ${b.score} out of 100, ${b.label}">
      <i style="--hf:${Math.max(b.score, 5) / 100}"></i><span>${String(b.start).padStart(2, '0')}</span>
    </button>`).join('');
  for (const btn of shape.querySelectorAll('.bar')) {
    btn.addEventListener('click', () => {
      const row = $('#blocks').children[Number(btn.dataset.i)];
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('flash');
      void row.offsetWidth; // restart the animation
      row.classList.add('flash');
    });
  }

  // six block rows
  const list = $('#blocks');
  list.innerHTML = '';
  for (const b of day.blocks) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.rating = ratingKey(b);
    if (b.past && dayOffset === 0) li.classList.add('past');
    if (b.current && dayOffset === 0) li.classList.add('current');
    const cond = condLine(b.conditions);
    li.innerHTML = `
      <div class="row-main">
        <p class="row-name">${b.name}${b.current && dayOffset === 0 ? '<em class="now">Now</em>' : ''}</p>
        <p class="row-hours">${String(b.start).padStart(2, '0')}:00–${String(b.end).padStart(2, '0')}:00</p>
        <p class="row-reason">${b.reason}</p>
        ${cond ? `<p class="row-cond">${cond}</p>` : ''}
      </div>
      <div class="row-score">
        <span class="score-num">${b.score}<em>/100</em></span>
        <span class="label-pill">${b.label}</span>
      </div>`;
    list.appendChild(li);
  }

  // notices
  const notes = [];
  if (mode.usesTide && !day.tideAvailable) {
    notes.push('No tide data for this spot — tide weight shifted to pressure + solunar.');
  }
  if (wx.stale) notes.push('Offline — showing last cached forecast.');
  const notice = $('#notice');
  notice.hidden = notes.length === 0;
  notice.textContent = notes.join(' ');

  renderWeather(day, dayStr, nowMs);
}

// --- weather view (charts) ---

function daySlice(epochs, values, t0, t1) {
  const out = [];
  if (!values) return out;
  for (let i = 0; i < epochs.length; i++) {
    if (epochs[i] >= t0 && epochs[i] <= t1 && values[i] != null) out.push({ t: epochs[i], v: values[i] });
  }
  return out;
}

function mountChart(cardId, built, series, fmtVal, idleText) {
  const card = $(cardId);
  card.hidden = false;
  card.querySelector('.chart-svg').innerHTML = built.html;
  const readout = card.querySelector('.chart-readout');
  if (readout) {
    attachScrub(card.querySelector('svg'), built.meta, series, wx.offsetSec, readout, fmtVal, idleText);
  }
}

function renderWeather(day, dayStr, realNow) {
  const t0 = Date.parse(`${dayStr}T00:00:00Z`) - wx.offsetSec * 1000;
  const t1 = t0 + DAY_MS;
  const nowMs = dayOffset === 0 ? realNow : null;
  const off = wx.offsetSec;

  // right now (today only)
  const nowCard = $('#wx-now');
  if (dayOffset === 0) {
    const at = (arr) => interp(wx.epochs, arr, realNow);
    const wind = at(wx.wind);
    const dir = at(wx.windDir);
    const cells = [
      { ic: IC.temp, v: fmtTemp(at(wx.temp)), l: 'Air' },
      { ic: windGlyph(dir) || '', v: wind != null ? `${compass(dir ?? 0)} ${windVal(wind)} ${windUnit()}` : '—', l: 'Wind' },
      { ic: IC.rain, v: `${Math.round(at(wx.rainProb) ?? 0)}%`, l: 'Rain' },
      { ic: IC.cloud, v: `${Math.round(at(wx.cloud) ?? 0)}%`, l: 'Cloud' },
    ];
    nowCard.hidden = false;
    nowCard.innerHTML = `<div class="chart-head"><h2 class="chart-title">Right now · ${fmtHM(realNow, off)}</h2></div>
      <div class="now-grid">${cells.map((c) => `<div class="now-cell">${c.ic}<b>${c.v}</b><span>${c.l}</span></div>`).join('')}</div>`;
  } else {
    nowCard.hidden = true;
  }

  // tide — model heights are relative to mean sea level (negative half the
  // cycle); shift so the window's lowest tide reads 0, like a tide table
  const tideCard = $('#wx-tide');
  if (marine && marine.seaLevel) {
    const known = marine.seaLevel.filter((v) => v != null);
    const datum = known.length ? Math.min(...known) : 0;
    const series = daySlice(marine.epochs, marine.seaLevel, t0, t1)
      .map((p) => ({ t: p.t, v: p.v - datum }));
    const tides = tideExtrema(marine);
    if (series.length > 3) {
      const extrema = (tides ? tides.extrema : []).map((x) => ({ ...x, h: x.h - datum }));
      const built = tideChart({ series, extrema, t0, t1, nowMs, offsetSec: off });
      const water = day.waterTemp != null ? `Water ${fmtTemp(day.waterTemp)}` : '';
      mountChart('#wx-tide', built, series, (v) => heightStr(v), water);
    } else {
      tideCard.hidden = true;
    }
  } else {
    tideCard.hidden = true;
  }

  // sun & moon
  const sunCard = $('#wx-sun');
  if (day.sun.sunrise) {
    sunCard.hidden = false;
    const built = sunArc({ sunrise: day.sun.sunrise, sunset: day.sun.sunset, nowMs, offsetSec: off });
    sunCard.querySelector('.chart-svg').innerHTML = built.html;
    const ev = moonEvents(t0, t1, activeSpot().lat, activeSpot().lng);
    const times = [
      ev.rises.length ? `rises ${fmtHM(ev.rises[0], off)}` : null,
      ev.sets.length ? `sets ${fmtHM(ev.sets[0], off)}` : null,
    ].filter(Boolean).join(' · ');
    sunCard.querySelector('.moon-row').innerHTML =
      `${moonIcon(day.moonPhase)}<span><b>${day.moonPhaseName}</b> · ${Math.round(day.moonFraction * 100)}% lit${times ? ' · ' + times : ''}</span>`;
  } else {
    sunCard.hidden = true;
  }

  // wind
  const windSeries = daySlice(wx.epochs, wx.wind, t0, t1);
  if (windSeries.length > 3) {
    const gusts = daySlice(wx.epochs, wx.gust, t0, t1);
    const built = windChart({ series: windSeries, gusts, t0, t1, nowMs, offsetSec: off, conv: (v) => windVal(v) });
    mountChart('#wx-wind', built, windSeries, (v) => `${windVal(v)} ${windUnit()}`, `${windUnit()}`);
  } else {
    $('#wx-wind').hidden = true;
  }

  // temperature
  const tempSeries = daySlice(wx.epochs, wx.temp, t0, t1);
  if (tempSeries.length > 3) {
    const built = tempChart({ series: tempSeries, t0, t1, nowMs, offsetSec: off, conv: (v) => (state.units === 'imperial' ? v * 1.8 + 32 : v) });
    mountChart('#wx-temp', built, tempSeries, (v) => fmtTemp(v), '');
  } else {
    $('#wx-temp').hidden = true;
  }

  // rain probability
  const rainCard = $('#wx-rain');
  const rainSeries = daySlice(wx.epochs, wx.rainProb, t0, t1);
  if (rainSeries.length > 3) {
    rainCard.hidden = false;
    if (rainSeries.every((p) => (p.v ?? 0) < 3)) {
      rainCard.querySelector('.chart-svg').innerHTML = '<p class="chart-empty">No rain expected — dry day on the water.</p>';
      rainCard.querySelector('.chart-readout').textContent = '';
    } else {
      const built = rainChart({ series: rainSeries, t0, t1, nowMs, offsetSec: off });
      mountChart('#wx-rain', built, rainSeries, (v) => `${Math.round(v)}%`, '');
    }
  } else {
    rainCard.hidden = true;
  }
}

async function loadAndRender() {
  const spot = activeSpot();
  const token = ++loadToken;
  renderSpotButton();
  renderModeControl();
  skeleton();
  try {
    const needMarine = MODES[spot.mode].usesMarine || MODES[spot.mode].usesTide;
    const [fc, ma] = await Promise.all([
      fetchForecast(spot.lat, spot.lng),
      needMarine ? fetchMarine(spot.lat, spot.lng) : Promise.resolve(null),
    ]);
    if (token !== loadToken) return; // superseded by a newer load
    wx = fc;
    marine = ma;
    renderDayTabs();
    renderDay();
  } catch (err) {
    if (token !== loadToken) return;
    showError(`Couldn't load forecast data (${err.message}). Check your connection.`);
  }
}

// --- spot sheet ---

function renderSpotSheet() {
  const list = $('#spot-list');
  list.innerHTML = '';
  for (const s of state.spots) {
    const li = document.createElement('li');
    li.className = 'spot-row';
    if (s.id === state.activeSpotId) li.classList.add('active');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spot-pick';
    btn.innerHTML = `<span class="spot-pick-name">${s.name}</span><span class="spot-pick-meta">${MODES[s.mode].label}${s.region ? ' · ' + s.region : ''}</span>`;
    btn.addEventListener('click', () => {
      state.activeSpotId = s.id;
      dayOffset = 0;
      persist();
      renderSpotSheet();
      $('#spot-sheet').close();
      loadAndRender();
    });
    li.appendChild(btn);
    if (state.spots.length > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'spot-del';
      del.setAttribute('aria-label', `Remove ${s.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => {
        state.spots = state.spots.filter((x) => x.id !== s.id);
        if (state.activeSpotId === s.id) state.activeSpotId = state.spots[0].id;
        persist();
        renderSpotSheet();
        renderSpotButton();
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  }

  // facing selector for the active spot (shore wind-direction logic)
  const spot = activeSpot();
  const facingRow = $('#facing-row');
  facingRow.hidden = spot.mode !== 'shore';
  if (!facingRow.hidden) {
    const sel = $('#facing-select');
    sel.value = spot.facing == null ? '' : String(spot.facing);
  }

  // units
  for (const btn of document.querySelectorAll('#units-control .seg-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.units === state.units));
  }
}

let searchTimer = null;
function wireSpotSheet() {
  $('#spot-btn').addEventListener('click', () => {
    renderSpotSheet();
    $('#search-results').innerHTML = '';
    $('#spot-search').value = '';
    $('#spot-sheet').showModal();
  });
  $('#sheet-close').addEventListener('click', () => $('#spot-sheet').close());
  $('#spot-sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop tap
  });

  $('#spot-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 3) {
      $('#search-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const results = await geocode(q);
        const ul = $('#search-results');
        ul.innerHTML = '';
        if (!results.length) {
          ul.innerHTML = '<li class="search-empty">No places found</li>';
          return;
        }
        for (const r of results) {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'spot-pick';
          btn.innerHTML = `<span class="spot-pick-name">${r.name}</span><span class="spot-pick-meta">${r.region}</span>`;
          btn.addEventListener('click', () => {
            const id = `s${Date.now().toString(36)}`;
            state.spots.push({ id, name: r.name, region: r.region, lat: r.lat, lng: r.lng, mode: 'shore', facing: null });
            track('spot-add');
            state.activeSpotId = id;
            dayOffset = 0;
            persist();
            $('#spot-sheet').close();
            loadAndRender();
          });
          li.appendChild(btn);
          ul.appendChild(li);
        }
      } catch {
        $('#search-results').innerHTML = '<li class="search-empty">Search failed — try again</li>';
      }
    }, 350);
  });

  $('#facing-select').addEventListener('change', (e) => {
    const spot = activeSpot();
    spot.facing = e.target.value === '' ? null : Number(e.target.value);
    persist();
    renderDay();
  });

  for (const btn of document.querySelectorAll('#units-control .seg-btn')) {
    btn.addEventListener('click', () => {
      state.units = btn.dataset.units;
      persist();
      renderSpotSheet();
      renderDay();
    });
  }
}

// --- share ---

const BLOCK_PHRASE = {
  early: 'in the early morning', morning: 'in the morning', midday: 'around midday',
  afternoon: 'in the afternoon', evening: 'in the evening', night: 'tonight',
};

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

async function shareForecast() {
  if (!lastDay) return;
  const spot = activeSpot();
  const upcoming = lastDay.blocks.filter((b) => !(b.past && dayOffset === 0));
  const pool = upcoming.length ? upcoming : lastDay.blocks;
  const best = pool.reduce((a, b) => (b.score > a.score ? b : a));
  const dayWord = dayOffset === 0 ? 'today' : dayOffset === 1 ? 'tomorrow' : `on ${localDayStr(dayOffset)}`;
  const phrase = BLOCK_PHRASE[best.key] || '';
  const reason = best.reason.charAt(0).toLowerCase() + best.reason.slice(1);
  const text = `FishCast: ${spot.name} looks ${best.label} ${phrase} ${dayWord} (${best.score}/100) — ${reason}.`;
  const url = location.origin + location.pathname;
  track('share');
  if (navigator.share) {
    try {
      await navigator.share({ title: 'FishCast', text, url });
      return;
    } catch { /* user cancelled — fall through to clipboard */ }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Copied to clipboard');
  } catch {
    toast('Could not share on this device');
  }
}

// --- boot ---

function switchView(view) {
  $('#view-forecast').hidden = view !== 'forecast';
  $('#view-weather').hidden = view !== 'weather';
  $('#tab-forecast').setAttribute('aria-pressed', String(view === 'forecast'));
  $('#tab-weather').setAttribute('aria-pressed', String(view === 'weather'));
  if (view === 'weather') track('weather-view');
}

wireSpotSheet();
$('#share-btn').addEventListener('click', shareForecast);
$('#tab-spots').addEventListener('click', () => $('#spot-btn').click());
$('#tab-forecast').addEventListener('click', () => switchView('forecast'));
$('#tab-weather').addEventListener('click', () => switchView('weather'));
loadAndRender();
// refresh scores every 10 min so "now" markers and windows stay honest
setInterval(() => { if (wx) renderDay(); }, 10 * 60000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* http dev or unsupported */ });
}
