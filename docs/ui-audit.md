# Codex Pocket UI audit

Audit of the current interface against `docs/ui-style-guide.md`. No production code was changed.

Method: read `public/index.html`, `public/styles.css` and `public/app.js`, then a throwaway
Playwright pass (kept in `/tmp`, not committed) that rendered the real stylesheet at
**390×844 (mobile)** and **1280×900 (desktop)** and reported computed sizes, radii, colours, hover
behaviour and the empty-state variants. At 390px the Tasks and Task Details drawers are the fixed
overlay mode with a boxed destination selector and sticky composer; at 1280px both are docked
columns with unboxed destination text.

Surfaces inspected: login, top bar, Tasks sidebar, task rows and task action menus, Archived view,
composer, transcript/activity UI, Task Details, Settings, New Task, Rename/Delete, Machine Details,
Project Folder, the shared confirmation dialog and the goal/queue dialogs, queue and async-input
surfaces, and the empty/no-task states. Everything below is the only divergence found; the rest
(control heights, dialog geometry, drawer/backdrop behaviour, busy copy, `aria-expanded` usage,
safe areas, reduced-motion and forced-colors handling) matched the guide.

## Actual inconsistencies

### 1. Machine Details inline validation keeps a trailing period

- **Surface:** Machine Details dialog (`#machine-dialog`), name / SSH alias / MAC fields.
- **Current behaviour:** `machineFieldError()` returns "Enter a display name for this machine.",
  "Enter a simple SSH alias (letters, digits, dot, dash or underscore)." and "Enter a valid
  Wake-on-LAN MAC address." — all with a period. New Task, Rename Task, Project Folder and the
  queued-message editor use the period-free form ("Enter a task name").
- **Style-guide expectation:** short inline validation is concise imperative wording with no
  trailing period.
- **Smallest practical fix:** drop the three trailing periods in `machineFieldError()`
  (`public/app.js`). Gateway-side messages stay as they are.

### 2. Primary and danger buttons have no hover feedback

- **Surface:** every primary/danger button — Create, Save, Discard, Remove, Restart, Quit, the
  composer Send/Stop, and the transcript Approve/Deny pair.
- **Current behaviour:** the only hover rule targets `.secondary-button`, `.icon-button` and
  `.text-button`. Measured: `#new-task-create` computed style is byte-identical before and after
  hover, while `#new-task-cancel` shifts its border from `--line` to `--muted`. So a Cancel reacts
  and the adjacent Save does not.
- **Style-guide expectation:** every actionable button acknowledges hover (hover-capable devices
  only), using a restrained border/background change rather than a new treatment.
- **Smallest practical fix:** extend the existing `@media (hover: hover)` rule to `.primary-button`,
  `.danger-button` and the composer action buttons with one restrained step (e.g. a stronger tint
  or a border at the accent/danger colour).

### 3. Creating a task has no busy indication

- **Surface:** New Task dialog submit.
- **Current behaviour:** on submit every control in `#new-task-form` is disabled (so the dialog just
  dims to 52%) and the dialog stays silent until the request returns. Every other async action in
  the product reports progress — "Saving…", "Checking…", "Renaming…", "Opening…", "Restarting…" —
  either by relabelling the button or by writing a status line.
- **Style-guide expectation:** a busy state disables the control and shows a gerund-plus-ellipsis
  indicator.
- **Smallest practical fix:** set the Create button's label to "Creating…" while the request is in
  flight and restore "Create" in the `finally` block (`public/app.js`).

### 4. Error announcement role differs between inline error fields

- **Surface:** Settings → Runtimes error (`#settings-deepseek-error`), and the login PIN error.
- **Current behaviour:** dialog errors (`#new-task-error`, `#task-dialog-error`, `#cwd-error`,
  `#queue-dialog-error`, `#machine-dialog-error`) and `#machines-error` use `role="alert"`;
  `#settings-deepseek-error` uses `role="status"`, and `#login-error` relies on
  `aria-live="polite"`. Same visual `.error-text` treatment, three different announcement levels.
