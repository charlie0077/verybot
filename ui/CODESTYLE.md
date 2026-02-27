# Code Style (MVP UI)

## General
- Keep this file limited to reusable UI/system conventions; feature-specific product behavior belongs in feature docs/tests.
- Use shadcn/ui components — never plain HTML replacements
- Use `cn()` from `@/lib/utils` for className composition — never string concatenation
- Use `cva` for components with multiple visual variants
- Add `data-slot` on component root elements
- Function declarations for components — not arrow-assigned `const`
- Named exports — avoid `export default`
- One component per file; keep app component files under 500 LOC — extract when growing past that (shadcn `ui/` files are exempt)
- Extract a sub-component when a chunk of JSX is conceptually separate (own responsibility, own props, own state)
- Functions: aim for under 80 LOC body; split when growing past that
- All user-facing UI copy must be language-aware via i18n keys.
- Task board execution indicator must derive from `task.claimedBy`; do not show standalone `Claimed` wording.
- Worker-running badge should be rendered as worker name + spinning `LoaderIcon` from `lucide-react` (no robot icon).
- Worker-running spinner should rotate at a slower, calm speed (avoid fast/default spin).
- Worker-running badge must truncate long worker names with ellipsis to prevent card overflow.
- Task card run action must be hidden when the task already has a related session key (show session-open action instead).
- Keep the primary Kanban board focused on active work; low-frequency archived records must live in a dedicated page/view instead of a board column.
- Chat UI must not display raw internal tool-call payloads (tool names/args); only user-facing assistant/system content should be shown.
- Multi-team resource detail URLs must include team scope (e.g. `teamId`) in the path; avoid unscoped `/resource/:id` URLs.
- Interactive list/menu items must keep readable contrast in every combined state (default, hover, selected, selected+hover).
- Select/dropdown option rows must stay concise (short labels only); put explanatory sentences in helper text below the control, not inside option rows.
- Dialogs that contain long/selectable lists must use a bounded viewport height and a dedicated internal `overflow-y-auto` list region (do not let list content grow the dialog off-screen).
- Run `pnpm check` before committing

## Naming
- Props interfaces: `{Component}Props` (e.g. `SidebarProps`)
- Event handler props: `on*` — `onNavigate`, `onToggleDarkMode`
- Internal handlers: `handle*` — `handleSend`, `handleKeyDown`
- Module-level constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase`
- Icons (lucide-react): `...Icon` suffix — `SendIcon`, `MoonIcon`

## TypeScript
- Strict typing; avoid `any`
- `interface` for props/object shapes; `type` for unions and aliases
- Extend HTML props via `React.ComponentProps<"div">`
- Use `export type { ... }` for type-only exports

## Design Tokens & Theming
- **Never hardcode colors.** Use semantic tokens only: `bg-background`, `text-foreground`, `bg-primary`, etc.
  - Banned: `bg-gray-800`, `text-white`, `bg-black/20`, `bg-white/10`, `#1a1a2e`, `oklch(...)` inline
  - Never use `white` or `black` with opacity (e.g. `bg-white/5`, `bg-black/20`) — these break across light/dark mode. Use semantic tokens instead.
- Token pairs (background/foreground pattern): `background`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`/`input`/`ring`, `sidebar-*`, `chart-1`–`chart-5`
- New colors: add in `index.css` (`:root` + `.dark`), map in `@theme inline`
- Use `dark:` variant only when tokens don't cover the case — prefer adding a token
- Both light and dark mode must work for every visual change

## Spacing & Typography
- Tailwind spacing scale (`p-4`, `gap-6`) — never arbitrary pixels (`p-[13px]`)
- Tailwind radius tokens (`rounded-md`) — never arbitrary values
- Prefer `gap` over margin between siblings
- Page-level top headers that use the standard full-width row (`border-b border-border px-6`) should default to compact vertical padding (`py-2`); adjust controls before increasing header height.
- Keep card hover treatment to a single clean border (no double-border/ring effect).
- For selectable cards, use the shared `Card` component with `interactive` behavior; avoid custom ring-based wrappers.
- Font: Noto Sans Variable — no new font imports
- Tailwind type scale (`text-sm`, `text-base`) — no arbitrary font sizes
- `text-foreground` for primary text, `text-muted-foreground` for secondary

## File Organization
- shadcn: `src/components/ui/` (don't modify unless extending variants)
- App components: `src/components/`
- Hooks: `src/hooks/`
- Utilities: `src/lib/`
- Imports: `@/` path alias — never `../../`

## .pen Design Files (Pencil MCP)
Source of truth: `src/index.css`. The `.pen` variables mirror it.
- Colors: always `$--variable` — never raw hex
- Radius: always `$--radius-*` — never raw numbers
- Borders: `$--border` (general), `$--input` (inputs), `$--sidebar-border` (sidebar)
- Components: `reusable: true` for repeated patterns; instantiate with `type: "ref"`
- Font: always `"Noto Sans"`
- Validate: `search_all_unique_properties` after edits to catch hardcoded leaks
