---
name: ficta site
description: Dark-only marketing site for ficta Gateway — review and redaction for self-hosted AI chat.
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

The ficta site is a dark, precise marketing surface for ficta Gateway, built around one physical metaphor: the redaction stamp. Near-black ink is the page; a single saturated vermilion is the stamp — it marks the wordmark's brackets, the CTAs, text selection, and the faint radial wash "bleeding in" at the hero's corner. The identity itself is the brand's **Token Wrapper** direction (`assets/brand/`): the wordmark is `[ficta]`, a value wrapped in vermilion brackets — the surrogate it becomes on the wire. Its counterpart is a sparing mint that means a real value is still local: under review before send or restored after return. The page doesn't argue that the mechanism is safe; it shows the real Gateway review, the exact text the model receives, and the boundary's limits.

The system is bolder than the ficta product UI (large fluid display type, a focused product demo, atmospheric color washes) but shares its anti-theater DNA. It explicitly rejects cybersecurity theater (padlocks, shields, matrix green, fear copy), flashy AI-SaaS landing grammar (gradient text, glassmorphism, orbs, hero-metric blocks, identical icon-card grids), and generic enterprise-security styling. Expressiveness lives in typography, the stamp, and the interaction between the Values and Model will see views — never in adjectives or security imagery.

Layout is a single scannable page: Gateway leads the hero, conversion path, and dominant product section; the open-source engine appears later as an inspectability/proof band with install, GitHub, npm, docs, and threat-model links. Use a 72rem (`max-w-6xl`) container, generous section padding (80px, 112px at desktop), hairline top-borders separating sections instead of background shifts, and content capped at readable measures (`max-w-2xl` intros, `max-w-xl` hero prose). Motion is a single entrance vocabulary — `.animate-rise`, a 14px rise-and-fade on `cubic-bezier(0.22, 1, 0.36, 1)` — gated on `prefers-reduced-motion: no-preference` so the page is fully visible by default and the animation only enhances.

**Key Characteristics:**

- Dark-only, near-black ink surface; no light theme exists by design.
- One vermilion accent carrying both brand identity and every CTA; one mint signal reserved for real values that remain local and affirmative checks.
- Fragment Mono for everything "on the wire" (wordmark, install command, tokens, kickers); Hanken Grotesk for everything human.
- Flat, hairline-bordered surfaces; a single dramatic shadow under the one floating object (the Gateway review).
- Gateway is the offer; OSS is the proof layer. Never present them as equal product cards.
- Honest copy as a design element: limits stated plainly, in body type, on the page.

## 2. Colors

A near-monochrome ink field where vermilion is the only voice and mint is the only reply.

### Primary

- **Vermilion Stamp** (`oklch(0.67 0.2 33)`): The redaction stamp. Primary buttons, the wordmark's brackets, `::selection`, focus rings, and — at ≤14% alpha — the radial washes that anchor the hero and governance card. It is the brand and the call to action, simultaneously.
- **Stamp Ink** (`oklch(0.16 0.02 40)`): Text on vermilion. A warm near-black so primary buttons read as stamped, not glowing.

### Secondary

- **Restored Mint** (`oklch(0.86 0.15 165)`): The local-value signal. Protection underlines in the review, restored values, list checkmarks, connected-state labels, the copied-state check, and the eyebrow's status dot. It always means "the real thing stayed local."

### Neutral

- **Ink** (`oklch(0.165 0.006 264)`): The page background. Cool, near-black, faintly blue-gray.
- **Chalk** (`oklch(0.96 0.004 90)`): Headings and primary text. Warm off-white; used at 85–90% alpha for code on panels.
- **Panel** (`oklch(0.205 0.007 264)`): Cards, the Gateway review, and popovers — one tonal step above ink, often at 50–70% alpha over it.
- **Graphite** (`oklch(0.245 0.008 264)`): Secondary/muted/accent surfaces; hover fills for quiet controls.
- **Muted Chalk** (`oklch(0.73 0.006 264)`): Secondary copy, nav links at rest, step body text. Passes AA against Ink and Panel; do not lighten surfaces underneath it without rechecking.
- **Redaction Bar** (`oklch(0.29 0.006 264)`): The fill behind tokenized values (`FICTA_…`) — a redaction bar rendered as a chip.
- **Hairline** (`oklch(1 0 0 / 10%)`) / **Input Line** (`oklch(1 0 0 / 14%)`): All borders and dividers. White-alpha so they sit on any panel tone.
- **Signal Red** (`oklch(0.63 0.21 27)`): Destructive/error only. Rare on a marketing page; kept distinct from vermilion by depth and context, never used decoratively.

### Named Rules

**The Vermilion Is The Stamp Rule.** Vermilion carries brand identity, CTAs, and redaction semantics — nothing else. The sanctioned atmospheric exception is a corner-anchored radial wash at ≤14% alpha ("the stamp bleeding in"). If vermilion appears as generic decoration, a divider color, or an icon tint without stamp meaning, it is wrong.

