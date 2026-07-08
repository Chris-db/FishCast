# FishCast

Rates fishing quality for any spot on Earth across six fixed time-of-day blocks
(Early Morning 4–7 → Night 19–22, always in the spot's local time). Every block
gets a 0–100 score, a Poor/Fair/Good/Excellent label, and a one-line reason.

Static site — no build step, no API keys. Serve the folder and open it:

```
python -m http.server 8140 --directory .
```

## How scoring works

One engine (`js/engine.js`), one config object per mode:

| Factor | Shore | Freshwater | Boat |
|---|---|---|---|
| Solunar (moon transits ±1h major, rise/set ±30min minor) | 30% | 40% | 38% |
| Pressure trend (4h delta, falling = best) | 25% | 35% | 31% |
| Tide (moving > slack; last 2h into high = best) | 20% | — | — |
| Dawn/dusk (±1h around sunrise/sunset) | 15% | 15% | 19% |
| Moon phase (new/full amplify solunar) | 10% | 10% | 12% |

The weighted composite is then multiplied by a **weather gate** (1.0 → 0):
wind, gusts, rain, temperature extremes, lightning (thunderstorm code or high
CAPE), and swell height for shore. Freshwater treats light rain as a bonus.
Boat mode adds a hard go/no-go (swell height + steepness + wind) that overrides
any score with **"Don't launch"**, plus a weather-window line
("Good until 11:00 — wind picks up after").

If a spot has no tide data (far inland), tide weight redistributes to
pressure + solunar and a notice is shown.

## Data

- **Open-Meteo** forecast API — pressure, wind + gusts + direction, rain
  amount/probability, temp, cloud cover, CAPE (free, no key)
- **Open-Meteo Marine** API — swell, sea-surface temperature, and
  `sea_level_height_msl` as the global tide signal (modelled; verify against
  official tables before launching a boat)
- **Open-Meteo Geocoding** — spot search
- **Astronomy** — computed locally in `js/astro.js` (SunCalc-style), zero calls

Responses are cached in localStorage (forecast 30 min, marine 3 h) and served
stale when offline. All time math uses the spot's timezone from the API, never
device time. Saved spots, mode per spot, and units persist locally. The app is
an installable PWA (`manifest.webmanifest` + `sw.js` caching the static shell).

## Monetization path (gated — do NOT build ahead of the gates)

The app stays completely free. Revenue steps unlock only on evidence:

- **Gate 1 — ~50–100 returning weekly users** (per analytics): pilot **premium
  alerts** ("notify me when my spot hits Excellent"). First feature worth
  paying for; needs a small backend/push service — plan it as its own project.
- **Gate 2 — audience concentrated in one region**: approach 2–3 **charter
  operators / fishing guides** with a "book when it's Excellent" placement at
  a flat monthly fee. High value per booking (R2k–R5k), no attribution needed.
- **Gate 3 — real sustained traffic**: gear **affiliate links** ("what to
  bring" line) and **flat featured listings** for tackle shops if the sales
  effort is ever worth it.

Explicit non-goals until a gate is hit: user accounts, payments, shop
directories, display ads, pay-per-customer deals (attribution makes those
unverifiable for walk-in retail).

Analytics: GoatCounter snippet is stubbed in `index.html` — create the free
account and swap in the site code to activate.
