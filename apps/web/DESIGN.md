---
name: ficta site
description: Dark-only marketing site for ficta — the local redaction gateway for model traffic.
colors:
  ink: "oklch(0.165 0.006 264)"
  chalk: "oklch(0.96 0.004 90)"
  panel: "oklch(0.205 0.007 264)"
  vermilion-stamp: "oklch(0.67 0.2 33)"
  stamp-ink: "oklch(0.16 0.02 40)"
  graphite: "oklch(0.245 0.008 264)"
  muted-chalk: "oklch(0.73 0.006 264)"
  hairline: "oklch(1 0 0 / 10%)"
  input-line: "oklch(1 0 0 / 14%)"
  redaction-bar: "oklch(0.29 0.006 264)"
  restored-mint: "oklch(0.86 0.15 165)"
  signal-red: "oklch(0.63 0.21 27)"
typography:
  display:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 4.2vw, 3.3rem)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 3.5vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Fragment Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0.1em"
  mono:
    fontFamily: "Fragment Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  chip: "3px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "20px"
  lg: "32px"
  card: "28px"
  section: "80px"
  section-lg: "112px"
components:
  button-primary:
    backgroundColor: "{colors.vermilion-stamp}"
    textColor: "{colors.stamp-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "oklch(0.67 0.2 33 / 90%)"
  button-primary-lg:
    backgroundColor: "{colors.vermilion-stamp}"
    textColor: "{colors.stamp-ink}"
    rounded: "{rounded.md}"
    padding: "8px 24px"
    height: "44px"
  button-outline:
    backgroundColor: "oklch(1 0 0 / 4%)"
    textColor: "{colors.chalk}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-chalk}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "36px"
  token-chip:
    backgroundColor: "{colors.redaction-bar}"
    textColor: "oklch(0.96 0.004 90 / 85%)"
    rounded: "{rounded.chip}"
    padding: "2px 6px"
  eyebrow-pill:
    backgroundColor: "oklch(0.205 0.007 264 / 50%)"
    textColor: "{colors.muted-chalk}"
    rounded: "{rounded.pill}"
    padding: "4px 12px 4px 8px"
---

# Design System: ficta site

## 1. Overview

**Creative North Star: "The Redaction Stamp"**

The ficta site is a dark, precise marketing surface built around one physical metaphor: the redaction stamp. Near-black ink is the page; a single saturated vermilion is the stamp — it marks the wordmark's brackets, the CTAs, text selection, and the faint radial wash "bleeding in" at the hero's corner. The identity itself is the brand's **Token Wrapper** direction (`assets/brand/`): the wordmark is `[ficta]`, a value wrapped in vermilion brackets — the surrogate it becomes on the wire. Its counterpart is a sparing mint that means exactly one thing: a real value, restored, still on your machine. The page doesn't argue that the mechanism is safe; it shows the mechanism — a request stamped on the way out, restored on the way back — and lets the honesty of the demo carry the pitch.

The system is bolder than the ficta product UI (large fluid display type, an animated wire demo, atmospheric color washes) but shares its anti-theater DNA. It explicitly rejects cybersecurity theater (padlocks, shields, matrix green, fear copy), flashy AI-SaaS landing grammar (gradient text, glassmorphism, orbs, hero-metric blocks, identical icon-card grids), and generic enterprise-security styling. Expressiveness lives in typography, the stamp, and motion — never in adjectives or security imagery.

Layout is a single scannable page: a 72rem (`max-w-6xl`) container, generous section padding (80px, 112px at desktop), hairline top-borders separating sections instead of background shifts, and content capped at readable measures (`max-w-2xl` intros, `max-w-xl` hero prose). Motion is a single entrance vocabulary — `.animate-rise`, a 14px rise-and-fade on `cubic-bezier(0.22, 1, 0.36, 1)` — gated on `prefers-reduced-motion: no-preference` so the page is fully visible by default and the animation only enhances.

**Key Characteristics:**

- Dark-only, near-black ink surface; no light theme exists by design.
- One vermilion accent carrying both brand identity and every CTA; one mint signal reserved for restored values and affirmative checks.
- Fragment Mono for everything "on the wire" (wordmark, install command, tokens, kickers); Hanken Grotesk for everything human.
- Flat, hairline-bordered surfaces; a single dramatic shadow under the one floating object (the wire demo).
- Honest copy as a design element: limits stated plainly, in body type, on the page.

