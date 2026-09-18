# Codex Pocket UI style guide

This describes the visual language the product has already converged on. It is a reference for
judging new work, not a new design system. Source of truth: `public/index.html`,
`public/styles.css`, `public/app.js`. Where CSS tokens are named, the token is the preferred value.

## Typography

One family: `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
Monospace (`ui-monospace, SFMono-Regular, Menlo, monospace`) is reserved for code, diffs and paths.

One small rem scale, referenced by token everywhere except the two hero headings:

| Role | Token | Size | Typical use |
| --- | --- | --- | --- |
| Heading | `--text-heading` | 14px (`.875rem`) | message body, settings section titles |
| UI | `--text-ui` | 13px (`.8125rem`) | controls, rows, form fields |
| Label | `--text-label` | 12px (`.75rem`) | most labels, secondary buttons, list rows |
| Secondary | `--text-secondary` | 11px (`.6875rem`) | status lines, hints, meta |
| Meta | `--text-meta` | 10px (`.625rem`) | uppercase micro-labels, badges |

- `h1` is the only large type (1.55rem) and appears only on the login and stopped screens.
- `h2` titles are 1rem (dialogs, Tasks and Task Details headings, Settings).
- Uppercase micro-labels (`.eyebrow`, `.metadata dt`, `.activity-kind`, `.detail-field > strong`)
  use `letter-spacing` plus weight 750–800; they never carry running copy.
- Transcript prose is `--text-heading` at `line-height: 1.58`; UI chrome uses tighter leading
  (1.25–1.45).

## Control heights and sizing

- `--control-height: 40px` is the canonical control height: text inputs, native selects, the
  read-only single-choice value (`.select-static`), composer textarea/buttons and every dialog
  action row (`.new-task-actions`, `.settings-actions`, `.machines-footer-reorder`,
  `.machine-dialog-actions`).
- `--icon-size: 36px` is the square hit target for icon buttons; the glyph inside is 18px.
- `--sidebar-header-height: 56px` for Tasks/Task Details headers; the topbar is `min-height: 58px`.
- `--control-inset: 12px` is the standard horizontal text inset for fields and selects.
- Standalone `.secondary-button` (34px) and `.primary-button`/`.danger-button` (36px) keep smaller
  defaults and are normalized to 40px only inside the action rows above.
- `--radius: 12px` for panels, cards and dialogs; `--control-radius: 8px` for controls and buttons.

## Spacing and alignment

- Screen inset is 12px; shells, sidebars and drawers all pad 12px.
- The transcript and composer share a centred track: conversation padding is
  `max(16px, calc((100vw - 1050px) / 2))`, the composer/cards are `min(100%, 780px)`, messages are
  `min(100%, 760px)`.
- Grids use 8px gaps; dialog field stacks use 12px vertical gaps; panel and metadata padding is 12px.
- Shared action-row rhythm: `--action-row-gap: 8px`, `--action-row-inset: 10px`, separated from
  content by `--action-row-border` (1px `--line-soft`).
- Trailing text in a row ellipsizes (`min-width: 0` + `text-overflow: ellipsis`) rather than
  wrapping; destructive/secondary actions in dialogs stay right-aligned, with `margin-right: auto`
  pushing a lone destructive action (Remove Machine) to the left edge.

## Surfaces, borders, radius

Neutral-gray surfaces; colour is reserved for actions, status and activity categories.

- `--bg #181818` page, `--surface #202020` panels/sidebars, `--surface-strong #282828` inputs and
  raised rows, `--line #3a3a3a` borders, `--line-soft #303030` internal dividers.
- `--selected-bg #333333` / `--selected-border #4a4a4a` is the single neutral active surface shared
  by hover, selection and sidebar toggles.
- Panels are a 1px `--line-soft` border over `--soft-surface`; metadata tiles are filled
  `--surface-strong` with no border.
- Borders are 1px everywhere; there are no heavy outlines or nested borders.
- Topbar and composer use translucent `--topbar`/`--composer-bg`; `[data-translucent="false"]`
  collapses them to `--bg`.
- Light theme re-maps the same token names; components never hard-code dark values (the image
  viewer is the deliberate exception).

