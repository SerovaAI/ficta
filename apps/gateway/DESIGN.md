---
name: ficta chat
description: Company LLM chat UI with visible redaction-proxy protection.
colors:
  brand-vermilion: "#F1552F"
  paper: "oklch(0.985 0 0)"
  ink: "oklch(0.145 0 0)"
  panel: "oklch(1 0 0)"
  panel-ink: "oklch(0.145 0 0)"
  muted-rail: "oklch(0.97 0 0)"
  muted-ink: "oklch(0.52 0 0)"
  line: "oklch(0.922 0 0)"
  focus-ring: "oklch(0.708 0 0)"
  dark-paper: "oklch(0.145 0 0)"
  dark-panel: "oklch(0.205 0 0)"
  dark-muted-rail: "oklch(0.269 0 0)"
  protection-emerald: "#059669"
  protection-action: "#047857"
  dark-protection-action: "#34D399"
  warning-amber-bg: "#fffbeb"
  warning-amber-ink: "#451a03"
  incident-red: "oklch(0.577 0.245 27.325)"
typography:
  display:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.25
  mono:
    fontFamily: "Fragment Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  composer: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.muted-rail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "36px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  status-chip-protected:
    backgroundColor: "{colors.muted-rail}"
    textColor: "{colors.ink}"
    rounded: "999px"
    padding: "4px 10px"
---

# Design System: ficta chat

## 1. Overview

**Creative North Star: "The Quiet Control Room"**

ficta chat is a restrained product interface for company users working with LLMs under a redaction proxy. The system should feel like a focused operations surface: familiar enough to disappear into the chat task, precise enough to make protection state legible, and quiet enough that warnings carry real weight when they appear.

The visual system uses a neutral shadcn-style foundation, one emerald protection cue, and semantic amber/red states for degradation and incidents. It rejects flashy AI SaaS styling, cybersecurity theater, and cluttered enterprise dashboards. The design should never imply stronger security guarantees than the product can make.

**Key Characteristics:**

- Restrained neutral surfaces with high-contrast text and clear borders.
- Emerald protection signals used sparingly for trust state, never as decoration.
- Familiar app-shell patterns: collapsible history sidebar, sticky top bar, centered chat lane, modal settings.
- State-explicit feedback for uploads, streaming, fail-open/fail-closed notices, settings saves, and destructive actions.
- Compact typography and spacing calibrated for repeat daily use.

## 2. Colors

The palette is neutral-first, with semantic status color carrying the few moments that need emphasis.

### Primary

- **Ink** (`oklch(0.145 0 0)`): Primary action background in light mode, foreground text, high-emphasis icons, and selected text.
- **Paper** (`oklch(0.985 0 0)`): Main light-mode canvas and primary button foreground. It sits just behind true-white task surfaces so the layout retains a quiet, legible hierarchy.
- **Protection Emerald** (`#059669`): The protected-state icon color (shield iconography in ProtectionBadge and empty-state framing). Use only when the UI is communicating protection or redaction status.
- **Brand Vermilion** (`#F1552F`): The ficta mark's brackets only (see Brand Mark below). Never a UI accent, status, or CTA color inside the product.

### Secondary

- **Muted Rail** (`oklch(0.97 0 0)`): Secondary buttons, sidebar icon containers, empty-state icon backing, muted chips, and hoverable quiet regions.
- **Panel** (`oklch(1 0 0)`): Cards, popovers, composer surface, and document-like content surfaces.

### Tertiary

- **Warning Amber** (`#fffbeb` / `#451a03`): Upload warnings and degraded protection notices where the user can continue but must understand the limitation.
- **Incident Red** (`oklch(0.577 0.245 27.325)`): Errors, destructive actions, invalid fields, and fail-closed or blocked states.

### Neutral

