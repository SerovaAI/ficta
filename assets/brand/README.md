# ficta — brand assets

Logo direction **2c · Token Wrapper**: the value is wrapped in vermilion brackets — the surrogate it becomes on the wire. Dark-only, precise, no security theater.

## Files
- `ficta-mark.svg` — the icon (brackets + value block). Transparent background.
- `ficta-mark-mono.svg` — single-color version. Set `color` (CSS) or `fill` to re-tint.
- `ficta-wordmark.svg` — the `[ficta]` wordmark. Fragment Mono is embedded, so it renders anywhere.
- `ficta-lockup.svg` — horizontal lockup: mark + `ficta`.
- `ficta-icon.svg` / `favicon.svg` — app icon on the ink tile (rounded square).
- `ficta-icon-vermilion.svg` — inverted app icon (vermilion tile).
- `png/` — rasterized icon + mark at 512 / 180 (Apple touch) / 32 (favicon).
- `DESIGN.md` — the full design system (color, type, logo, do/don't).

## Core palette
| Token | Hex | oklch |
|---|---|---|
| Vermilion stamp | `#F1552F` | `oklch(0.67 0.2 33)` |
| Ink | `#0A0A0C` | `oklch(0.165 0.006 264)` |
| Chalk | `#F3F1EA` | `oklch(0.96 0.004 90)` |
| Stamp ink (on vermilion) | `#1A130F` | `oklch(0.16 0.02 40)` |

## Signal — *not* a brand color
| Token | oklch | Use |
|---|---|---|
| Restored mint | `oklch(0.86 0.15 165)` | **Only** where a real value stays local: restored values, checkmarks, the "on your machine" label, the eyebrow status dot. |

Mint is semantic, not decorative. Keep it scarce so it always means "the real thing stayed local." Never put it in the logo or use it as a general accent.

## Type
Wordmark & tokens: **Fragment Mono** (Google Fonts). Human copy: **Hanken Grotesk**.

## Usage
- Keep clear space around the mark ≥ the height of the value block.
- On dark, use the vermilion mark; for a single-color stamp use `ficta-mark-mono.svg`.
- Favicon: drop `favicon.svg` into the site; use `png/ficta-icon-180.png` for `apple-touch-icon`.