## Icons

- Outline glyphs: `fill: none; stroke: currentColor`, `stroke-width: 1.5` at the standard 18px
  size, 1.6–2 in denser contexts, with round caps and joins. No filled blobs.
- Exception: the row overflow menu uses three filled dots (`fill: currentColor`).
- The two mirrored sidebar glyphs are the one place fill is meaningful: the pane is unfilled when
  the sidebar is closed and filled via `:aria-expanded` / `[aria-expanded="true"]` when open.
- Icon-only buttons always carry `aria-label` and usually a matching `title`.

## Buttons

| Kind | Treatment |
| --- | --- |
| Primary | accent-tinted fill `rgba(69,200,138,.17)`, `rgba(69,200,138,.4)` border, `--accent` text |
| Secondary | `--surface-strong` fill, `--line` border, `--text` label |
| Danger | `rgba(255,139,139,.08)` fill, `rgba(255,139,139,.35)` border, `--danger` text |
| Icon | 36px square; often borderless/transparent inside cards and headers, boxed in the topbar |
| Text | transparent fill, `--muted` label; keeps the shared 1px border and radius |
| Composer | accent Send / danger Stop, 40px, min-width 66px (58px on narrow phones) |

Quieter variants exist inside the transcript (`approval-approve`, `approval-deny`,
`async-answer button`) and keep the same accent/danger/secondary language at a smaller size.

## States

- Disabled: `opacity: .52`, `cursor: default` — except archived task rows, which stay fully opaque.
- Hover (hover-capable devices only): `.secondary-button`, `.icon-button` and `.text-button` shift
  their border to `--muted`. Primary, danger and composer buttons have no hover treatment today.
- Focus: there are no focus rings. Caret-less controls signal keyboard focus by switching to
  `--selected-bg`; checkbox/radio rows do the same as a group. Text fields deliberately have no
  focus cue — the caret and selection are the cue. `forced-colors` restores the system outline.
- Active: only task-menu items define `:active` (`--selected-bg`).
- Busy: controls are disabled and the label moves to a gerund with an ellipsis (`Saving…`,
  `Sending…`, `Checking…`, `Opening…`, `Restarting…`), or a status line reports progress.
- `prefers-reduced-motion: reduce` disables the drawer/chevron transitions and the spin/pulse
  animations.

## Navigation: sidebar and drawers

- Tasks (`#destination-switcher`, `role="dialog"`, `aria-label="Choose a task"`) and Task Details
  (`#sidebar`, `<aside aria-labelledby>`) are one component with two modes.
- Wide (≥1100px): both are docked columns — Tasks 310px absolute on the left, Task Details 340px
  absolute on the right. Backdrops and the narrow close buttons are hidden; `aria-haspopup` is
  removed from the destination control because it is navigation, not a dialog.
- Narrow (<1100px): both become fixed drawers (`min(88vw, 340px)`, Tasks `min(400px, 88vw)`) with a
  full-screen backdrop (`rgba(8,8,8,.62)`) and a visible close button.
- Only one narrow drawer is open at a time: opening Task Details closes Tasks.
- Concealed drawers get `inert` and translate off-screen; the toggle exposes `aria-expanded`
  together with a "Show/Hide" label.

## Dialogs and confirmation dialogs

- All ordinary dialogs are native `<dialog class="new-task-dialog">`: `width: min(420px, 100% - 32px)`,
  20px padding, `--radius`, `--surface`, backdrop `rgba(0,0,0,.55)`, title `h2` at 1rem with a 16px
  gap, stacked fields, and a right-aligned action row (`margin-top: 16px`, 8px gap, 40px buttons).
- One shared confirmation dialog (`#confirm-dialog`) backs `pocketConfirm({ title, message,
  confirmLabel, danger })`; focus starts on Cancel and the submit switches to `.danger-button` when
  `danger` is set.
- Destructive-but-rich flows use their own dialog on the same shell: Rename/Delete Task
  (`#task-dialog`), the Project Folder editor, queued-message Edit/Discard, and Clear goal.
