---
name: ficta brand
description: Dark-only identity for ficta — the local redaction gateway for model traffic.
logo_direction: 2c · Token Wrapper
core_colors:
  vermilion: "#F1552F"   # oklch(0.67 0.2 33)
  ink: "#0A0A0C"         # oklch(0.165 0.006 264)
  chalk: "#F3F1EA"       # oklch(0.96 0.004 90)
  stamp-ink: "#1A130F"   # oklch(0.16 0.02 40)
signal_colors:
  restored-mint: "oklch(0.86 0.15 165)"   # semantic only — never brand/decoration
supporting_neutrals:
  panel: "oklch(0.205 0.007 264)"
  graphite: "oklch(0.245 0.008 264)"
  muted-chalk: "oklch(0.73 0.006 264)"
  redaction-bar: "oklch(0.29 0.006 264)"
  hairline: "oklch(1 0 0 / 10%)"
  signal-red: "oklch(0.63 0.21 27)"        # destructive/error only
typography:
  display: "Hanken Grotesk, 600, letter-spacing -0.02em"
  body: "Hanken Grotesk, 400, line-height 1.625"
  mono: "Fragment Mono, 400"
---

# ficta — Design System

## 1. Overview

**North star: "The Token Wrapper."** ficta replaces a real value with a local surrogate before a request leaves for the model, then restores it on the way back. The identity makes that literal: the wordmark is wrapped in brackets — `[ficta]` — the value becoming a token on the wire. Near-black **ink** is the page; a single saturated **vermilion** is the stamp (logo, CTAs, selection, wire labels); one **mint** is the sole reply, and it means exactly one thing — a real value stayed local.

The system is dark-only by design. It rejects cybersecurity theater (padlocks, shields, matrix green, fear copy) and flashy AI-SaaS grammar (gradient text, glassmorphism, orbs, hero-metric blocks). Expressiveness lives in typography, the vermilion stamp, and motion — never in adjectives or security imagery.

## 2. Logo

**Direction 2c — Token Wrapper.**

- **Mark:** two vermilion brackets wrapping a chalk value block. The brackets are the tokenization; the block is the value being wrapped. Transparent-background SVG in `ficta-mark.svg`; single-color stamp in `ficta-mark-mono.svg`.
- **Wordmark:** `[ficta]` — Fragment Mono, tight-tracked, brackets in vermilion, letters in chalk (`ficta-wordmark.svg`, font embedded).
- **Lockup:** mark + clean `ficta` wordmark, horizontal (`ficta-lockup.svg`). The mark carries the brackets, so the word beside it is unbracketed.
- **App icon / favicon:** the mark centered on a rounded ink tile (`ficta-icon.svg` = `favicon.svg`); inverted vermilion tile in `ficta-icon-vermilion.svg`. Rasters at 512 / 180 / 32 in `png/`.
- **Clear space:** ≥ the height of the value block on all sides.
- **Don't:** recolor the brackets to mint, add a second accent, place the mark on busy imagery, or stretch the wordmark.

## 3. Colors

### Core palette
A near-monochrome ink field where vermilion is the only voice.

- **Vermilion Stamp** — `#F1552F` / `oklch(0.67 0.2 33)`. Brand + every CTA, the wordmark brackets, `::selection`, wire labels, focus rings, and — at ≤14% alpha — the corner radial wash. Brand and call-to-action, simultaneously.
- **Stamp Ink** — `#1A130F` / `oklch(0.16 0.02 40)`. Text on vermilion; a warm near-black so primary buttons read as stamped, not glowing.
- **Ink** — `#0A0A0C` / `oklch(0.165 0.006 264)`. The page. Cool, near-black.
- **Chalk** — `#F3F1EA` / `oklch(0.96 0.004 90)`. Headings and primary text; 85–90% alpha for code on panels.

### Signal — semantic, *not* a brand color
- **Restored Mint** — `oklch(0.86 0.15 165)`. Appears **only** when a real value stays local: restored values in the wire demo, list checkmarks, the "on your machine" label, the eyebrow status dot. Kept scarce so it always reads as "the real thing stayed local." **Never in the logo, never as a generic accent, link, or success color.**

### Supporting neutrals
- **Panel** `oklch(0.205 0.007 264)` — cards, the wire demo. One tonal step above ink.
- **Graphite** `oklch(0.245 0.008 264)` — muted surfaces, quiet-control hovers.
- **Muted Chalk** `oklch(0.73 0.006 264)` — secondary copy, nav at rest. AA floor for body text.
- **Redaction Bar** `oklch(0.29 0.006 264)` — fill behind tokenized values (`FICTA_…`).
- **Hairline** `oklch(1 0 0 / 10%)` — all borders and dividers (white-alpha, sits on any tone).
- **Signal Red** `oklch(0.63 0.21 27)` — destructive/error only. Never decorative; kept distinct from vermilion by context.

### Named rules
- **Vermilion is the stamp.** It carries brand, CTAs, and redaction semantics — nothing else. Sanctioned exception: a corner radial wash at ≤14% alpha.
- **Mint means restored.** Only for a real value staying local. If it's decorative, it's wrong.
- **Dark only.** There is no light theme. Every color decision assumes the ink field.

## 4. Typography

- **Display / body:** **Hanken Grotesk** — a warm humanist grotesk does all the human talking. Display 600 / `clamp(2.5rem, 4.2vw, 3.3rem)` / -0.02em; body 400 / 1rem / 1.625.
- **Mono:** **Fragment Mono** — a typewriter-flavored mono does all the machine talking: the wordmark, install command, request bodies, tokens, and mono kickers.
- **Mono means wire.** Fragment Mono only for material that is literally protocol, code, or terminal. Human prose never sets in mono; wire content never sets in the grotesk.
- **Muted second voice.** Hierarchy inside a heading is made with Muted Chalk on the trailing phrase, not size or a second font. h1–h3 `text-wrap: balance`; prose `text-wrap: pretty`.

## 5. Elevation & motion

Flat and border-led: three tonal steps (Ink → Panel → Graphite) separated by white-alpha hairlines. Exactly one object floats — the wire demo card (`shadow-2xl` at 40% black). The sticky header separates with `backdrop-blur` over 80% ink + a hairline, not a shadow. Motion is one vocabulary: a 14px rise-and-fade (`0.7s`, `cubic-bezier(0.22, 1, 0.36, 1)`), gated on `prefers-reduced-motion: no-preference` so the page is fully visible by default.

## 6. Do / Don't

**Do** keep vermilion scarce enough to stay loud; show the mechanism (redact→restore) instead of security imagery; hold WCAG AA on the ink field (Muted Chalk is the body-text floor); pair the vermilion/mint semantics with text or shape, never color alone.

**Don't** ship cybersecurity theater; use gradient text, glassmorphism, or orb backgrounds; put mint in the logo or use it for generic success; add a light theme; or over-claim beyond tokenization + local restore.
