# Product

## Register

product

## Users

Recreational anglers (bank, rock-and-surf shore, small-boat offshore), initially in South Africa (Durban / KZN coast default) but global by design. Context of use: checking the phone at 4:30am before a session, planning tomorrow evening from the couch, or deciding at the slipway whether to launch. One-handed mobile use, often in low light (pre-dawn) or bright sun (beach glare).

## Product Purpose

Rates fishing quality for a chosen spot across six fixed time-of-day blocks (Early Morning through Night), each with a 0–100 score, a Poor/Fair/Good/Excellent label, and a one-line reason. Combines solunar periods, barometric pressure trend, tides, dawn/dusk windows, and moon phase, gated by weather comfort/safety. Three modes (Freshwater / Shore / Boat) share one scoring engine with per-mode config. Success = the user can decide *when to go* in under ten seconds, and trusts the reason line enough to act on it.

## Brand Personality

Practical, legible, quietly confident. A tide-table taped to a bait-shop wall, not a SaaS dashboard. Numbers and reasons over decoration. Three words: honest, sharp, weatherworn.

## Anti-references

- Generic weather-app gradients (sunset purple hero panels, glassy cards).
- Fishing-brand kitsch: fish silhouettes everywhere, bobber icons, "gone fishin'" typefaces.
- SaaS metric-dashboard styling (hero KPI tiles, sparkline confetti).
- Anything that hides the score behind taps — all six blocks always visible.

## Design Principles

1. **Answer first** — score, label, reason visible for every block without interaction.
2. **Reasons earn trust** — every number is explained in plain angler language ("falling pressure + incoming tide"), never just a value.
3. **Safety overrides score** — the weather gate and boat go/no-go are visually louder than any good score.
4. **The Almanac identity** — white paper, serif numerals, hairline rules: a beautifully typeset tide almanac, chosen by Chris over dark/sporty directions (2026-07-08). Optimized for legibility in full beach sun; high contrast keeps it usable pre-dawn too.
5. **Coordinates, not places** — no location-specific logic; everything derives from lat/lng, timezone, and season-by-latitude.

## Accessibility & Inclusion

WCAG AA contrast (4.5:1 body text) on the dark theme. Score labels never rely on color alone (text label always present). Reduced-motion alternative for all transitions. Touch targets ≥44px. Works offline-ish: cached last fetch shown with a stale notice.