**The Mint Means Local Rule.** Restored Mint appears only when the UI depicts a real value staying local: protection underlines, restored values, affirmative checks, and local-status labels. Never for generic links or decoration.

**The Dark Only Rule.** There is no light theme. `<html class="dark">` is hardcoded, `theme-color` is `#0a0a0c`, and every color decision assumes the ink field. Do not introduce light-mode variants.

## 3. Typography

**Display Font:** Hanken Grotesk Variable (ui-sans-serif, system-ui fallback)
**Body Font:** Hanken Grotesk Variable (same family, lighter roles)
**Label/Mono Font:** Fragment Mono (ui-monospace, SF Mono, Menlo fallback)

**Character:** A warm humanist grotesk (with `ss01`/`cv01` alternates and antialiased rendering) does all the human talking; a typewriter-flavored mono does all the machine talking. The pairing contrasts on the exact axis the product does — human intent vs. what's on the wire.

### Hierarchy

- **Display** (600, `clamp(2.5rem, 4.2vw, 3.3rem)`, 0.98, −0.02em): The hero H1 only. Two-line structure with the second line in Muted Chalk ("See what leaves. / Protect what matters."). The cap is sized so each sentence holds a single line inside the hero column at every ≥1024px width — do not raise it without re-measuring the couplet.
- **Headline** (600, `clamp(1.75rem, 3.5vw, 2.5rem)`, 1.25, −0.02em): Section H2s. The ScopeNote uses a quieter `clamp(1.5rem, 3vw, 2rem)`.
- **Title** (600, `1.5rem`, 1.3, −0.02em): Governance and OSS proof H3s, with the trailing phrase in Muted Chalk. Step titles drop to `1.125rem`/500.
- **Body** (400, `1rem`, 1.625): Section prose in Muted Chalk. Hero lede runs `1.05rem`. Emphasis inside body is weight-500 Chalk, never color. Keep measures ≤ `max-w-2xl`.
- **Label** (Fragment Mono, `0.75rem`, uppercase, ~0.1em tracking): Kickers ("open source · MIT"), token metadata, and protection status. A deliberate, sparing device — not a per-section scaffold.
- **Mono** (Fragment Mono, `0.82rem`, leading-6): The model-facing preview, install command, inline tokens, labels, and status metadata.

### Named Rules

**The Mono Means Wire Rule.** Fragment Mono appears only for material that is literally protocol, code, or terminal: the wordmark, the install line, request bodies, tokens, and kickers. Human prose never sets in mono; wire content never sets in the grotesk.

**The Muted Second Voice Rule.** Hierarchy inside a heading is made with Muted Chalk on the trailing phrase, not with size changes or a second font. All h1–h3 get `text-wrap: balance`; prose gets `text-wrap: pretty`.

## 4. Elevation

The system is flat and border-led. Depth comes from three tonal steps (Ink → Panel → Graphite) separated by white-alpha hairlines; sections are divided by 1px top-borders, and the step grid is drawn with a `gap-px` border-colored grid rather than per-card outlines. Exactly one object floats: the Gateway review carries `shadow-2xl` in 40%-black — it is the product artifact being inspected, lifted off the page. The sticky header separates itself with `backdrop-blur` over 80%-alpha Ink plus a hairline, not a shadow.

### Shadow Vocabulary

- **Artifact Lift** (`shadow-2xl shadow-black/40`): The GatewayReviewArt only. Reserved for the page's single hero object.
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
- **Reviewed value:** A real local value stays in human typography and gains a 2px origin underline: solid mint for registry, dashed mint for detected, foreground for user-added. The model-facing token remains boxed and mono.
- **Eyebrow pill:** Pill-shaped (`999px`), hairline border, Panel at 50%, `0.75rem` Muted Chalk, led by a `6px` Restored Mint status dot. One per page, above the H1.

### Cards / Containers

- **Corner Style:** `rounded-xl` (`14px`) for section-level cards; the Gateway review and product cards share it.
- **Background:** Panel (solid on product cards, 60–70% alpha where the ink should breathe through).
- **Shadow Strategy:** Border-led per the One Floating Object Rule; only GatewayReviewArt lifts.
- **Border:** 1px Hairline everywhere; the governance card upgrades to `border-primary/30` plus its corner wash — differentiation by stamp, not by size. The OSS proof band uses the plain hairline treatment.
- **Internal Padding:** `28px` (`p-7`) on product cards, `24px` (`p-6`) on steps.

### Navigation

- **Style:** Sticky header, `60px` tall, Header Veil treatment, wordmark left, text links + one primary sm button right. Nav links are `0.875rem` Muted Chalk transitioning to Chalk on hover; external links append a `14px` arrow-up-right and underline on hover. Gateway, How it works, OSS engine, FAQ, threat model, and GitHub are visible in desktop nav; `Talk to us` remains the only button. Coarse-pointer nav links get 44px minimum targets.
- **Mobile / Tablet Treatment:** Text nav hides below `lg`; wordmark and the `Talk to us` button remain. No hamburger — the page is single-scroll with anchor sections.

