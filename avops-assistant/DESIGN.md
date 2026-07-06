# ILUMINA AV Ops — Design System

**Thesis: this app is a room in Outline's house.** Crew flip between the wiki
and the assistant mid-show; the two must read as one product. Every token
below is taken from Outline's own theme source
([`outline/outline → shared/styles/theme.ts`](https://github.com/outline/outline/blob/main/shared/styles/theme.ts)),
not approximated from screenshots. Where the assistant needs something
Outline doesn't have (chat messages, citations), the design answers with
Outline's own patterns rather than chat-app conventions.

**The signature: an answer is a document.** Assistant replies are not
bubbles — they render as miniature Outline documents (same body type, same
heading scale, same code styling), and their citations render as Outline
document-list rows (doc icon + title), the exact element crew already click
all day in the wiki. Everything else stays quiet and disciplined.

---

## 1. Color

Semantic tokens, one name → two values (light / dark). Dark mode is not an
inversion: like Outline, the dark sidebar is *darker* than the canvas, and
links get a brighter blue.

| Token | Light | Dark | Outline source |
|---|---|---|---|
| `canvas` | `#FFFFFF` | `#111319` | `background` |
| `canvas-secondary` | `hsl(212 31% 95%)` | `#1F232E` | `backgroundSecondary` (warmGrey) |
| `canvas-tertiary` | `#D7E0EA` | `#2A2F3E` | `backgroundTertiary` |
| `sidebar` | `hsl(212 31% 95%)` | `#08090C` | `sidebarBackground` |
| `sidebar-hover` | `hsl(212 31% 90%)` | `#14161C` | `sidebarHoverBackground` |
| `sidebar-active` | `hsl(212 31% 85%)` | `#1E2128` | `sidebarActiveBackground` |
| `sidebar-text` | `rgb(78 92 110)` | `#66778F` | `sidebarText` |
| `text` | `#111319` | `#E6E6E6` | `text` (almostBlack / almostWhite) |
| `text-secondary` | `#394351` | `#7D8EA6` | `textSecondary` |
| `text-tertiary` | `#66778F` | `#66778F` | `textTertiary` (slate) |
| `placeholder` | `#A2B2C3` | `hsl(215 17% 30%)` | `placeholder` |
| `divider` | `#DAE1E9` | `#23262E` | `divider` (slateLight) |
| `accent` | `#0366D6` | `#0366D6` | `accent` — buttons, selection, focus |
| `accent-hover` | `#035CBF` | `#1272DC` | darken/lighten(0.05, accent) |
| `link` | `#0366D6` | `#137FFB` | `link` — **dark links are brighter** |
| `input-bg` | `hsl(212 31% 95%)` | `#262D36` | `inputBackground` — **inputs are filled, not outlined** |
| `input-border` | `#DAE1E9` | `#394351` | `inputBorder` |
| `input-border-focus` | `#66778F` | `#66778F` | `inputBorderFocused` |
| `menu-bg` | `#FFFFFF` | `#181C25` | `menuBackground` — menus, cards, popovers |
| `code-bg` | `#F4F7FA` | `#1D202A` | `codeBackground` (smoke) |
| `code-border` | `#E8EBED` | `rgb(255 255 255 / 10%)` | `codeBorder` |
| `btn-neutral-bg` | `#FFFFFF` | `#111319` | `buttonNeutralBackground` |
| `btn-neutral-border` | `hsl(212 31% 88%)` | `#394351` | `buttonNeutralBorder` |
| `danger` | `#ED2651` | `#F0537A` | `danger` (lightened for dark text) |
| `success` | `#3AD984` | `#3AD984` | `success` |
| `highlight` | `#FDEA9B` | `#FDEA9B` | `textHighlight` |

Shadows (verbatim from Outline):

- `menu-shadow` light: `0 0 0 1px rgb(0 0 0 / 2%), 0 4px 8px rgb(0 0 0 / 8%), 0 2px 4px rgb(0 0 0 / 0%), 0 30px 40px rgb(0 0 0 / 8%)`
- `menu-shadow` dark: `0 0 0 1px rgb(34 40 52), 0 8px 16px rgb(0 0 0 / 30%), 0 2px 4px rgb(0 0 0 / 8%)`

## 2. Typography

Two voices with a hard boundary: ILUMINA's brand face for display, Outline's
stack for everything functional.

- **Heading face**: **Space Grotesk 600** — geometric kin to ILUMINA's
  Poppins brand face, with the weight to carry titles (Poppins Extra Light
  was reviewed in-app and rejected as a heading face: too wispy at display
  sizes; no italics anywhere). Display only: the wordmark, page titles, and
  the empty-state heading. **Never for body, UI controls, or labels.**
  Self-hosted via `next/font` (`--font-brand`).
- **Wordmark**: `ILUMINA AV Ops`, Space Grotesk 600, no tracking tricks.
- **UI family**: `-apple-system, BlinkMacSystemFont, Inter, "Segoe UI", Roboto, Oxygen, sans-serif` (Outline's stack, verbatim)
- **Mono**: `"SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace`
- **UI weights**: 400 regular · 500 medium · 600 bold. Nothing heavier.
- **Scale**:
  - UI base **15px / 1.6** (Outline's app chrome)
  - Message & document content **16px / 1.6** (Outline's editor body)
  - Controls & meta **14px**, captions **13px**, timestamps **12px**
  - Page title **24px/600**, section heading **15px/600**, message headings `h1 1.35em → h3 1.05em`, all 600
- Sentence case everywhere — buttons, labels, headings. No uppercase
  tracking-wide labels (the v1 "ILUMINA AV OPS" badge treatment is retired;
  the wordmark is set like an Outline workspace name: 15px/600 `text`).

## 3. Shape, depth, spacing

- **Radii**: controls & list rows **4px**, cards/menus/popovers **6px**,
  user-message block **8px**, avatars round. Nothing larger.
- **Depth**: borders and background tints, almost never shadows. Shadows are
  reserved for floating things (menus, the widget panel) using Outline's
  `menu-shadow`. Cards on the page are `menu-bg` + `divider` border, no shadow.
- **Sidebar**: exactly **260px** (`spacing.sidebarWidth`). **No border** —
  the tint alone separates it, like Outline. Items are 32px tall, 4px radius,
  8px horizontal margin.
- **Content column**: max-width 46rem, generous whitespace. The chat column
  is an Outline document page.

## 4. Components

**Buttons** — 32px tall, 4px radius, 14px/500, `transition: background 100ms ease-in-out`.
Primary: `accent` bg, white text. Neutral: `btn-neutral-bg` + `btn-neutral-border`,
hover `canvas-secondary`. Icon buttons: 28px square, tertiary text, hover tint.

**Inputs** — filled (`input-bg`), 1px `input-border`, 4px radius, focus swaps
border to `input-border-focus` — **no glow rings**. Placeholder uses `placeholder`.

**Sidebar** — workspace row (wordmark + wiki link icon) → "New chat" neutral
button → section label ("Conversations", 13px/500 `sidebar-text`) → item list
(15px, `sidebar-text`, active = `sidebar-active` + `text` + 500) → footer
(avatar disc with initial, name 14/500, email 12 tertiary, icon actions).

**Chat, the signature surface**
- *User turn*: right-aligned block, `canvas-secondary` bg, 8px radius, 15px,
  max-width 75% — a marginal note, not a speech bubble.
- *Assistant turn*: no container at all. Document body type (16px) straight
  on the canvas, Outline heading/list/code styles.
- *Citations*: "Sources" caption, then **document rows**: doc-icon + title,
  32px tall, 4px radius, hover `canvas-secondary`, external-link glyph on
  hover. Identical anatomy to Outline's search results.
- *Starter questions*: the same row anatomy with a search glyph — the empty
  state reads like an Outline search page, not a pill garden.
- *Working states*: tertiary text with soft pulse ("Searching the knowledge
  base…"). No spinners, no skeletons.
- *Composer*: filled input pinned bottom, accent send icon-button inside the
  field's row. `Enter` sends, `Shift+Enter` newline, `/` focuses.

**Feedback** — two quiet icon buttons after each answer; selected state is
`accent`/`danger` filled glyph. Down opens an inline comment field.

**Admin** — an Outline settings page: 24px/600 title, 15px/600 section
headings, stat tiles as bordered `menu-bg` cards, tables with `divider` row
rules and 13px tertiary column headers, status as small tinted badges.

**Widget** — the panel is a floating menu: 6px radius, `menu-shadow`, mini
titlebar in sidebar tint. Bubble stays `#0366D6`.

## 5. Motion

Outline moves fast and small; so do we.

- Hovers/state: `background 100ms ease-in-out` (Outline's standard).
- Menus/popovers: 90ms fade + 2px rise. New messages: 150ms fade-in.
- Working states: 1.2s opacity pulse.
- `prefers-reduced-motion: reduce` disables all of the above.

## 6. Voice

Sentence case, plain verbs, crew-to-crew register. Buttons say what they do
("Send", "Re-sync now"). Errors say what broke and what to do
("The AI backend is unreachable. Try again shortly."). Empty states invite
("Ask the AV Ops knowledge base"). No exclamation marks, no apologies, no
"oops".

## 7. Accessibility floor

- `:focus-visible`: 2px `accent` outline, 2px offset, everywhere.
- Text contrast ≥ 4.5:1 on canvas in both themes (tertiary text is meta-only).
- All icon buttons carry `title`/`aria-label`. Feedback state is conveyed by
  fill + `aria-pressed`, not color alone.
- Keyboard: `/` focus, `Enter`/`Shift+Enter`, `Esc` cancels rename.
