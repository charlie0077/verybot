# UI Feature Behavior Decisions

This file stores product- and feature-specific UI behavior decisions.

Use `ui/CODESTYLE.md` for reusable, cross-feature UI conventions.
Use this file for scoped behavior tied to specific pages, flows, and domain features.

## Tasks
- Task add/edit UX should follow a Linear-like composer style (minimal title + description surface with compact toolbar controls), and task editing should use a dedicated page rather than a modal.
- Task images must be inserted inline in the task description content (markdown-style), not managed as a separate attachment block in the UI.
- Task descriptions should render markdown in preview/cards, and `attachment://...` image markdown must display as actual images inline in content flow.
- Kanban task card description previews must clamp to a maximum of 3 lines.
- In task add/edit, inline images must render directly inside the editable description input (contenteditable-style), not only in a separate preview panel.
- Task edit sidebar metadata should be limited to Status, Priority, and Team unless the user explicitly asks for additional fields.
- Team task settings should not expose a manual task state/category selector for status rows.
- In Team task settings, editing a status label must not mutate the status key on each keystroke; keep focus stable while typing.
- Team task subscription matrix must be single-select per status (each status maps to at most one worker).
- Worker-level concurrency field label should be explicit (`Max Parallel Tasks`), not generic (`Concurrency`).
- Default task status colors should be: `backlog=#71717a`, `todo=#64748b`, `plan=#06b6d4`, `in_progress=#f59e0b`, `done=#22c55e`.
- Task edit page title input should stay compact at `text-2xl` (not oversized display typography).
- Task edit page breadcrumb header title should use compact typography (`text-sm`).
- Task edit page breadcrumb label should show the task key format (`PM-xxx` / team-prefix + task id), never static `Edit Task` text.
- Task edit page top header density tweaks should reduce vertical header padding first; keep `Cancel`/`Save` action button sizes unchanged unless explicitly requested.
- Kanban drag/drop collision behavior must keep empty-status-column drops working reliably; do not force task-card collisions to override column collisions globally.
- Board/archive “clear done” behavior targets status key `done` explicitly (not inferred from status order). Backend team-status validation must enforce that a `done` status key exists.
- Archived tasks should be surfaced in a dedicated archive page (`/tasks/archived`), not as an extra column inside the primary Kanban board.
- Archived tasks page should use compact rows/cards and omit description text by default.
- Task comments must support full CRUD (`add/list/edit/delete`) and be operable from both user-facing UI flows and LLM task tools (shared backend behavior, not UI-only).
- Task edit page comments should use a Linear-like layout: chronological timeline entries with lightweight metadata/actions and a compact inline composer.
- Task edit page comments should render directly on the page surface without an extra outer bordered card wrapper around the whole comments block.
- Task comment quick-question blocks should use one-off minimal authoring: `title` + `options` required, `type` optional (`single` default), and no question/option `id` fields.
- Quick-question interaction UI in chat and task comments should reuse a shared component and always include a free-form manual response path (users are not forced to pick predefined options).
- Quick-question rendering must replace each ```question block inline at its original markdown position; do not detach all questions into a separate bottom panel or depend on numbered-heading pairing heuristics.
- Quick-question cards must provide an optional per-question custom-answer input in addition to predefined option buttons and overall manual note input.
- Per-question custom-answer input must use a textarea component, starting at one line by default.
- Single-choice quick-question options must be clearable by clicking the currently selected option again.
- Kanban column inline `Add task` control should sit tightly below the last visible task content with only a small gap (avoid large visual bottom spacing in the column content stack).
- Kanban board content area should use tight vertical insets (`pt-1` and desktop `pb-1`) so the inline `Add task` control stays near the bottom without being flush.
- Kanban desktop column scrolling should be flex-height based (no fixed viewport `maxHeight` cap) so board top/bottom insets apply consistently.
- Kanban columns should use `min-w-50` and `max-w-72` on both desktop and mobile, so cards never collapse below the minimum and also stop growing past the maximum when there are only a few statuses.
- On mobile, the Kanban board should keep columns in a single horizontal rail (linear left-to-right swipe) with snap-style navigation between columns, instead of stacking columns vertically.
- Tasks page header should keep `Tasks` title and `Show archived` + `Add task` controls on one row (no wrapped second action row).
- Task edit page on mobile should follow a Linear-like single-column flow: compact top controls, title/description first, activity/comments next, and no large detached metadata block splitting visual hierarchy.
- Task detail/edit title + description editor area should render directly on the page surface (no bordered card wrapper around that block).
- Task detail description must use a single always-on WYSIWYG markdown editor surface (no split preview/edit modes), keep markdown links clickable while editing, insert uploaded inline images at the current/last caret position so inline order is preserved, retain native undo/redo behavior (`Cmd/Ctrl+Z`) while typing, and keep the caret stable at the active insertion point during typing and after image upload (never jump to top).
- Task detail metadata controls (status/priority/team/review/runtime) should use a mobile header settings icon + drawer, but stay as a persistent right-side panel on desktop (no desktop settings icon trigger).
- Desktop task-detail right panel should not display a `Settings` title/header; it should present metadata rows directly in a compact Linear-like rail.
- Mobile task-detail metadata drawer should be titled `Details` and use compact list-style rows (no boxed form-card styling for each field block).
- Task `needsHumanReview` must auto-clear when a human user updates the task (no manual extra step required to clear the flag).
- Human task comment mutations (`add`, `update`, `delete`) must count as human task updates: they auto-clear `needsHumanReview` and should make the task eligible for subscribed worker pickup again.
- Task cards should render `needsHumanReview` as a compact icon marker with a pinging outline plus icon pulse (no corner status dot), and the ping radius should stay tight/narrow rather than spreading too far; keep full meaning available via tooltip/accessible label.
- Task edit page `needsHumanReview` control should render as two lines: uppercase field label + a standalone switch row; do not show bordered value rows or `Enabled/Disabled` helper text.

## Teams & Sidebar
- Sidebar navigation hierarchy must keep a dedicated `Teams` section before `System`, and each team group must render team name as parent with `Chat`, `Task`, and `Scheduler` as children.
- Sidebar must not include a global `Tasks` item in top-level sections; `Task` navigation is team-scoped under each team group.
- Sidebar `Teams` section must provide an explicit `Add Team` entry/action that navigates to team creation (`/teams/new`).
- Sidebar `Teams` add (`+`) action must be right-aligned in the section header and only visible on header hover/focus (except active state where it remains visible).
- Sidebar `Teams` add (`+`) action should use a tighter right inset than section text so it sits visually closer to the right edge.
- Hovering team rows/items under `Teams` must not reveal the header `+`; only hovering/focusing the `Teams` header itself should reveal it.
- Each team row in sidebar must be expandable/collapsible, with child links shown only when expanded.
- Team parent rows in sidebar should not apply hover background highlight; reserve background emphasis for active state and child-nav hover only.
- Team expand/collapse chevron buttons in sidebar should not apply hover background or hover color effects.
- Team parent rows in sidebar should show team color dots and team names without a generic team icon.
- On team-scoped routes (`/chat|/tasks|/scheduler` with `?teamId=`), only the team child nav item should be highlighted; global nav items (like top-level `Chat`) must remain inactive.
- Sidebar must not default-highlight global nav items for unrelated routes (for example `/teams/...` should not auto-highlight global `Chat`).
- Sidebar navigation content must support vertical scrolling when items overflow, while keeping non-nav footer/status content fixed.
- Sidebar scroll areas should keep scrolling functional but hide native system scrollbar chrome (use shared utility class, not per-component ad-hoc CSS).
- Team detail sidebar `Workers` section header should show count immediately after label in parentheses (for example `Workers (5)`), not right-aligned.
- Team color picker selected swatches must not use black/dark outer rings or white halo margins; indicate selection with subtle scale/checkmark and no visible outer border.
- Team color picker must expose exactly 32 preset colors to support broad team differentiation.
- Team task-status color picker must expose exactly 32 preset colors.
- Team detail page on mobile should use a single-pane master/detail flow: a `Sections` list first, then section detail panels, instead of rendering desktop sidebar + content panes side-by-side.
- In mobile team detail flow, `Workers` should open a worker list panel where tapping a worker card navigates deeper into that worker’s editor panel.

## Slash Commands & Save Feedback
- Inline header `Saved` status feedback must use semantic green (`text-success`) across pages, never chart tokens; do not show a bottom-right corner toast after save.
- User-defined slash-command aliases must be persisted in a global file under `~/.verybot` (not in `memory.db` and not team-scoped), and expanded in Web UI before send.
- Command alias management must be done in Web UI controls (create/edit/delete), not via chat slash commands like `/alias` or `/unalias`.
- Built-in slash commands and user-defined aliases are separate concepts: aliases are never auto-seeded from built-in commands.
- Command alias input must accept names without a leading slash (for example `r`) and normalize/save them as slash commands (for example `/r`).
- Command alias execution should use current-format behavior only; do not add legacy compatibility branches for old slash-prefixed expansion formats.
- Slash-command autocomplete should stay compact (tight row height, clear command-vs-description hierarchy, no oversized typography).
- In slash-command autocomplete, command badges must not invert between idle/hover/selected states (avoid flashing/flicker effects).
- In slash-command autocomplete, pressing Enter on a highlighted item must execute the command immediately and clear the input (not just fill text).
- In slash-command autocomplete, clicking a command item must execute immediately and clear the input (not only prefill).
- In slash-command autocomplete, hover styling must be subtle (no heavy block flash) while preserving clear text contrast.
- In slash-command autocomplete, pressing Esc must dismiss the popover for the current input value.
- The chat slash popup should be labeled `Aliases` (not `Commands`) and include an inline `Add Alias` action so users can create aliases directly from chat.

## Chat
- In chat input, the stop-action square icon must stay visually lighter than the send icon; use `size-3` for `SquareIcon`.
- In chat input, the stop state should follow ChatGPT-style contrast: circular `bg-foreground` button with `text-background` icon when LLM is generating and input is empty.
- LLM-running feedback in chat input should rely on the existing stop-button state only (no extra stop-button animation and no separate status pill/row beneath the textarea).
- In chat message area, keep `Assistant is thinking...` visible continuously for the entire in-flight response lifecycle (awaiting + streaming) until final/abort.
- For the chat global tab bar, keep a small but visible top margin (avoid zero top padding).
- In the chat global tab bar, align tab close (`x`) and action icons (`+`, close-all) to the same vertical centerline.
- In the chat global tab bar, tab headers must be allowed to shrink (`min-w-0`) so new tabs never get visually cut off when many tabs are open.
- In the chat global tab bar, place the new-tab (`+`) control immediately after the rightmost tab in the row (never tied to the active tab).
- In the chat global tab bar, keep the clear-all action always visible and directly adjacent to the new-tab (`+`) control.
- In the chat global tab bar, any new separator must reuse the existing divider style exactly (no custom spacing/variant tweaks).
- In the chat global tab bar, the separator before tab actions must follow the same divider conditions as tab-to-tab separators by treating `+` as a tab-like neighbor.
- In the chat global tab bar, the separator before tab actions must be vertically aligned with tab-to-tab separators.
- In the chat global tab bar, the separator before tab actions must be vertically centered within the tab-action row.
- Chat new-tab must not open a team selector modal; it must inherit the current chat scope (global chat or the active `?teamId=` route).
- Chat tab headers must not show team tags/badges.
- Navigating to a team chat route (`/chat?teamId=...`) must not auto-create a new tab; it may switch to an existing team tab, and new tabs are only created via explicit user action (`+`, shortcut, or first send).
- Chat assistant messages should render quick-question markdown blocks (` ```question `) as interactive single/multi choice controls, and submitting selections should send a summarized markdown answer back into chat.

