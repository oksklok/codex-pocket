# Codex Pocket UI style guide

This is the current UI contract for new work. It describes durable conventions, not a historical audit or a pixel-by-pixel inventory. Implementation references: `public/index.html`, `public/styles.css`, and `public/app.js`.

## Typography and sizing

Pocket uses `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Monospace is reserved for code, diffs, and paths.

| Role | Token | Size | Typical use |
| --- | --- | --- | --- |
| Heading | `--text-heading` | 14px | transcript prose, composer, settings section titles |
| UI | `--text-ui` | 13px | controls, fields, selects |
| Label | `--text-label` | 12px | labels and compact rows |
| Secondary | `--text-secondary` | 11px | status and hints |
| Meta | `--text-meta` | 10px | badges and uppercase micro-labels |

`--control-height: 40px` is the normal field/action height. `--icon-size: 36px` is the normal square icon target. The login PIN and the compact assistant-code Copy control are deliberate exceptions.

## Layout and spacing

- Screen inset and ordinary panel padding: 12px.
- Default gap: 8px; dense chrome may tighten it.
- Main panels use `--radius`; controls use `--control-radius`.
- Transcript and composer share the same centered content track.
- Trailing text in compact rows ellipsizes rather than forcing controls to wrap.
- User image thumbnails sit above the user bubble; image-only messages do not render an empty text bubble.

At **1100px and above**, Tasks and Task Details are docked sidebars and the chat reserves their widths. Below 1100px they become drawers with backdrops and close controls.

At **860px and below**, the page becomes the primary scroller; the top bar and composer remain sticky. Smaller breakpoints compact the top bar and composer, and the New Task grid collapses to one column on very narrow screens.

## Surfaces and controls

Neutral surfaces carry most structure; semantic color is reserved for actions, status, and activity categories.

- Primary actions use the accent treatment.
- Secondary actions use the raised neutral surface.
- Destructive actions use the danger treatment.
- Icon-only controls use outline glyphs and an `aria-label`; the task action menu uses three filled dots.
- Pocket emits no browser-native `title` tooltips.
- Disabled controls stay visually inert.
- Hover feedback is only applied on hover-capable devices.
- `prefers-reduced-motion` disables drawer/chevron transitions and looping animations.
- `forced-colors` restores system focus outlines and native control treatment.

The image viewer remains dark in both themes. Archived task rows may remain fully opaque even when their actions are disabled.

## Focus and keyboard behavior

Viewport width decides whether sidebars are docked or drawers. **Input capability decides composer autofocus.**

A coarse, hover-less touch device should not receive automatic focus that summons the software keyboard after task switching or New Task completion. Fine-pointer desktop/laptop input may focus the composer. Opening Tasks may focus Search on a fine pointer, but not on touch.

Explicit editing flows are different: when a user opens a rename/form field for deliberate editing, normal dialog focus still applies.

Other rules:

- Native controls keep native keyboard behavior.
- Custom clickable controls provide equivalent keyboard activation.
- Escape closes/cancels the topmost dismissible surface unless an in-flight mutation prevents it.
- Narrow drawers return focus to their toggle when they close.
- DOM order is the normal Tab order.
- Text fields use the caret/selection as their normal focus cue; forced-colors restores a system outline.

## Dialogs and sidebars

Ordinary dialogs use the shared native-dialog shell: stacked fields, standard spacing, and a right-aligned action row. A shared confirmation dialog handles simple confirmations; richer destructive flows may use their own dialog on the same visual shell.

Settings is a modal overlay with a centered card and a normal action row at the end of its content. It keeps unsaved edits local until Save.

Concealed drawers are `inert`. On wide layouts, docked sidebars are navigation rather than modal dialogs, so they have no backdrop or close button.

Tasks use permanent 48px two-line rows. The task name is primary; the smaller model name is readable secondary text, with provider and reasoning effort dimmer. Providers appear beside the task name when a machine exposes several providers; model and effort occupy the second line. Both lines use equally spaced dot separators and ellipsis, retaining full model names and omitting unavailable metadata. The checkmark, status, and action control are centered across the two lines; text stays clear of those controls. Selection uses the neutral highlight, and statuses retain their semantic colors.

Reopening Tasks preserves list scroll. Metadata-only refreshes preserve row focus and open menus. Action menus stay within the drawer and open above or below their row without covering it.

## Transcript, activity, and composer

Assistant Markdown is rendered with HTML disabled. Unsupported links are not activated, external images are not loaded, and authored Markdown `title` attributes are stripped to preserve the no-native-tooltip rule.

Fenced code blocks in assistant conversation messages have one Copy control. The copied value is the code content, not the button label or wrapping.

Activity display categories are:

- Command
- Tool
- Search
- File Changes
- Subagents
- Image
- Context Compaction

Reasoning, Review, and completed Question entries are semantic transcript content and are not controlled by those filters. A running structured Question stays out of the transcript while its picker is the active UI.

Foreground recovery follows the latest content when the user was following it, without waiting for another live message. Deliberate older reading, manual scrolling, and text selection take priority. Loading older history preserves the reading anchor; recovery preserves message/activity order and existing transcript content while incomplete.

The expanded composer fills the chat area on desktop and the viewport on narrow screens. It preserves the draft and returns to the saved reading position on manual collapse. Goal and queued-message cards are hidden while expanded without changing their state. Queued Next keeps text-only rows compact, with selectable message text before any attachments.

## Status and copy

- Connecting: blue.
- Working: accent green; the top-bar indicator pulses, while task-row status text stays static.
- Done: accent green without pulse.
- Waiting / Stopped: warning.
- Failed / Unavailable: danger.

Away-task unread indicators reuse the same semantic colors. Machine-level Tasks Unavailable is an exception and uses warning text.

Use **Title Case** for compact headings/actions/status labels and **sentence case** for explanatory text and errors.

Short validation copy is concise and usually has no trailing period. Longer explanatory/error copy uses normal punctuation. User/model text, task names, code, and tool output are not rewritten to match UI capitalization.

Persistent state belongs in status surfaces; quick local operations should not introduce transient progress copy unless the operation is long enough to need it.

Transport uncertainty must remain explicit. Use delivery-unconfirmed wording rather than retry-oriented wording when a prompt may already have been accepted.

## Accessibility

- `aria-expanded` marks disclosure state.
- `aria-current="true"` marks the selected task.
- `aria-pressed` marks toggle state such as PIN reveal.
- Icon-only controls use `aria-label`; visible text, `aria-labelledby`, and `.sr-only` are the other naming mechanisms.
- Dialog errors use assertive announcement where immediate correction is required; general status surfaces use polite announcements.
- Concealed drawers are `inert`.
- Backdrops are real controls with accessible names.
- Touch opening must not move focus into a text field before the user chooses one.

## Component-specific exceptions

A few exceptions are intentional and should not be normalized away without a visible reason:

- Login PIN geometry is larger than normal fields.
- The assistant-code Copy control is smaller than the standard icon button.
- Image viewer controls stay on the dark viewer treatment in both themes.
- Code, command output, and diffs soft-wrap instead of requiring horizontal scrolling.
- Semantic Full Access/Working/Waiting/Failed treatments use their status colors.
- Quit lifecycle copy may name macOS because Quit is exposed only by the native macOS host.
