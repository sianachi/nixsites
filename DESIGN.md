---
name: Nix
description: A quiet steel-blue, hairline-framed interface on paper or ink grounds, one rounded sans family, density 0.85x.
colors:
  background: "#f2f2f3"
  surface: "#e9e9ea"
  foreground: "#1d1f20"
  accent: "#5980a6"
  accent-hover: "#597ea3"
  accent-pressed: "#416180"
  accent-text: "#416180"
  accent-fill: "#416180"
  accent-fill-hover: "#2c455d"
  accent-fill-pressed: "#1d2d3d"
  muted: "#5d5d60"
  background-dark: "#17181a"
  surface-dark: "#1f2123"
  foreground-dark: "#e8e9ea"
  accent-text-dark: "#b5d9fd"
  accent-fill-dark: "#b5d9fd"
  muted-dark: "#b7b7ba"
  series-1: "#5087bd"
  series-2: "#a16428"
  series-3: "#2a6d62"
  series-4: "#72437c"
  series-5: "#374d21"
  series-6: "#383838"
typography:
  display:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-small:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Nunito Sans, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.1em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "14px"
spacing:
  unit: "3.4px"
  control-sm: "28px"
  control-md: "36px"
  control-lg: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  button-primary-hover:
    backgroundColor: "{colors.accent-fill-hover}"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
  card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
---

# Design System: Nix

Source of truth: `packages/design-tokens/src/theme.css` (Tailwind v4 `@theme`). Components live in `packages/ui`. This file records them; it does not replace them. Change the look in the theme sheet, never here.

## Overview

**Creative North Star: "The Engineer's Notebook, Softened"**

A hairline-drawn, paper-quiet workspace. Structure is told by 1px dividers and weight, not by fills, shadows or colour. One steel-blue accent appears on the single thing that matters on a screen. The original Industry reference was a technical drawing; ADR-0011 softened its type, radius and elevation, and that softening is the current look.

Density is deliberately compact (spacing unit 3.4px, 0.85x of a 4px base) yet touch-safe: controls grow to 44px on coarse pointers. The product's priorities (accessibility, simplicity, no decoration, edit in place) are expressed here as restraint: no decorative colour, no second typeface, no ornament.

**Key Characteristics:**
- Mono scheme: one steel accent; categorical colour exists only for chart series.
- One family (Nunito Sans), separated by weight and size, not by a second face.
- Hairline `divider` borders over unfilled frames; depth only on floating layers.
- Light and dark grounds both first-class, switched by semantic roles, never `dark:` variants.

## Colors

A cool-grey paper ground with ink-grey text and one muted steel blue. Values below are the light ground; the dark ground moves only the semantic roles.