## 2. Colors

A near-monochrome ink field where vermilion is the only voice and mint is the only reply.

### Primary

- **Vermilion Stamp** (`oklch(0.67 0.2 33)`): The redaction stamp. Primary buttons, the wordmark's brackets, `::selection`, the "→ leaves for the model" wire label, focus rings, and — at ≤14% alpha — the radial washes that anchor the hero and the ficta Gateway card. It is the brand and the call to action, simultaneously.
- **Stamp Ink** (`oklch(0.16 0.02 40)`): Text on vermilion. A warm near-black so primary buttons read as stamped, not glowing.

### Secondary

- **Restored Mint** (`oklch(0.86 0.15 165)`): The restored-value signal. Inline real values in the wire demo, list checkmarks, the "on your machine" label, the copied-state check, the eyebrow's status dot. It always means "the real thing stayed local."

### Neutral

- **Ink** (`oklch(0.165 0.006 264)`): The page background. Cool, near-black, faintly blue-gray.
- **Chalk** (`oklch(0.96 0.004 90)`): Headings and primary text. Warm off-white; used at 85–90% alpha for code on panels.
- **Panel** (`oklch(0.205 0.007 264)`): Cards, the wire demo, popovers — one tonal step above ink, often at 50–70% alpha over it.
- **Graphite** (`oklch(0.245 0.008 264)`): Secondary/muted/accent surfaces; hover fills for quiet controls.
- **Muted Chalk** (`oklch(0.73 0.006 264)`): Secondary copy, nav links at rest, step body text. Passes AA against Ink and Panel; do not lighten surfaces underneath it without rechecking.
- **Redaction Bar** (`oklch(0.29 0.006 264)`): The fill behind tokenized values (`FICTA_…`) — a redaction bar rendered as a chip.
- **Hairline** (`oklch(1 0 0 / 10%)`) / **Input Line** (`oklch(1 0 0 / 14%)`): All borders and dividers. White-alpha so they sit on any panel tone.
- **Signal Red** (`oklch(0.63 0.21 27)`): Destructive/error only. Rare on a marketing page; kept distinct from vermilion by depth and context, never used decoratively.

### Named Rules

**The Vermilion Is The Stamp Rule.** Vermilion carries brand identity, CTAs, and redaction semantics — nothing else. The sanctioned atmospheric exception is a corner-anchored radial wash at ≤14% alpha ("the stamp bleeding in"). If vermilion appears as generic decoration, a divider color, or an icon tint without stamp meaning, it is wrong.

**The Mint Means Restored Rule.** Restored Mint appears only when the UI depicts a real value staying local: restored values, affirmative checkmarks, local-status labels. Never for generic success, links, or accents.

**The Dark Only Rule.** There is no light theme. `<html class="dark">` is hardcoded, `theme-color` is `#0a0a0c`, and every color decision assumes the ink field. Do not introduce light-mode variants.

## 3. Typography

**Display Font:** Hanken Grotesk Variable (ui-sans-serif, system-ui fallback)
**Body Font:** Hanken Grotesk Variable (same family, lighter roles)
**Label/Mono Font:** Fragment Mono (ui-monospace, SF Mono, Menlo fallback)

**Character:** A warm humanist grotesk (with `ss01`/`cv01` alternates and antialiased rendering) does all the human talking; a typewriter-flavored mono does all the machine talking. The pairing contrasts on the exact axis the product does — human intent vs. what's on the wire.

### Hierarchy