- **Style-guide expectation:** page status is polite; error text that must interrupt is `role="alert"`.
- **Smallest practical fix:** give `#settings-deepseek-error` `role="alert"` in `public/index.html`
  so configuration errors announce like the other error fields. The login screen is a separate
  pre-auth surface and can stay polite, but the guide should say so explicitly.

### 5. Task-row status is always success green

- **Surface:** Tasks sidebar task rows (`.destination-task-status`).
- **Current behaviour:** the class hard-codes `color: var(--accent)`, but the text comes from
  `destinationTaskStatus()`, which can return "Waiting", "Working", "Done", "Failed" or "Stopped"
  (the gateway maps `failed` → "Failed" and `interrupted` → "Stopped"). So a failed or stopped task,
  and a task waiting on approval/input, all render in the same green as "Done". The machine header
  status and the phase pill already use danger/warning for the same states.
- **Style-guide expectation:** colour is semantic — success/neutral for normal progress, warning for
  waiting, danger for failure.
- **Smallest practical fix:** add a state class on the status span from the same value already
  computed, and map accent/warning/danger off it (reusing existing tokens).

## Intentional exceptions

- **Wide-layout sidebars are navigation, not dialogs.** At ≥1100px Tasks (310px) and Task Details
  (340px) dock as columns: no backdrop, no close button and no `aria-haspopup`; below 1100px the
  same components become drawers with both. Deliberate dual presentation.
- **Archived rows are disabled but fully opaque.** `.destination-task.archived-available:disabled`
  overrides the shared `opacity: .52` so archived tasks still read as real content.
- **Text fields have no focus ring.** Caret and selection are the cue; caret-less controls use
  `--selected-bg`, and `forced-colors` restores the system outline. Documented in the stylesheet.
- **Two destructive-confirm paths.** Machine removal, Restart and Quit use the shared
  `pocketConfirm()` dialog; Delete Task, Discard queued message and Clear goal use bespoke dialogs on
  the same shell because they need richer copy or a text field.
- **The image viewer stays dark in both themes** with its own button colours and focus shade.
- **`--control-height` (40px) governs field and action-row geometry**, while a lone icon button is
  36px and transcript Approve/Deny are 32px. Measured: every dialog action button (primary,
  secondary, danger) resolves to 40px, so no Cancel/Save pair is mismatched; the smaller sizes only
  appear where a control stands alone.

## Needs visual judgment

- **Control corner radius drifts between 8px and 9px.** `--control-radius` is 8px and is used by
  Settings fields and the Task Details selects, but login fields, the composer textarea and every
  New Task input/select render at 9px from a hard-coded value. At 40px tall the difference is
  barely visible, yet it is exactly what the token exists to prevent — worth aligning on the token
  when those surfaces are next touched.
- **Settings modal radius is 14px vs 12px for every other dialog and the login card.** Measured at
  both viewports (settings is 0px/full-bleed at ≤520px, which is fine). Two pixels on a 600px card
  is borderline; either is defensible, but the guide currently claims one radius for cards.
- **Empty-state treatment varies.** Transcript and panel empties are centred `--subtle` 12px; sidebar
  list empties are left-aligned `--subtle` 11px; Task Details' no-task message is left-aligned
  `--muted` 12px. The alignment split (list vs panel) is reasonable; the extra colour change for the
  Task Details message is the part that needs a decision.
- **Composer Send width steps 66px → 58px on narrow phones** while every other button keeps its
  label-driven width. Intentional-looking, but confirm the narrow button still reads as the primary
  action.
- **`.text-button` keeps the shared 1px border** despite the name (measured `rgb(58,58,58)`), so
  "Show All"/"Hide All" render as small bordered chips. It looks deliberate next to the Display
  heading; if it is not, removing the border would change several surfaces at once.