- **Line** (`oklch(0.922 0 0)`): Borders, dividers, input strokes, scroll thumbs, and low-emphasis separation.
- **Muted Ink** (`oklch(0.52 0 0)`): Secondary copy, thread rows at rest, metadata, helper text, and inactive icons. Dark enough to keep small muted text AA-compliant on muted/accent surfaces.
- **Dark Paper** (`oklch(0.145 0 0)`): Dark-mode app background.
- **Dark Panel** (`oklch(0.205 0 0)`): Dark-mode cards and popovers.
- **Dark Muted Rail** (`oklch(0.269 0 0)`): Dark-mode secondary, muted, and accent surfaces.

### Named Rules

**The Protection Is Rare Rule.** Emerald appears only for protection state or protected empty-state framing. If emerald is used for generic decoration, it is wrong.

**The Brand Stays In Its Tile Rule.** Brand Vermilion and the fixed brand hexes (`#F1552F` / `#F3F1EA` / `#0A0A0C`) exist only inside the Brand Mark and the favicon. They never re-tint with the theme and never leak into buttons, links, or status color.

**The Status Must Speak Rule.** Amber and red must be paired with text and icons. Never rely on color alone for protection, warning, error, loading, or selected states.

## 3. Typography

**Display Font:** Hanken Grotesk Variable (ui-sans-serif, system-ui fallback)
**Body Font:** Hanken Grotesk Variable (same family, lighter roles)
**Label/Mono Font:** Fragment Mono (ui-monospace fallback) — reserved for on-the-wire material.

**Character:** The brand pairing (assets/brand) at product register: a warm humanist grotesk does all the human talking, kept plain, dense, and product-native — weight, alignment, and copy specificity do the work, not display drama. Fragment Mono appears only for material that is literally protocol, code, or tokens (`FICTA_…` surrogates); human prose never sets in mono.

### Hierarchy

- **Display** (600, `1.5rem`, `1.25`, `-0.025em`): Empty-state and onboarding headings. Use sparingly inside focused product surfaces.
- **Headline** (600, `1.25rem`, `1.3`, `-0.025em`): Dialog titles and page-level modal headings.
- **Title** (600, `1rem`, `1.5`, `-0.025em`): Sidebar brand text, section labels, and compact panel headers.
- **Body** (400, `0.95rem`, `1.625`): Chat messages, markdown output, composer text, and readable explanatory copy. Keep prose near 65-75ch where layout allows.
- **Label** (500, `0.875rem`, `1.25`): Buttons, setting labels, menu items, tabs, and control text.

### Named Rules

**The No Display Drama Rule.** Product labels, settings, menus, and chat controls stay in Hanken Grotesk at normal UI sizes. Do not introduce a display font for flavor.

**The Mono Means Wire Rule.** Fragment Mono is for tokens, code, and protocol material only — never for human copy or UI labels.

## 4. Elevation

The system is flat by default, with depth conveyed primarily through borders, tonal layers, and sticky/overlay placement. Shadows are reserved for overlays, mobile drawers, dropdowns, dialogs, and the active composer surface.

### Shadow Vocabulary

- **Hairline Lift** (`shadow-xs`): Outline buttons, inputs, and checkboxes where a slight tactile edge helps affordance.
- **Surface Lift** (`shadow-sm`): Composer and onboarding card surfaces that need subtle separation from the app background.
- **Menu Lift** (`shadow-md` / `shadow-lg`): Dropdown and submenu portals.
- **Overlay Lift** (`shadow-xl`): Dialogs and mobile sidebar drawer.

### Named Rules

**The Flat Until Active Rule.** Static content should be separated by borders and tonal layers. Use shadow when a surface floats, overlays, or becomes the active place of input.

## 5. Components

### Buttons

- **Shape:** Gently curved rectangles (`8px` radius) with icon-compatible gaps. Icon-only and composer buttons may use `12px` radius where the surrounding control is larger.
- **Primary:** Ink background with Paper text (`36px` height, `8px 16px` padding). Hover darkens by opacity (`primary/90`).
- **Protection action:** The final "Send protected" action uses Emerald 700 with white text in light mode and Emerald 400 with Emerald 950 text in dark mode. Its stronger semantic treatment is reserved for actions that send through the protection boundary; hover and focus stay within the emerald scale.
- **Hover / Focus:** Color transitions are immediate and quiet. Focus uses a visible `3px` ring at `ring/50` plus border-ring where supported.
- **Secondary / Ghost / Tertiary:** Secondary uses Muted Rail; ghost buttons are transparent until hover. Link buttons use Ink text with underline on hover.

