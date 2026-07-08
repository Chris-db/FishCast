// Open-Meteo data layer. Free, no API key. All responses cached in
// localStorage — forecast briefly, marine (tide curve is precomputed) longer.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const FORECAST_TTL = 30 * 60000; // 30 min
const MARINE_TTL = 3 * 3600000; // 3 h

const cacheKey = (kind, lat, lng) => `fishcast:${kind}:${lat.toFixed(3)},${lng.toFixed(3)}`;

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full — run uncached */
  }
}

async function cachedJson(key, url, ttl) {
  const hit = readCache(key);
  if (hit && Date.now() - hit.at < ttl) return { data: hit.data, stale: false };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    writeCache(key, data);
    return { data, stale: false };
  } catch (err) {
    if (hit) return { data: hit.data, stale: true }; // offline: serve last known
    throw err;
  }
}

/** Convert Open-Meteo local ISO time strings to true UTC epochs. */
function epochAxis(times, offsetSec) {
  return times.map((t) => Date.parse(`${t}:00Z`) - offsetSec * 1000);
}

export async function fetchForecast(lat, lng) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: [
      'pressure_msl',
      'temperature_2m',
      'precipitation',
      'precipitation_probability',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
      'wind_gusts_10m',
      'wind_direction_10m',
      'cape',
    ].join(','),
    past_days: '1',
    forecast_days: '4',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  const { data, stale } = await cachedJson(
    cacheKey('fc2', lat, lng),
    `${FORECAST_URL}?${params}`,
    FORECAST_TTL
  );
  const offsetSec = data.utc_offset_seconds;
  const h = data.hourly;
  return {
    stale,
    timezone: data.timezone,
    offsetSec,
    epochs: epochAxis(h.time, offsetSec),
    pressure: h.pressure_msl,
    temp: h.temperature_2m,
    precip: h.precipitation,
    rainProb: h.precipitation_probability,
    code: h.weather_code,
    cloud: h.cloud_cover,
    wind: h.wind_speed_10m,
    gust: h.wind_gusts_10m,
    windDir: h.wind_direction_10m,
    cape: h.cape,
  };
}

/**
 * Marine data: swell for the safety gate, sea_level_height_msl as the global
 * tide signal. Returns null when the point has no marine coverage (inland).
 */
export async function fetchMarine(lat, lng) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: [
      'wave_height',
      'wave_period',
      'swell_wave_height',
      'swell_wave_period',
      'sea_level_height_msl',
      'sea_surface_temperature',
    ].join(','),
    past_days: '1',
    forecast_days: '4',
    timezone: 'auto',
    cell_selection: 'sea',
  });
  let data, stale;
  try {
    ({ data, stale } = await cachedJson(
      cacheKey('ma2', lat, lng),
      `${MARINE_URL}?${params}`,
      MARINE_TTL
    ));
  } catch {
    return null; // marine API rejects far-inland points
  }
  const h = data.hourly;
  if (!h || !h.time) return null;
  const offsetSec = data.utc_offset_seconds;
  const hasAny = (arr) => Array.isArray(arr) && arr.some((v) => v != null);
  return {
    stale,
    offsetSec,
    epochs: epochAxis(h.time, offsetSec),
    waveHeight: h.wave_height,
    wavePeriod: h.wave_period,
    swellHeight: h.swell_wave_height,
    swellPeriod: h.swell_wave_period,
    seaLevel: hasAny(h.sea_level_height_msl) ? h.sea_level_height_msl : null,
    sst: hasAny(h.sea_surface_temperature) ? h.sea_surface_temperature : null,
    hasSwell: hasAny(h.swell_wave_height) || hasAny(h.wave_height),
  };
}

export async function geocode(query) {
  const params = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
  const res = await fetch(`${GEO_URL}?${params}`);
  if (!res.ok) throw new Error(`Geocoding ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lng: r.longitude,
  }));
}

/** Linear interpolation over an hourly series; null-safe. */
export function interp(epochs, values, t) {
  if (!values) return null;
  if (t <= epochs[0]) return values[0];
  const last = epochs.length - 1;
  if (t >= epochs[last]) return values[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (epochs[mid] <= t) lo = mid;
    else hi = mid;
  }
  const a = values[lo];
  const b = values[hi];
  if (a == null || b == null) return a ?? b;
  const f = (t - epochs[lo]) / (epochs[hi] - epochs[lo]);
  return a + (b - a) * f;
}

/** Indices of hourly samples whose epoch falls in [t0, t1). */
export function idxRange(epochs, t0, t1) {
  const out = [];
  for (let i = 0; i < epochs.length; i++) {
    if (epochs[i] >= t0 && epochs[i] < t1) out.push(i);
  }
  return out;
}
