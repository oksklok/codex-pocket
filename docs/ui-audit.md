# Codex Pocket UI audit

Audit of the interface as it stood before c97d29b, against `docs/ui-style-guide.md`. The audit pass
itself changed no production code; every finding it raised has since been fixed and now lives under
"Resolved". No inconsistencies are open.

Method: read `public/index.html`, `public/styles.css` and `public/app.js`, then a throwaway
Playwright pass (kept in `/tmp`, not committed) that rendered the real stylesheet at
**390×844 (mobile)** and **1280×900 (desktop)** and reported computed sizes, radii, colours, hover
behaviour and the empty-state variants. At 390px the Tasks and Task Details drawers are the fixed
overlay mode with a boxed destination selector and sticky composer; at 1280px both are docked
columns with unboxed destination text.

Surfaces inspected: login, top bar, Tasks sidebar, task rows and task action menus, Archived view,
composer, transcript/activity UI, Task Details, Settings, New Task, Rename/Delete, Machine Details,
Project Folder, the shared confirmation dialog and the goal/queue dialogs, queue and async-input
surfaces, and the empty/no-task states. Beyond the findings below, the rest (control heights, dialog
geometry, drawer/backdrop behaviour, busy copy, `aria-expanded` usage, safe areas, reduced-motion
and forced-colors handling) matched the guide.

## Resolved (5)

- **Machine Details inline validation kept a trailing period.** Fixed: `machineFieldError()` returns
  period-free messages for the display name, SSH alias and Wake-on-LAN MAC address. Gateway copy was
  left alone.
- **Primary and danger buttons had no hover feedback.** Fixed: `.primary-button`, `.danger-button`,
  the login Unlock action and the composer Send/Stop actions brighten one step inside the existing
  `@media (hover: hover)` treatment, and disabled controls stay inert. Hover is now the guide's rule
  for every actionable button. (The transcript Approve/Deny pair was finished in the follow-up.)
- **Creating a task had no busy indication.** Fixed: the New Task button reads "Creating…" while the
  request is in flight and is restored to "Create" in the `finally` block.
- **Task-row status was always success green.** Fixed: the status span carries a semantic tone —
  Waiting/Stopped → warning, Failed → danger, everything else keeps the accent. The same rule is
  shared by the full render and the status-only fast update.
- **Docked desktop sidebars overlaid the transcript and composer.** Fixed: at ≥1100px the
  `.chat-panel` reserves the 310px Tasks pane on its left and the 340px Task Details pane on its
  right (margins matching the panes' own 160ms slide, so the transition stays coherent), and the
  transcript/composer track is centred on the real remaining chat width instead of `100vw`. Measured
  after the fix: zero overlap between the composer, the Send button and the 1050px conversation
  track and either open pane, and the Send button hit-tests as itself, in all four open/closed
  combinations at 1100, 1280, 1366, 1440 and 2048px.

## Intentional exceptions (7)

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
- **Error announcement level is chosen per surface.** Dialog errors (`#new-task-error`,
  `#task-dialog-error`, `#cwd-error`, `#queue-dialog-error`, `#machine-dialog-error`) and
  `#machines-error` are `role="alert"`; the Settings → Runtimes error
  (`#settings-deepseek-error`) deliberately stays `role="status"` because it reports runtime
  configuration state alongside the settings load, and the pre-auth `#login-error` stays
  `aria-live="polite"`. Same `.error-text` treatment, deliberately different urgency.

## Needs visual judgment (5)

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