- Escape is stopped from propagating out of a dialog, and `cancel` is prevented while a request is
  busy so a mutation can't be abandoned mid-flight.
- Settings is a full-screen `role="dialog" aria-modal="true"` overlay (not `<dialog>`) with a 600px
  card and a sticky action footer.

## Validation, status and error copy

`--subtle` `.form-status` for neutral status; `.error-text` switches it to `--danger`; an empty
status paragraph is hidden. Copy rules already settled on:

- Short inline validation uses concise imperative wording with no trailing period:
  "Enter a task name", "Enter an absolute project folder on this machine",
  "Enter a message or attach files".
- Longer explanatory or status messages use normal sentence punctuation:
  "Starting settings unavailable. Check the Project Folder and try again.",
  "Delivery unconfirmed. Check the task before sending again.", "Saved. Restart required."
- Do not surface implementation limits unless the user needs to know them. The 180-character name
  and 12000-character message limits are never advertised; attachment size caps appear only when an
  attachment violates them; token counts live in the context meter's tooltip, not the chrome.
- Busy/loading copy is a gerund plus an ellipsis, never a bare noun.
- Errors say what happened and what to do next; they do not blame the user or expose internals.

## Empty and no-task states

- Transcript with a task but no history: centred, `--subtle`, `--text-label`
  ("No conversation history yet."). No task selected: "Select a task or create one."
- Side panels (plan, activity) use the same centred `.panel-empty` treatment.
- Sidebar list empties are left-aligned at `--subtle` `--text-secondary` inside the list padding
  ("No saved tasks", "No archived tasks", "No matching tasks").
- With no task selected, Task Details hides metadata, Runtime, Plan and Display and shows a single
  plain message; the header phase row is hidden too.

## Mobile vs desktop

- ≥1100px is "wide": docked Tasks pane and Task Details, unboxed machine/task/provider text, the
  Tasks toggle icon visible, and the destination control no longer advertised as a dialog.
- <1100px: both sidebars become drawers and the boxed destination selector becomes the Tasks entry
  point (`aria-haspopup="dialog"`).
- ≤860px: the shell stops being a fixed-height grid — the page scrolls, the topbar and composer
  become sticky, the conversation takes 12px inline padding, and the composer adds safe-area bottom
  padding. The translucent-UI preference is hidden from 861px up.
- ≤620px: the topbar becomes a two-column layout; ≤520px: settings go full-bleed, the elapsed timer
  hides, phase chips shrink/ellipsize and composer actions go compact.
- ≤380px: New Task's two-column settings grid collapses to one column.
- `env(safe-area-inset-*)` is applied to drawers, the composer and the settings action footer.

## Accessibility and state conventions

- `aria-expanded` on every disclosure toggle: Tasks, Task Details, machine groups, activity rows,
  the composer fullscreen toggle and the free-text "Other" answer.
- `aria-current="true"` marks the selected task row; `aria-pressed` marks the PIN reveal.
- Async page status uses `aria-live="polite"` (`#composer-status`, `#settings-status`,
  `#login-error`, history/attention banners). Dialog and machine errors use `role="alert"`.
- Icon-only controls have `aria-label` (+ `title`); icon fields use `.sr-only` labels or `aria-label`.
- Concealed drawers are `inert`; backdrops are real buttons with an aria-label.
- `forced-colors: active` restores native selects and a system focus outline; `prefers-reduced-motion`
  disables transitions and looping animations.

## Intentional exceptions

- Wide layouts dock the sidebars (no backdrop, no close button, no `aria-haspopup`) — the same
  component intentionally presents as navigation rather than a dialog.
- Archived task rows are `disabled` but keep full opacity so they still read as real content.
- Text fields intentionally have no focus ring; keyboard users get the caret and selection.
- `--control-height` (40px) governs action rows; standalone secondary/primary buttons keep smaller
  defaults until a container normalizes them.
- The image viewer and its close button stay dark in both themes, with their own focus/hover colours.
- `full access` in the Access select and the `working`/`waiting`/`failed` phase pills reuse semantic
  colours as persistent state, not as decoration.
- The translucent-UI preference is hidden at ≥861px because desktop always renders translucent.
