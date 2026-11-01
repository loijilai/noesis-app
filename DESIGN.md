---
version: alpha
name: noesis (based on Mobbin)
description: A gallery-white, monochrome interface system adapted from Mobbin's design language for a retrieval-practice tool. Near-black ink on white canvas, a ladder of barely-there neutral tints instead of shadows, stadium-pill controls, 24px card geometry, and the system font stack. No accent color; the only chroma on screen is code syntax highlighting, the code-diff marks, the answer-check verdict (green for a match, amber for a difference), and the practice graph's green squares.

colors:
  primary: "#141414"
  on-primary: "#ffffff"
  ink: "#141414"
  ink-soft: "#262626"
  text-muted: "#707070"
  text-faint: "#adadad"
  canvas: "#ffffff"
  canvas-soft: "#f3f3f3"
  field: "#f0f0f0"
  hairline-soft: "#f0f0f0"
  hairline: "#e0e0e0"

typography:
  heading-3:
    fontSize: 32px
    fontWeight: 650
    lineHeight: 1.13
    letterSpacing: 0
  heading-4:
    fontSize: 24px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: 0
  title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  body-lg:
    fontSize: 20px
    fontWeight: 300
    lineHeight: 1.38
    letterSpacing: 0
  body:
    fontSize: 16px
    fontWeight: 450
    lineHeight: 1.38
    letterSpacing: 0
  body-sm:
    fontSize: 14px
    fontWeight: 450
    lineHeight: 1.43
    letterSpacing: 0
  link:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: 0
  label:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0
  caption:
    fontSize: 12px
    fontWeight: 450
    lineHeight: 1.33
    letterSpacing: 0

rounded:
  none: 0px
  sm: 16px
  md: 24px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.link}"
    rounded: "{rounded.full}"
    padding: "0px {spacing.md}"

  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.full}"

  button-pill-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  text-input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  text-input-focused:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"

  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"

  card-featured:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"

  segmented-control:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.full}"

  segmented-control-active:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"

  list-row:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs} {spacing.md}"

  menu:
    backgroundColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs}"
    typography: "{typography.body-sm}"

  empty-state:
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.xxl}"
    typography: "{typography.body}"

---


## Overview

noesis borrows Mobbin's design language: an interface that gets out of the way of the content it shows. The system is strictly monochrome: near-black ink (`{colors.ink}` — #141414) on a pure white canvas (`{colors.canvas}`), with structure carried by a ladder of barely-perceptible neutral tints rather than by shadows or color. The cards — questions, code, answers — are the content; the chrome frames them.

The geometry does the work that color refuses to do. Every interactive element is a stadium pill (`{rounded.full}`): buttons, toggles, badges. Containers sit at a calm `{rounded.md}` (24px), inputs and list rows at `{rounded.sm}` (16px).

