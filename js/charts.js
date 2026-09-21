// SVG chart builders for the Weather view. No libraries. All charts are
// single-series (one axis each — never dual-axis); text wears ink tokens,
// series color lives only in the marks. viewBox width is fixed at 360 and
// the svg scales to its card.

const W = 360;
const PAD = { l: 34, r: 12, t: 16, b: 20 };

const INK = '#181a2e';
const INK_FAINT = '#5b6a6c';
const GRID = '#e4eef2';

export const SERIES = {
  tide: '#00808c',
  wind: '#00808c',
  band: '#a9ece5',
  temp: '#8a5f00',
  rain: '#3273b5',
  sun: '#b57d00',
};

export function fmtHM(ms, offsetSec) {
  return new Date(ms + offsetSec * 1000).toISOString().slice(11, 16);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Monotone cubic interpolation (Fritsch–Carlson) — no fake overshoot. */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / (dx[i] || 1e-9);
  }
  t[0] = m[0];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  }
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i][0] + dx[i] / 3, y1 = pts[i][1] + (t[i] * dx[i]) / 3;
    const x2 = pts[i + 1][0] - dx[i] / 3, y2 = pts[i + 1][1] - (t[i + 1] * dx[i]) / 3;
    d += ` C${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function frame(height, t0, t1, offsetSec, yTicks, fmtY) {
  const plotW = W - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * plotW;
  let grid = '';
  for (const yt of yTicks) {
    grid += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yt.py}" y2="${yt.py}" stroke="${GRID}" stroke-width="1"/>` +
      `<text x="${PAD.l - 5}" y="${yt.py + 3}" text-anchor="end" font-size="9" fill="${INK_FAINT}">${esc(fmtY(yt.v))}</text>`;
  }
  let xAxis = '';
  for (let h = 0; h <= 24; h += 6) {
    const tx = x(t0 + h * 3600000);
    xAxis += `<text x="${tx}" y="${height - 6}" text-anchor="middle" font-size="9" fill="${INK_FAINT}">${String(h).padStart(2, '0')}</text>`;
  }
  return { plotW, plotH, x, grid, xAxis };
}

function yScale(vals, plotH, padFrac = 0.15, forceMin = null, forceMax = null) {
  let v0 = forceMin != null ? forceMin : Math.min(...vals);
  let v1 = forceMax != null ? forceMax : Math.max(...vals);
  if (v1 - v0 < 1e-6) { v0 -= 1; v1 += 1; }
  const pad = (v1 - v0) * padFrac;
  if (forceMin == null) v0 -= pad;
  if (forceMax == null) v1 += pad;
  const y = (v) => PAD.t + plotH - ((v - v0) / (v1 - v0)) * plotH;
  return { v0, v1, y };
}

function nowLine(nowMs, t0, t1, x, height) {
  if (nowMs < t0 || nowMs > t1) return '';
  const nx = x(nowMs);
  return `<line x1="${nx}" x2="${nx}" y1="${PAD.t - 4}" y2="${height - PAD.b}" stroke="${INK}" stroke-width="1" stroke-dasharray="3 3" opacity="0.45"/>`;
}

const scrubLayer = () =>
  `<g class="scrub" hidden><line class="scrub-l" y1="${PAD.t}" stroke="${INK}" stroke-width="1" opacity="0.5"/>` +
  `<circle class="scrub-c" r="4" fill="#ffffff" stroke-width="2.5"/></g>`;

