# MVP Agent Guidelines

## Auto-learn rule
When the user corrects your approach during a session, immediately record the rule in `ui/CODESTYLE.md` (for UI rules) or this file (for general rules). Don't wait until the session ends.
- Only record reusable, cross-feature rules (design system usage, spacing/typography conventions, accessibility, component composition patterns).
- Do not record feature-specific or business-logic-specific rules (domain fields, route/page behavior, workflow conditions, one-off product decisions).
- If a correction is feature-specific, implement it in code/tests and document it in `ui/docs/feature-ui-behavior-decisions.md` (or another scoped feature doc) instead of codestyle guides.
- If uncertain whether something is reusable, ask the user before adding it to codestyle docs.
<!-- 
## Code Review
- After writing or modifying code, always run a code review before considering the task complete. -->

## Code Style
- No hardcoded magic numbers — use named constants
- Extract reusable logic into shared util functions
- Keep solutions concise; don't over-engineer
- Prefer auto-detection over manual config when possible
- Use Winston logger everywhere — never `console.log` / `console.error` for backend logic.
- If behavior must work across Web UI + scheduler jobs + channel sessions (Telegram/Slack/WhatsApp), implement it in backend shared logic, not UI-only code paths.
- Team task status configs must always include a `done` key, and backend validation must enforce this invariant.
- Keep task status enums minimal; represent "waiting on human" with a single `needsHumanReview: boolean` flag instead of adding more status values or extra review-state fields.
- For explicit playbook updates, also save a SQLite memory summary that includes playbook path(s), changed artifact types (README/scripts/index), and a short purpose/trigger summary.
- When a team-context `workspace` is configured, use it as the default working directory for tool execution and workspace-related responses; do not default to the Verybot repo path unless no team workspace is set.
- For subscribed worker runs, capability gating must follow the worker `tools` allowlist. Do not rely on prompt-only instructions to restrict actions like `task_update`; enforce restrictions by not exposing disallowed tools.
- Reviewer workers must always run thorough/deep reviews; do not configure or use fast-review prompts.
- If the team does not create follow-up tasks, reviewers must move tasks to `in_progress` for any unresolved non-nit issue that must be fixed before completion; only keep `done` when no unresolved must-fix findings remain.
- For LAN exposure workflows, define the network-access dev command in the root `package.json` and pass Vite flags explicitly from that root script (`--host 0.0.0.0 --port 10000`), instead of relying on nested package helper scripts.
- In docs and runbooks, distinguish by mode: dev UI is `http://localhost:10000`, while CLI/runtime serves UI + gateway on one port (`http://localhost:28789` by default).
- Repository scripts and install hooks must use npm-based commands (for example `npm --prefix ui install`) instead of requiring bun.
- Public-facing docs/README must treat npm distribution as supported when available; do not claim npm is unavailable unless explicitly confirmed.
- Public-facing onboarding docs should avoid rigid step-by-step flow requirements; prefer optional "ask the LLM" setup examples that show teams/tasks/statuses can be created via chat.
- Public-facing onboarding docs should mention gateway token discovery from startup terminal logs, with `verybot config get GATEWAY_TOKEN` as fallback.
- Public-facing provider setup docs should note that Codex CLI/Claude CLI users may not need API key config when those CLIs are already authenticated on the machine.
- Public-facing onboarding docs should explicitly point model configuration to `Settings -> Agent`.
- Public-facing onboarding docs should explicitly mention that the Control UI is mobile-friendly and can be used from phones when reachable via localhost/LAN/internet URLs.
- Public-facing value proposition sections (for example README "Why") should be benefit-first and explicit about user outcomes, not just feature lists.
- Prompt guidance for TTS must be text-first: only invoke the `speak` tool when the user explicitly asks for audio/read-aloud.
- Bootstrap the default team in runtime boot only (not in request/session/tool paths).
- Lazy bootstrap helper `ensureTeamWhenEmpty` is zero-argument and default-only, intended for boot-time initialization.
- Team APIs/responses must not synthesize or append a default-team object on the fly; return teams from DB-backed state only.
- Do not hardcode default-team ID fallbacks (`DEFAULT_TEAM_ID`) in runtime request/session routing; require explicit team context from caller/config wiring.
- Boot-time bootstrap must enforce that team id `default` exists even when the teams table already has other rows.
- Default-team bootstrap must be id-driven only: check `id === "default"` and do not add name-based bootstrap fallback behavior.
- Default team runtime must be config-driven: do not resolve/use team-store orchestrator or workers for `default`.
- Do not include the `default` team in TeamConfig/UI team lists; keep it as internal bootstrap row only.
- Team management tools must include an explicit `team_create` capability; do not try to create teams implicitly via orchestrator updates.
- For team orchestration, do not inject worker identities/summaries into the orchestrator prompt. Keep discovery tool-driven: `list_workers` returns names only, and fetch worker details on demand with a dedicated tool.