### Chips

- **Style:** Attachment chips and protection badges are pill-shaped, compact, and bordered. They use muted surfaces unless carrying amber/red status.
- **State:** Selected or active chips should use text, icon, and background together. Do not encode state with color only.

### Cards / Containers

- **Corner Style:** Cards and notices use `12px-16px` radius depending on size. Do not exceed the composer radius unless the element is a pill.
- **Background:** Panels use Paper/Panel in light mode and Dark Panel in dark mode.
- **Shadow Strategy:** Cards are mostly border-led. Use `shadow-sm` only when the surface is a focused task container.
- **Border:** One-pixel Line borders define cards, separators, sidebars, and modal divisions.
- **Internal Padding:** Compact controls use `8px-12px`; cards, notices, and dialogs use `16px-24px`.

### Inputs / Fields

- **Style:** Inputs are transparent with Line/Input stroke, `8px` radius, `36px` height, and `12px` horizontal padding.
- **Focus:** Focus shifts to Ring with a `3px` translucent ring. Composer focus uses a subtler `1px` ring around the entire composition box.
- **Error / Disabled:** Error uses Incident Red border/ring and text. Disabled controls keep shape and reduce opacity to `50%`.

### Navigation

- **Style:** The chat sidebar is a persistent desktop column that collapses to a 48px icon rail, and a mobile off-canvas drawer with backdrop.
- **Typography:** Thread rows use `0.875rem` text with muted resting state and foreground active state.
- **States:** Hover and active states use Accent/Muted Rail fills. Destructive row actions reveal on hover or focus and use Incident Red.
- **Mobile Treatment:** The sidebar overlays the app with a black 40% backdrop and should close after selecting a thread.

### Composer

The composer is the signature task surface. It is a rounded, bordered Panel with compact icon controls, auto-growing text area, attachment chips above the field, and a plain helper line below. It should remain visually stable while streaming, stopping, attaching, or warning.

### Brand Mark

The ficta identity (assets/brand, "Token Wrapper"): vermilion brackets wrapping a chalk value block, rendered as inline SVG on its ink app-icon tile (`28px`, `rounded-lg`, hairline border) in the sidebar header and collapsed rail, and as the favicon. The expanded sidebar title renders as a text wordmark: `[ficta]` when unnamed, or `[Instance Name]` when a custom instance name is set, with vermilion brackets and foreground value text in Fragment Mono. The brand hexes are fixed — the mark never re-tints with the theme — and vermilion appears only inside brand brackets, never as a product accent.

### Status Notices

Protection badges, upload warnings, and error banners must be direct and specific. Amber means degraded or unsupported but recoverable; red means error, destructive action, or blocked/fail-closed posture; emerald means protected or active protection status.

## 6. Do's and Don'ts

### Do:

- **Do** preserve the neutral shadcn/Tailwind token system in `src/styles.css`; it is the visual source of truth.
- **Do** keep the chat task first: the centered message lane, composer, model picker, history, and protection status should stay predictable.
- **Do** pair every status color with copy and iconography so the UI remains colorblind-safe.
- **Do** use standard controls, Radix/shadcn interaction patterns, visible focus rings, and familiar dialog/menu behavior.
- **Do** state protection limits plainly in product copy, especially for unsupported document uploads and degraded detection posture.

### Don't:

- **Don't** use flashy AI SaaS styling, cybersecurity theater, or cluttered enterprise dashboards.
- **Don't** turn the product into a dark hacker console, neon security interface, or marketing demo.
- **Don't** use emerald for generic emphasis, decoration, success unrelated to protection, or large background fills.
- **Don't** add gradient text, decorative glassmorphism, side-stripe borders, bokeh/orb backgrounds, or oversized rounded cards.
- **Don't** imply stronger security guarantees than the product can make.