- **Display** (600, `clamp(2.5rem, 4.2vw, 3.3rem)`, 0.98, −0.02em): The hero H1 only. Two-line structure with the second line in Muted Chalk ("The model sees a token. / You keep the value."). The cap is sized so each sentence holds a single line inside the hero column at every ≥1024px width — do not raise it without re-measuring the couplet.
- **Headline** (600, `clamp(1.75rem, 3.5vw, 2.5rem)`, 1.25, −0.02em): Section H2s. The ScopeNote uses a quieter `clamp(1.5rem, 3vw, 2rem)`.
- **Title** (600, `1.5rem`, 1.3, −0.02em): Product-card H3s, with the suffix epithet in Muted Chalk ("ficta — the secret airlock"). Step titles drop to `1.125rem`/500.
- **Body** (400, `1rem`, 1.625): Section prose in Muted Chalk. Hero lede runs `1.05rem`. Emphasis inside body is weight-500 Chalk, never color. Keep measures ≤ `max-w-2xl`.
- **Label** (Fragment Mono, `0.75rem`, uppercase, ~0.1em tracking): Kickers ("open source · MIT"), wire-flow dividers ("ficta · redact"). A deliberate, sparing device — not a per-section scaffold.
- **Mono** (Fragment Mono, `0.82rem`, leading-6): The wire demo's request bodies, the install command, inline tokens and kept values (sized `0.82em` when inline).

### Named Rules

**The Mono Means Wire Rule.** Fragment Mono appears only for material that is literally protocol, code, or terminal: the wordmark, the install line, request bodies, tokens, and kickers. Human prose never sets in mono; wire content never sets in the grotesk.

**The Muted Second Voice Rule.** Hierarchy inside a heading is made with Muted Chalk on the trailing phrase, not with size changes or a second font. All h1–h3 get `text-wrap: balance`; prose gets `text-wrap: pretty`.

## 4. Elevation

The system is flat and border-led. Depth comes from three tonal steps (Ink → Panel → Graphite) separated by white-alpha hairlines; sections are divided by 1px top-borders, and the step grid is drawn with a `gap-px` border-colored grid rather than per-card outlines. Exactly one object floats: the wire demo card carries `shadow-2xl` in 40%-black — it is the artifact being inspected, lifted off the page. The sticky header separates itself with `backdrop-blur` over 80%-alpha Ink plus a hairline, not a shadow.

### Shadow Vocabulary

- **Artifact Lift** (`shadow-2xl shadow-black/40`): The WireCard only. Reserved for the page's single hero object.
- **Header Veil** (`bg-background/80` + `backdrop-blur-md` + hairline border-b): The sticky header's separation strategy. This is the only sanctioned blur on the page.

### Named Rules

**The One Floating Object Rule.** At most one dramatic shadow per viewport, and it belongs to the artifact being demonstrated. Everything else separates with hairlines and tonal steps. If two cards cast shadows, one of them is lying.

## 5. Components

### Buttons

- **Shape:** Gently rounded (`8px`; `rounded-md` at every size), medium-weight `0.875rem` label, `36px` default height, `44px` for hero CTAs (lg, `24px` horizontal padding), `32px` sm for the header.
- **Primary:** Vermilion Stamp background with Stamp Ink text; hover dims to 90% opacity. No gradients, no glow.
- **Hover / Focus:** Immediate quiet color transitions; focus is a visible `3px` ring at `ring/50` (vermilion) plus border shift. Coarse pointers get ≥44px (`min-h-11 min-w-11`) touch targets.
- **Outline / Ghost / Link:** Outline uses the Input Line stroke over a faint white-alpha fill, hover to Graphite. Ghost is transparent until a Graphite hover (the copy button). Link style is vermilion text with underline on hover.

### Chips

- **Token chip:** The redaction bar made inline — Redaction Bar fill, `3px` radius, mono at `0.82em`, Chalk at 85%. Depicts the surrogate the model sees (`FICTA_9f3a2c…`).
- **Kept value:** No chip at all — bare mono in Restored Mint. The real value is unboxed; the token is boxed. That asymmetry is the point.
- **Eyebrow pill:** Pill-shaped (`999px`), hairline border, Panel at 50%, `0.75rem` Muted Chalk, led by a `6px` Restored Mint status dot. One per page, above the H1.

### Cards / Containers

- **Corner Style:** `rounded-xl` (`14px`) for section-level cards; the wire demo and product cards share it.
- **Background:** Panel (solid on product cards, 60–70% alpha where the ink should breathe through).
- **Shadow Strategy:** Border-led per the One Floating Object Rule; only the WireCard lifts.
- **Border:** 1px Hairline everywhere; the ficta Gateway card upgrades to `border-primary/30` plus its corner wash — differentiation by stamp, not by size.
- **Internal Padding:** `28px` (`p-7`) on product cards, `24px` (`p-6`) on steps.