## Channels
- In the Channels page, interactive channel cards must keep the original left-aligned content + right-side status layout; do not center content or add extra inline CTA text unless explicitly requested.

## Scheduler
- On mobile, Scheduler must not render desktop split panes side-by-side; use a single-pane flow with `Schedules` first and a separate `Chat` pane navigated via header/list actions.
- Scheduler should not render a redundant in-pane `Schedules` subheader row when the page already has the main `Scheduler` header.

## Sessions
- Session cleanup (`delete old`) must keep the most recent 300 sessions by default.

## Playbooks
- Playbook editing UI must use a single markdown editor pane (no side-by-side edit/preview split view).
- Playbook README editing must use the shared generic `MarkdownEditor` component (`ui/src/components/ui/markdown-editor.tsx`) backed by `markdown-it`; it should be a single always-on editable preview surface (no Write/Preview tabs), and never use task-specific editors, `@uiw/react-md-editor`, or plain `Textarea`.
- In playbook detail pages, always render the README section before the scripts section.
- In playbook detail pages, script content must use a real code editor (`@uiw/react-codemirror`) with VS Code themes (`vscodeDark`/`vscodeLight`), not `react-syntax-highlighter` or plain `<pre><code>` rendering.
- In playbook detail pages, script code cards must not render nested/double borders around the code viewport.
- In playbook detail pages, script code should be editable directly in-place inside each script card on a single editor surface (no overlayed dual text layers), not as split preview/editor sections and not in a separate modal.
- In playbook detail pages, script code editors must display line numbers.
- In playbook detail pages, script editor line-number gutters must be compact, readable, and visually subtle (no heavy active-line bar/highlight noise).
- In playbook detail pages, script code editors must auto-expand to show full file content by default, with a soft cap at 1000 lines that switches to internal editor scrolling.
- In playbook detail pages, clicking a script filename badge should scroll to and focus the corresponding script editor card.
- In playbook detail pages, every editable file panel (README + scripts) must show its exact file name in the panel header.
- In playbook detail pages, file panels must support header-level fold/unfold toggles without breaking script-badge jump/focus behavior.
- In playbook detail pages, do not add edit/preview toggle buttons for script cards.
- In playbook detail pages, do not render a separate heading/label above the README editor.
- In playbook detail pages, README editor body text must use the app default sans font (no monospace override).

## Settings
- Settings form cards are not selectable; keep them non-interactive (no hover surface behavior).
- Settings page section grouping should use a vertical left sidebar (not a horizontal tab strip).
- Settings page sidebar should use a list-panel style (bordered container + header + simple vertical items), not pill/segmented tabs.
- In settings two-column layout, sidebar and content cards must share the same top baseline (no sticky top offset that shifts the sidebar down).
- Global runtime model defaults to empty/unconfigured; onboarding and runtime guidance should direct users to configure it in `Settings -> Agent`.
