import { fetchForecast, fetchMarine, geocode } from './data.js';
import { BLOCKS, MODES, scoreDay, weatherWindow, setUnits } from './engine.js';

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

/** Compact per-block conditions: wind, temp, rain, cloud, swell. */
function condLine(w) {
  if (!w) return '';
  const parts = [];
  if (w.wind != null) {
    let wind = '';
    if (w.windDir != null) {
      // arrow shows where the wind blows TO; label is the standard FROM compass
      const rot = Math.round((w.windDir + 180) % 360);
      wind += `<svg class="warrow" viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(${rot}deg)"><path d="M6 1l3.4 8-3.4-2.2L2.6 9Z"/></svg>${compass(w.windDir)} `;
    }
    wind += `${windVal(w.wind)}`;
    if (w.gust != null && w.gust >= w.wind + 9) wind += `–${windVal(w.gust)}`;
    parts.push(`${wind} ${windUnit()}`);
  }
  if (w.temp != null) parts.push(fmtTemp(w.temp));
  if (w.rainProb != null && (w.rainProb >= 15 || (w.rain ?? 0) > 0.2)) parts.push(`rain ${Math.round(w.rainProb)}%`);
  if (w.cloud != null) parts.push(`cloud ${Math.round(w.cloud)}%`);
  if (w.swell != null) parts.push(`swell ${heightStr(w.swell)}${w.swellPeriod ? ` @ ${Math.round(w.swellPeriod)} s` : ''}`);
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
  $('#dayshape').hidden = true;
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
  $('#share-btn').hidden = false;

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

  // day shape: six bars showing how the day's bite curve runs
  const shape = $('#dayshape');
  shape.hidden = false;
  shape.innerHTML = day.blocks.map((b) => `
    <div class="bar${b.past && dayOffset === 0 ? ' past' : ''}${b.current && dayOffset === 0 ? ' current' : ''}" data-rating="${ratingKey(b)}">
      <i style="--hf:${Math.max(b.score, 5) / 100}"></i><span>${String(b.start).padStart(2, '0')}</span>
    </div>`).join('');

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
        <span class="ring">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle class="ring-bg" cx="22" cy="22" r="19" pathLength="100"/>
            <circle class="ring-fg" cx="22" cy="22" r="19" pathLength="100" style="--p:${b.score}"/>
          </svg>
          <b class="score-num">${b.score}</b>
        </span>
        <span class="score-label">${b.label}</span>
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

wireSpotSheet();
$('#share-btn').addEventListener('click', shareForecast);
loadAndRender();
// refresh scores every 10 min so "now" markers and windows stay honest
setInterval(() => { if (wx) renderDay(); }, 10 * 60000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* http dev or unsupported */ });
}