/** Tide curve: area + line, H/L markers, now line. */
export function tideChart({ series, extrema, t0, t1, nowMs, offsetSec }) {
  const H = 150;
  const vals = series.map((p) => p.v);
  const { v0, v1, y } = yScale(vals, H - PAD.t - PAD.b);
  const ticks = [v0 + (v1 - v0) * 0.25, v0 + (v1 - v0) * 0.75].map((v) => ({ v, py: y(v) }));
  const { x, grid, xAxis } = frame(H, t0, t1, offsetSec, ticks, (v) => `${v.toFixed(1)}m`);
  const pts = series.map((p) => [x(p.t), y(p.v)]);
  const line = smoothPath(pts);
  const area = `${line} L${x(t1).toFixed(1)},${H - PAD.b} L${x(t0).toFixed(1)},${H - PAD.b} Z`;

  let marks = '';
  for (const e of extrema) {
    if (e.t < t0 || e.t > t1) continue;
    const ex = x(e.t), ey = y(e.h);
    const above = e.type === 'high';
    marks += `<circle cx="${ex}" cy="${ey}" r="3.5" fill="#00535b"/>` +
      `<text x="${ex}" y="${above ? ey - 8 : ey + 15}" text-anchor="middle" font-size="10" font-weight="700" fill="${INK}">${e.type === 'high' ? 'H' : 'L'} ${fmtHM(e.t, offsetSec)}</text>`;
  }

  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tide height through the day">
    <defs><linearGradient id="tidegrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${SERIES.band}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="${SERIES.band}" stop-opacity="0.05"/>
    </linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#tidegrad)"/>
    <path d="${line}" fill="none" stroke="${SERIES.tide}" stroke-width="2" stroke-linejoin="round"/>
    ${marks}${nowLine(nowMs, t0, t1, x, H)}${xAxis}${scrubLayer()}
  </svg>`;
  return { html, meta: { H, t0, t1, v0, v1 } };
}

/** Wind line with gust band (same entity — a range, not a second series). */
export function windChart({ series, gusts, t0, t1, nowMs, offsetSec, unit, conv }) {
  const H = 130;
  const all = series.map((p) => p.v).concat(gusts.map((p) => p.v));
  const { v0, v1, y } = yScale(all, H - PAD.t - PAD.b, 0.12, 0);
  const ticks = [v1 * 0.33, v1 * 0.8].map((v) => ({ v, py: y(v) }));
  const { x, grid, xAxis } = frame(H, t0, t1, offsetSec, ticks, (v) => `${Math.round(conv(v))}`);
  const wPts = series.map((p) => [x(p.t), y(p.v)]);
  const gPts = gusts.map((p) => [x(p.t), y(p.v)]);
  const gLast = gPts.length ? gPts[Math.floor(gPts.length * 0.72)] : null;
  const band = gPts.length
    ? `<path d="${smoothPath(gPts)} L${wPts.slice().reverse().map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')} Z" fill="${SERIES.band}" opacity="0.55"/>`
    : '';

  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Wind and gusts through the day">
    ${grid}${band}
    <path d="${smoothPath(wPts)}" fill="none" stroke="${SERIES.wind}" stroke-width="2" stroke-linejoin="round"/>
    ${gLast ? `<text x="${gLast[0]}" y="${gLast[1] - 5}" font-size="9" font-weight="600" fill="${INK_FAINT}">gusts</text>` : ''}
    ${nowLine(nowMs, t0, t1, x, H)}${xAxis}${scrubLayer()}
  </svg>`;
  return { html, meta: { H, t0, t1, v0, v1 } };
}

/** Temperature line. */
export function tempChart({ series, t0, t1, nowMs, offsetSec, conv }) {
  const H = 110;
  const { v0, v1, y } = yScale(series.map((p) => p.v), H - PAD.t - PAD.b);
  const ticks = [v0 + (v1 - v0) * 0.25, v0 + (v1 - v0) * 0.75].map((v) => ({ v, py: y(v) }));
  const { x, grid, xAxis } = frame(H, t0, t1, offsetSec, ticks, (v) => `${Math.round(conv(v))}°`);
  const pts = series.map((p) => [x(p.t), y(p.v)]);
  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Air temperature through the day">
    ${grid}<path d="${smoothPath(pts)}" fill="none" stroke="${SERIES.temp}" stroke-width="2" stroke-linejoin="round"/>
    ${nowLine(nowMs, t0, t1, x, H)}${xAxis}${scrubLayer()}
  </svg>`;
  return { html, meta: { H, t0, t1, v0, v1 } };
}

/** Rain probability bars (hourly, 0–100%). */
export function rainChart({ series, t0, t1, nowMs, offsetSec }) {
  const H = 100;
  const plotH = H - PAD.t - PAD.b;
  const { y } = yScale([], plotH, 0, 0, 100);
  const ticks = [{ v: 50, py: y(50) }];
  const { plotW, x, grid, xAxis } = frame(H, t0, t1, offsetSec, ticks, (v) => `${v}%`);
  const bw = Math.max(2, plotW / 24 - 2); // 2px surface gap between bars
  let bars = '';
  for (const p of series) {
    const bh = Math.max(0, ((p.v || 0) / 100) * plotH);
    if (bh < 0.5) continue;
    bars += `<rect x="${(x(p.t) - bw / 2).toFixed(1)}" y="${(PAD.t + plotH - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${SERIES.rain}"/>`;
  }
  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rain probability through the day">
    ${grid}${bars}${nowLine(nowMs, t0, t1, x, H)}${xAxis}${scrubLayer()}
  </svg>`;
  return { html, meta: { H, t0, t1, v0: 0, v1: 100 } };
}