### Navigation

- **Style:** Sticky header, `60px` tall, Header Veil treatment, wordmark left, text links + one primary sm button right. Nav links are `0.875rem` Muted Chalk transitioning to Chalk on hover; external links append a `14px` arrow-up-right and underline on hover.
- **Mobile Treatment:** Text nav hides below `sm`; wordmark and the GitHub button remain. No hamburger — the page is single-scroll with anchor sections.

### Wordmark (signature)

The Token Wrapper (brand direction 2c, `assets/brand/`): the string `ficta` in Fragment Mono, tight-tracked, wrapped in vermilion brackets — `[ficta]`. The brackets are the logo: the value becoming a token on the wire. Brackets are `aria-hidden` so the accessible name stays "ficta". Render it in code, never as an image; it must inherit the current text size. The standalone mark (vermilion brackets wrapping a chalk value block), lockup, app icon, and favicon are the SVGs in `assets/brand/` — never recolor the brackets to mint or add a second accent.

### WireCard (signature)

The hero demo and the brand argument in one component: a Panel card (Artifact Lift shadow) showing a `POST /v1/messages` request twice — real values in Restored Mint above the "ficta · redact" mono divider, Token chips below, with "on your machine" (mint) and "→ leaves for the model" (vermilion) as stage directions. Any future surface that needs to explain the product should reuse this redact→restore round-trip pattern rather than invent icons or diagrams.

### InstallLine

A mono one-liner in a hairline-bordered, `10px`-radius, Panel-60% bar: muted `$` prompt, `npm i -g @serovaai/ficta` in Chalk-90, and a ghost copy button whose success state is a Restored Mint check for 1.6s.

## 6. Do's and Don'ts

### Do:

- **Do** treat `src/styles.css` as the single source of truth; every color in this file exists there as a custom property (`--background`, `--primary`, `--redaction`, `--restored`, …). Use the Tailwind tokens (`bg-redaction`, `text-restored`) rather than raw values.
- **Do** keep vermilion scarce enough to stay loud: CTAs, the wordmark brackets, selection, wire labels, and corner washes at ≤14% alpha — nothing else.
- **Do** show the mechanism when explaining the product: reuse the WireCard's redact→restore pattern, Token chips, and Kept values instead of abstract security imagery.
- **Do** gate every animation on `prefers-reduced-motion: no-preference` with the content fully visible by default, following the `.animate-rise` precedent (0.7s, `cubic-bezier(0.22, 1, 0.36, 1)`, 14px rise). Stagger with `animation-delay` (~120ms steps).
- **Do** hold WCAG AA on the ink field: Muted Chalk is the floor for body text; pair the vermilion/mint semantics with text or shape (the mint dot has a label; tokens have the `FICTA_` prefix), never color alone.
- **Do** keep hairline borders (1px white-alpha) as the separation system, and reserve the one dramatic shadow for the artifact being demonstrated.

### Don't:

- **Don't** ship cybersecurity theater: no padlocks-as-decoration, shields, hooded figures, neon-green matrix aesthetics, or fear-based copy. (Lucide `Lock`/`ShieldCheck` appear only as small semantic markers next to wire labels and the enterprise kicker.)
- **Don't** use flashy AI-SaaS landing grammar: no gradient text, no glassmorphism cards (the header's backdrop-blur is the single sanctioned blur), no orb/bokeh backgrounds, no hero-metric blocks, no identical icon-card grids.
- **Don't** over-claim in copy or visuals; "best-effort" stays "best-effort", and nothing may imply guarantees beyond tokenization + local restore.
- **Don't** add a light theme, per-section uppercase eyebrows (the label register is reserved for mono kickers with real meaning), side-stripe borders, or numbered markers outside the How-it-works sequence — the 01–04 steps are a real ordered pipeline, which is why they're numbered.
- **Don't** use Restored Mint for generic success or links, vermilion for dividers or decorative icons, or Signal Red for anything but genuine errors.
- **Don't** style it like a generic enterprise-security site: no dense mega-nav, no stock photography, no whitepaper-gated content.
