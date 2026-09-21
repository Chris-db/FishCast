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

## Live

https://chris-db.github.io/FishCast/

## License

MIT — see [LICENSE](LICENSE).