## General Good Code Rules
- **Single responsibility:** each function/module does one thing well. If a function needs a comment explaining "this part does X, this part does Y," split it.
- **Fail early, fail loud:** validate inputs at boundaries; return/throw immediately on bad state instead of nesting deeply.
- **Explicit over implicit:** prefer clear parameter names, return types, and error messages over clever shorthand.
- **No dead code:** delete unused functions, imports, and variables. Commented-out code is dead code.
- **Immutability by default:** prefer `const`, readonly properties, and new objects over mutation. Mutate only when performance demands it.
- **Small functions:** aim for under 30 LOC per function. If you need to scroll, it's too long.
- **Meaningful names:** a name should tell you *what* and *why*, not *how*. Avoid generic names like `data`, `info`, `temp`, `result` unless scope is trivially small.
- **Guard against n+1:** when touching data fetching, batch/aggregate instead of looping individual calls.
- **Dependency discipline:** before adding a new dependency, check if the standard library or an existing dep already covers it. Fewer deps = fewer supply-chain risks.
- **Error messages for humans:** include context (what failed, what was expected, what to do next), not just "something went wrong."
- **Side effects at the edges:** keep business logic pure; push I/O, logging, and state mutation to the boundaries.
- **Tests are documentation:** write tests that show *intent*, not implementation details. If the test name reads like a spec, you're doing it right.
- **Don't repeat yourself — but don't over-abstract either:** extract only when you see three or more real duplicates. Premature DRY leads to wrong abstractions.
- **Prefer consistency:** match the style, patterns, and conventions already used in the codebase. A slightly worse pattern applied consistently beats a slightly better pattern applied inconsistently.

## UI Code Style
See `ui/CODESTYLE.md` for the full UI design system rules. Key points:
- Use shadcn/ui components — never plain HTML replacements
- Never hardcode colors — use semantic design tokens only
- All colors must work in both light and dark mode
- Use Tailwind spacing/typography scale — no arbitrary values
- Always use hooks from `usehooks-ts` when available (e.g. `useLocalStorage`, `useDebounce`, `useMediaQuery`, etc.) instead of hand-rolling equivalents.

## .pen Design Files (Pencil MCP)
The source of truth for all design tokens is `ui/src/index.css`. The `.pen` file variables must mirror it exactly.
- **Never hardcode hex colors** in .pen nodes. Always use `$--variable` syntax: `$--background`, `$--card`, `$--foreground`, `$--border`, etc.
- **Never hardcode radius values.** Use `$--radius-sm` (3), `$--radius-md` (5), `$--radius-lg` (7), `$--radius-xl` (11), `$--radius-2xl` (15), `$--radius-3xl` (19), `$--radius-full` (9999).
- **Never hardcode border/stroke colors.** Use `$--border` for borders, `$--input` for input borders, `$--sidebar-border` for sidebar.
- **Use reusable components** (`reusable: true`) for repeated patterns (bubbles, cards, inputs). Instantiate via `ref`.
- **Font family:** always `"Noto Sans"`.
- When adding new tokens, add them to both `index.css` (`:root` + `.dark`) and the `.pen` variables via `set_variables`.
- **Variable binding:** use `batch_design` U() operations to bind properties to variables. `replace_all_matching_properties` sets plain strings, not proper variable bindings.
- After any `.pen` design work, verify with `search_all_unique_properties` that no off-palette colors or radii leaked in.