/** Daylight arc with sun position. */
export function sunArc({ sunrise, sunset, nowMs, offsetSec }) {
  const H = 142;
  const cx = W / 2, cy = H - 34, r = 96;
  const pos = (f) => {
    const a = Math.PI - f * Math.PI; // sunrise (f=0) on the left
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (fa, fb) => {
    const [x1, y1] = pos(fa), [x2, y2] = pos(fb);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };
  let f = (nowMs - sunrise) / (sunset - sunrise);
  const daylight = f >= 0 && f <= 1;
  f = Math.min(1, Math.max(0, f));
  const [sx, sy] = pos(f);
  const sun = nowMs != null
    ? `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="7" fill="${SERIES.sun}" stroke="#ffffff" stroke-width="2.5"/>`
    : '';
  const elapsed = f > 0.005 ? `<path d="${arc(0, f)}" fill="none" stroke="${SERIES.sun}" stroke-width="4" stroke-linecap="round"/>` : '';
  const html = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sun position between sunrise and sunset">
    <path d="${arc(0, 1)}" fill="none" stroke="${GRID}" stroke-width="4" stroke-linecap="round"/>
    ${elapsed}${sun}
    <line x1="${cx - r - 12}" x2="${cx + r + 12}" y1="${cy + 1}" y2="${cy + 1}" stroke="${GRID}" stroke-width="1"/>
    <text x="${cx - r}" y="${cy + 16}" text-anchor="middle" font-size="10" font-weight="700" fill="${INK}">${fmtHM(sunrise, offsetSec)}</text>
    <text x="${cx + r}" y="${cy + 16}" text-anchor="middle" font-size="10" font-weight="700" fill="${INK}">${fmtHM(sunset, offsetSec)}</text>
    <text x="${cx - r}" y="${cy + 27}" text-anchor="middle" font-size="8.5" fill="${INK_FAINT}">sunrise</text>
    <text x="${cx + r}" y="${cy + 27}" text-anchor="middle" font-size="8.5" fill="${INK_FAINT}">sunset</text>
  </svg>`;
  return { html, daylight };
}

/** Moon phase disc (approximate, good enough at 18px). */
export function moonIcon(phase, size = 18) {
  const r = size / 2 - 1;
  const c = size / 2;
  // terminator ellipse x-radius sweeps -r..r across the cycle
  const k = Math.cos(phase * 2 * Math.PI) * r;
  const waxing = phase < 0.5;
  const lit = `M${c},${c - r} A${r},${r} 0 0 ${waxing ? 1 : 0} ${c},${c + r} A${Math.abs(k).toFixed(2)},${r} 0 0 ${(waxing ? k < 0 : k > 0) ? 1 : 0} ${c},${c - r} Z`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="#dfe9ee"/>
    <path d="${lit}" fill="${SERIES.sun}" opacity="0.9"/>
  </svg>`;
}

/** Scrub-to-read: pointer over the chart shows time + value in the readout. */
export function attachScrub(svgEl, meta, series, offsetSec, readoutEl, fmtVal, idleText) {
  const g = svgEl.querySelector('.scrub');
  if (!g || !series.length) return;
  const line = g.querySelector('.scrub-l');
  const dot = g.querySelector('.scrub-c');
  line.setAttribute('y2', meta.H - PAD.b);
  const plotW = W - PAD.l - PAD.r;
  const plotH = meta.H - PAD.t - PAD.b;

  const show = (clientX) => {
    const rect = svgEl.getBoundingClientRect();
    const vx = ((clientX - rect.left) / rect.width) * W;
    const t = meta.t0 + ((vx - PAD.l) / plotW) * (meta.t1 - meta.t0);
    let best = series[0];
    for (const p of series) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = PAD.l + ((best.t - meta.t0) / (meta.t1 - meta.t0)) * plotW;
    const py = PAD.t + plotH - ((best.v - meta.v0) / (meta.v1 - meta.v0)) * plotH;
    g.hidden = false;
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    readoutEl.textContent = `${fmtHM(best.t, offsetSec)} · ${fmtVal(best.v)}`;
  };
  const hide = () => {
    g.hidden = true;
    readoutEl.textContent = idleText;
  };
  svgEl.style.touchAction = 'pan-y';
  svgEl.addEventListener('pointermove', (e) => show(e.clientX));
  svgEl.addEventListener('pointerdown', (e) => show(e.clientX));
  svgEl.addEventListener('pointerleave', hide);
  svgEl.addEventListener('pointercancel', hide);
  hide();
}