### Primary
- **Steel** (#5980a6, `accent`): chrome, focus ring (2px, same on both grounds), non-text indicators. Tuned to about 3:1, so never body-size text.
- **Deep Steel** (#416180, `accent-text` / `accent-fill`): accent text and the solid fill of the primary button. Hover goes one step deeper on paper (`accent-fill-hover` #2c455d), lighter on ink.

### Neutral
- **Paper** (#f2f2f3, `background`, dark #17181a): the ground.
- **Panel** (#e9e9ea, `surface`, dark #1f2123): raised or grouped regions.
- **Ink** (#1d1f20, `foreground`, dark #e8e9ea): text.
- **Quiet** (#5d5d60, `muted`, dark #b7b7ba): secondary copy; the neutral ramp is not symmetric, so the role flips ends per ground.
- **Hairline** (`divider`, ink at 16% on paper, 18% on ink): every border.
- Ramps `neutral-100..900` and `accent-100..900` exist for tinted fills (100-300), role bases (500) and pressed or text steps (700-900).

### Chart series (the only categorical colour)
Steel #5087bd, ochre #a16428, teal #2a6d62, plum #72437c, moss #374d21, graphite #383838 (`series-1..6`). Each is at least 3:1 against its ground and neighbours differ in lightness.

### Named Rules
**The One Voice Rule.** The accent marks the one primary object or state on a screen. If everything is accent, nothing is.
**The Roles Rule.** Components read `bg-background`, `text-foreground`, `text-muted`, `border-divider`, never ramp steps for ground-dependent colour. Needing `dark:` means a role is missing.
**The Contrast Rule.** Body-size accent text uses `accent-text`, never `accent`. A fill with a ground-coloured label uses `accent-fill`.

## Typography

**Font:** Nunito Sans (with `system-ui, sans-serif`) for headings and body. Rounded terminals and open counters, deliberately not condensed.

**Character:** Friendly and legible; hierarchy comes from size and weight 700 headings over regular body.

### Hierarchy (the `<Text>` variants)
- **h1** (700, 40px / 1.1, tight tracking): page title.
- **h2** (700, 28px / 1.15): section heading.
- **h3** (700, 22px / 1.2): sub-section.
- **h4** (700, 17px / 1.35) and **h5** (700, 15px / 1.55): titles inside panels.
- **h6** (700, 13px, wider tracking, uppercase): caps label.
- **body** (400, 15px / 1.55): reading text. **bodySmall** (13px / 1.5): dense UI text.
- **note** (12px / 1.45): secondary notes. **caption** (11px / 1.4): metadata.
- **kicker** (11px / 1.4, widest tracking 0.1em, uppercase): smallest caps label.

No visible text below 11px: `text-2xs` (10px) stays in the scale, but no visible text uses it.

Scale steps: `text-2xs` 10, `xs` 11, `sm` 12, `base` 13, `md` 15, `lg` 17, `xl` 22, `2xl` 28, `3xl` 40. Tracking scale: tight -0.015em, normal 0, slight 0.04em, wide 0.06em, wider 0.08em, widest 0.1em (capitals get more air as they get smaller).

### Named Rules
**The Text Primitive Rule.** Every string uses `<Text variant tone>`; no text element dresses itself with a size class.

## Layout

Spacing derives from `--spacing: 3.4px` (p-1 3.4, p-2 6.8, p-3 10.2, p-4 13.6, p-6 20.4, p-8 27.2). Control heights: `--control-sm` 28px, `--control-md` 36px (default), `--control-lg` 44px (the touch target; controls take it on a coarse pointer). A structural role uses one spacing step everywhere (a bordered column-stacked group is `p-3` at `gap-2`), enforced by guard. The product is used on desktop and as a phone PWA, so every layout works at phone width. Views show the minimum that lets the data be read and edited in place.

## Elevation & Depth

Flat at rest. Frames are hairlines, not shadows. Shadows appear only on floating layers (menus, popovers, dialogs, toasts) in three steps, each a tight contact shadow plus a wide ambient one: `shadow-sm`, `shadow-md`, `shadow-lg`. Paper shadows are ink-tinted (#2b2b2d); on the dark ground they become true black at much higher alpha, since a dark interface has less contrast to spend on edges.

## Shapes

Three radii: `rounded-sm` 4px (tags), `rounded-md` 8px (cards, buttons, fields, the standard frame), `rounded-lg` 14px (dialogs). The frame is always `rounded-md border border-divider` with no fill (the Blueprint frame). The old square corners and "+" registration marks are retired (ADR-0011).

## Components

Library: `packages/ui` (controls, primitives, patterns). Every component has a story and axe coverage and takes its states from one shared `interaction` module.

### Buttons
- **Primary:** the only solid accent object; `accent-fill` with `background`-coloured label, 36px tall (44px coarse).
- **Secondary:** hairline outlined box. **Ghost:** type only. **Icon:** square outlined box with one glyph.
- **Subtle:** type or glyph in `muted`, no frame, an ink wash on hover; for chrome that recedes beside content (row actions, overflow, close).
- **States:** hover and pressed step along the accent ramp; focus is a 2px accent outline offset 2px (`focus-visible` only); disabled is 45% opacity.

### Cards, Dialog, Popover, Menu, ContextMenu, Toast
- Hairline frame, `rounded-md` (dialog `rounded-lg`), floating ones take `shadow-*`. Dialog is a native modal; Popover and Menu share one anchored-panel hook.

### Inputs (Input, Textarea, Select, Field, Checkbox, Segmented)
- Hairline frame; focus draws a 2px accent outline flush against the edge with the border turning accent (one frame changing state, not a box in a box). `Field` carries label, hint and error.

### Navigation (Nav, Tabs, Tag, Table, Listbox)
- Nav is mixed-case heading weight with slight tracking. Tag is the 4px-radius chip. Table and Listbox follow the same hairline grammar.

## Do's and Don'ts

### Do:
- **Do** use token-backed Tailwind utilities and CVA only; text through `<Text>`; semantic colour roles.
- **Do** show loading, empty, error and partial states honestly.
- **Do** give every UI component a story and axe coverage, query tests by role, and keep a 44px target on coarse pointers.
- **Do** keep the accent on one primary object per screen.

### Don't:
- **Don't** use raw hex, `px-[14px]`-style arbitrary lengths, `tracking-[...]` or inline `style={{}}` (`scripts/check-raw-design-values.sh`).
- **Don't** pick a different spacing step for a shape that already has one (`scripts/check-spacing-roles.sh`).
- **Don't** put a type-scale class on `<p>`, `<span>`, `<h1..6>` etc. (`scripts/check-text-primitive.sh`).
- **Don't** break the dependency direction `apps/* -> packages/*` or the web tiers lib/a11y, layout, features, shell (`scripts/check-frontend-layering.sh`).
- **Don't** use `dark:` variants, general CSS, a second typeface, emojis, or any decorative addition.