### Wordmark (signature)

The Token Wrapper (brand direction 2c, `assets/brand/`): the string `ficta` in Fragment Mono, tight-tracked, wrapped in vermilion brackets — `[ficta]`. The brackets are the logo: the value becoming a token on the wire. Brackets are `aria-hidden` so the accessible name stays "ficta". Render it in code, never as an image; it must inherit the current text size. The standalone mark (vermilion brackets wrapping a chalk value block), lockup, app icon, and favicon are the SVGs in `assets/brand/` — never recolor the brackets to mint or add a second accent.

### GatewayReviewArt (signature)

The hero demo and the brand argument in one component: a faithful slice of Gateway's pre-send review with an interactive Values / Model will see switch. The Values view uses solid, dashed, and foreground underlines for registry, detected, and user-added protection. The model view replaces those values with Token chips. Any future surface that explains Gateway should show this reviewable transition instead of inventing abstract security diagrams.

### InstallLine

A mono one-liner in a hairline-bordered, `10px`-radius, Panel-60% bar: muted `$` prompt, `npm i -g @serovaai/ficta` in Chalk-90, and a ghost copy button whose success state is a Restored Mint check for 1.6s. If clipboard access fails, the command is selected for manual copy and announced through the live region. It belongs in the OSS proof section, not above the fold.

### Resilience

- **Keyboard path:** Root document includes a visible-on-focus skip link to `#main`. All buttons, standalone links, and FAQ summaries keep a vermilion focus outline; forced-colors mode gets a system Highlight outline.
- **Fallback pages:** Unknown routes and render failures use the same dark ink surface, wordmark, direct recovery actions, and visible contact email. Do not fall through to unbranded framework defaults.
- **Browser fallbacks:** `src/styles.css` carries hex/RGB fallbacks for browsers without OKLCH support. The dark-only identity remains the source of truth; fallbacks are approximation only.
- **No-JS state:** Server-rendered content remains readable. A `<noscript>` strip explains that copy buttons are unavailable while the install command and contact email remain visible for manual copy.

## 6. Do's and Don'ts

### Do:

- **Do** treat `src/styles.css` as the single source of truth; every color in this file exists there as a custom property (`--background`, `--primary`, `--redaction`, `--restored`, …). Use the Tailwind tokens (`bg-redaction`, `text-restored`) rather than raw values.
- **Do** keep vermilion scarce enough to stay loud: CTAs, the wordmark brackets, selection, wire labels, Gateway section emphasis, and corner washes at ≤14% alpha — nothing else.
- **Do** show the product and mechanism together: reuse GatewayReviewArt's protection origins, Values / Model will see switch, and Token chips instead of abstract security imagery.
- **Do** gate every animation on `prefers-reduced-motion: no-preference` with the content fully visible by default, following the `.animate-rise` precedent (0.7s, `cubic-bezier(0.22, 1, 0.36, 1)`, 14px rise). Stagger with `animation-delay` (~120ms steps).
- **Do** hold WCAG AA on the ink field: Muted Chalk is the floor for body text; pair the vermilion/mint semantics with text or shape (the mint dot has a label; tokens have the `FICTA_` prefix), never color alone.
- **Do** keep failure and degraded states on-brand: branded 404/error surfaces, manual-copy fallbacks, no-JS guidance, and system-color focus outlines are part of the public site.
- **Do** keep hairline borders (1px white-alpha) as the separation system, and reserve the one dramatic shadow for the artifact being demonstrated.

### Don't:

- **Don't** ship cybersecurity theater: no padlocks-as-decoration, shields, hooded figures, neon-green matrix aesthetics, or fear-based copy. (Lucide `Lock`/`ShieldCheck` appear only as small semantic markers next to wire labels and the enterprise kicker.)
- **Don't** use flashy AI-SaaS landing grammar: no gradient text, no glassmorphism cards (the header's backdrop-blur is the single sanctioned blur), no orb/bokeh backgrounds, no hero-metric blocks, no identical icon-card grids.
- **Don't** present the OSS CLI and Gateway as equal product choices. Gateway is the page's commercial offer; OSS is the inspectable engine and developer path underneath it.
- **Don't** over-claim in copy or visuals; "best-effort" stays "best-effort", and nothing may imply guarantees beyond tokenization + local restore.
- **Don't** add a light theme, per-section uppercase eyebrows (the label register is reserved for mono kickers with real meaning), side-stripe borders, or numbered markers outside the workflow and governance sequences, where order carries actual information.
- **Don't** use Restored Mint for generic success or links, vermilion for dividers or decorative icons, or Signal Red for anything but genuine errors.
- **Don't** style it like a generic enterprise-security site: no dense mega-nav, no stock photography, no whitepaper-gated content.