**Key Characteristics:**
- Monochrome palette — `{colors.ink}` on `{colors.canvas}`, no accent color
- Stadium-pill interaction language: buttons, toggles, and badges all at `{rounded.full}`
- Shadow-free elevation — hierarchy built from a neutral tint ladder (`{colors.canvas-soft}`, `{colors.field}`, `{colors.hairline}`) and 1px hairlines
- Weight contrast for hierarchy: 650 headings, 450 body, 300 light subtitles
- The only chroma on screen is code syntax highlighting (highlight.js github theme), the code-diff marks (red for extra, green for missing), the answer-check verdict banner (green 完全一致, amber 有差異), and the practice graph (GitHub's contribution greens) — all are information, not decoration

## Colors

### Brand
- **Ink Black** (`{colors.primary}` — #141414): Fills every primary button and all headings. Softened just off pure black.

### Surface
- **Canvas** (`{colors.canvas}` — #ffffff): Default page and card background.
- **Soft Canvas** (`{colors.canvas-soft}` — #f3f3f3): The workhorse tint — a 6% ink wash over white. Fills featured cards, soft utility pills, segmented-control tracks, and hovered list rows.
- **Field** (`{colors.field}` — #f0f0f0): An 8% ink wash used as the fill for form inputs and textareas, giving fields presence without borders.
- **Soft Hairline** (`{colors.hairline-soft}` — #f0f0f0): 1px card outlines — the faintest possible edge.
- **Hairline** (`{colors.hairline}` — #e0e0e0): The stronger control border, used on outlined pill buttons, menus, and list dividers.

### Text
- **Ink** (`{colors.ink}` — #141414): Headings and body copy.
- **Soft Ink** (`{colors.ink-soft}` — #262626): Slightly lifted dark for secondary emphasis.
- **Muted** (`{colors.text-muted}` — #707070): Secondary copy — counts, due status, metadata.
- **Faint** (`{colors.text-faint}` — #adadad): Tertiary text — placeholders, ids, de-emphasized controls at rest.

### Semantic
- There is no success/warning/error palette beyond what is needed; state communication stays within the monochrome ladder. Error text may use a muted red. Code-diff highlighting keeps its red/green marks.
- **Practice graph** — the home page's GitHub-style record of days practiced keeps GitHub's four contribution greens (#9be9a8, #40c463, #30a14e, #216e39), with `{colors.field}` for a day without practice. Like GitHub, it has no legend.

### Dark Mode
A toggle in the breadcrumb row switches to dark; until it is used, the system setting decides. Dark keeps the same monochrome ladder, inverted — the primary button becomes a near-white pill with near-black text.
- **Canvas** #141414, **Soft Canvas** #1f1f1f, **Field** / **Soft Hairline** #262626, **Hairline** #363636
- **Ink / Primary** #ededed (on-primary #141414), **Soft Ink** #d4d4d4, **Muted** #9e9e9e, **Faint** #6e6e6e
- Diff marks, verdict banners and error text use darker fills with lighter ink of the same hues; code uses highlight.js github-dark without its background.
- The practice graph switches to GitHub's dark-theme greens.

## Typography

### Font Family

The system font stack, which covers Chinese: `-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif`. No web fonts are loaded. Code uses `ui-monospace, Menlo, monospace`.

### Hierarchy

| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| `{typography.heading-3}` | 32px | 650 | 1.13 | Page titles (group name) |
| `{typography.heading-4}` | 24px | 650 | 1.25 | Section headings |
| `{typography.title}` | 20px | 600 | 1.3 | Emphasized rows, featured card titles |
| `{typography.body-lg}` | 20px | 300 | 1.38 | Lead text under a page title |
| `{typography.body}` | 16px | 450 | 1.38 | Default body copy, questions |
| `{typography.body-sm}` | 14px | 450 | 1.43 | List rows, menus, supporting copy |
| `{typography.link}` | 16px | 600 | 1.38 | Button labels |
| `{typography.label}` | 12px | 600 | 1.33 | Badge and pill labels |
| `{typography.caption}` | 12px | 450 | 1.33 | Captions, metadata |

### Principles

- **Weight contrast is the drama.** Pairing heavy headings against light subtitles creates hierarchy without color or ornament.
- **Tight leading up top.** Headings never breathe more than 1.25. Body text opens up to 1.38–1.43.
- **Zero letter-spacing everywhere.** No tracking adjustments, no all-caps.

## Layout

### Spacing System
- **Base unit**: 8px, with 4px half-steps for fine rhythm
- **Tokens**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px
- Buttons are fixed-height pills padded horizontally at `{spacing.md}`; inputs pad `{spacing.sm} {spacing.md}`

### Whitespace Philosophy

Whitespace is the primary grouping device. Sections are separated by empty canvas rather than divider rules; within cards, generous `{spacing.lg}` padding keeps content off the hairline edges.

### Responsive Strategy
- Content rides a single centered column.
- Two-column layouts (the code-diff comparison) collapse to one column on narrow screens.
- Pill buttons stay comfortably above the 44px touch-target minimum on narrow screens.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | Flat on `{colors.canvas}` | Default — most of every page |
| 1 | `{colors.canvas-soft}` fill, no border | Featured cards, soft pills, hovered rows |
| 2 | 1px `{colors.hairline-soft}` outline on white | Resting cards |
| 3 | 1px `{colors.hairline}` outline on white | Menus and floating panels |
| Inverse | `{colors.ink}` fill, `{colors.on-primary}` text | Primary buttons, selected state |

The system is shadow-free: elevation is communicated by fill difference and hairlines. The one soft-shadow exception is floating surfaces (menus, panels) that must read above the content they overlap, and the active segment of a segmented control.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed elements |
| `{rounded.sm}` | 16px | Inputs, list rows, menus, code blocks |
| `{rounded.md}` | 24px | Content cards |
| `{rounded.full}` | 9999px | Every pill: buttons, badges, toggles |

## Components

### Buttons

**`button-primary`** — the single most important action on a screen
- Fill `{colors.primary}`, label `{colors.on-primary}` in `{typography.link}`, shape `{rounded.full}`
- At most one per screen

**`button-outline`** — secondary actions
- Fill `{colors.canvas}`, label `{colors.ink}`, 1px `{colors.hairline}` border, shape `{rounded.full}`

**`button-pill-soft`** — tertiary utility pills
- Fill `{colors.canvas-soft}`, label `{colors.ink}`, shape `{rounded.full}`, no border

### Cards & Containers

**`card`** — resting container: `{colors.canvas}` fill, 1px `{colors.hairline-soft}` outline, `{rounded.md}` corners

**`card-featured`** — emphasized container: `{colors.canvas-soft}` fill, borderless — emphasis by tint, not by outline

**`empty-state`** — `{colors.canvas-soft}` fill, `{rounded.md}`, centered `{typography.body}` text in `{colors.text-muted}`

### Inputs & Forms

**`text-input`**
- `{colors.field}` fill, no border, `{colors.ink}` text with `{colors.text-faint}` placeholder, `{rounded.sm}` corners, padding `{spacing.sm} {spacing.md}`

**`text-input-focused`**
- Same chrome plus a 2px `{colors.ink}` ring — focus is signaled in ink

**`search-input`**
- A `text-input` shaped as a `{rounded.full}` pill, as tall as the buttons beside it, with a `{colors.text-muted}` ✕ to clear it once it holds text
- Text that matches the search is marked with a `{colors.field}` fill and bolder `{colors.ink}`, never a hue

### Lists & Menus

**`list-row`** — rows on a white canvas; hover fills with `{colors.canvas-soft}`. Secondary controls stay faint until the row is hovered.

**`menu`** — floating dropdown: `{colors.canvas}` fill, 1px `{colors.hairline}` outline, `{rounded.sm}` corners, `{typography.body-sm}` items

**`segmented-control`** + **`segmented-control-active`** — a `{colors.canvas-soft}` stadium track holding pill options; the active option is a `{colors.canvas}` white pill, the inactive label sits in `{colors.text-muted}`

## Do's and Don'ts

### Do
- Keep the canvas `{colors.canvas}` white and let the card content supply all visual interest.
- Use `{rounded.full}` for every interactive element — a rectangular button does not exist in this system.
- Build emphasis with the tint ladder: `{colors.canvas-soft}` fill for featured surfaces, `{colors.hairline-soft}` outlines for resting cards.
- Keep controls quiet at rest and reveal them on hover.

### Don't
- Don't add drop shadows to cards or buttons — elevation is fills and hairlines only.
- Don't introduce accent hues, gradients, or colored section bands. Code syntax highlighting, the code diff, the answer-check verdict and the practice graph are the only color.
- Don't load web fonts.
- Don't apply letter-spacing or all-caps styling.
- Don't put borders on form fields at rest — inputs are `{colors.field}` tint fills; the border appears only as the 2px ink focus ring.
- Don't square off pill geometry at small sizes — badges, chips, and toggles stay stadium-shaped.
