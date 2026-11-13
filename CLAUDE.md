# projectman — working rules

Read `docs/ARCHITECTURE.md` first; details: `docs/modules/`; decisions: `docs/DECISIONS.md`;
plans/questions: `docs/ROADMAP.md`; lessons (PM-maintained): `docs/LESSONS.md`. Only PM edits
decisions/roadmap at owner request/approval (50, PM-1023), never on card branches. PM offers
card decisions via `list_decision_candidates` / `mark_decision_candidates`; ask the owner
about your own choices needing confirmation.

## Language

- Source code is English: identifiers, comments, paths, commits, test names, logs, error codes.
- UI text lives only in paired `hu` / `en` locales: `apps/web/src/i18n/{hu,en}/` (one
  file per top-level section, named like it, plus `index.ts`; a new section is one file and one
  sorted index line in both), `apps/feedback-widget/src/i18n/{hu,en}.ts`, `packages/templates/src/locales/{hu,en}.ts`,
  `deploy/mac/menubar/Resources/{hu,en}.lproj/Localizable.strings`. Use `t('key')` or native
  `L10n`; never hardcode UI text. Add keys to both locales, including `errors.codes`.
  `hu` defines keys; web `en` must cover them (`t()` has no Hungarian fallback) and follow
  `docs/design/glossary.md`. Exception: structure-map names, summaries and link labels are
  Hungarian UI text in `projectman.structure.yaml`; ids stay English.
- AI prompts (roles, context packs) are English and require communication in the project's language.

## Subscription rule

- Never use or set API-billing variables, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`. The runner strips
  `BILLING_ENV_VARS` (`packages/shared/src/config/billing-env.ts`, applied in
  `apps/server/src/runner/env.ts`) and Codex OAuth overrides `CODEX_APP_SERVER_LOGIN_CLIENT_ID`,
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE`. Sole exception:
  projectman-managed `NANOGPT_API_KEY` from `secrets/nanogpt.json`, only for NanoGPT sessions
  (decision 34, PM-319); never ChatGPT login fallback or OpenAI billing.
- Tests never run real `claude`/`codex`/`gh`. Use
  `apps/server/test/fixtures/fake-{claude,codex,tui}.mjs` and
  `apps/server/src/services/github/test-fixtures/fake-gh.mjs`.

## Contracts

- Contracts: `packages/shared` (zod/types), `apps/server/src/contracts`. Prefer additions;
  minimize and report changes.
- Pure rules (labels/gates/duties/invariants/owner-only changes) live once in shared, used by
  server and `apps/web/src/mocks`; never duplicate in mocks/routes. Routes parse, check access,
  call domain services via server `kernel/core/runtime/services` facades. `assembly.ts` only
  wires modules; only `apps/server/src/start.ts` (via `index.ts`) reads the environment.
- Use current configuration schema; no retired converters (PM-1383).
  Migrations: `apps/server/src/db/migrations/NNNN-name.sql`; sibling `NNNN-name.meta.json`
  holds table journal/handle classifications. Timeline is append-only; render old event types.

## Machine-dependent assumptions

These rules bind every member, including Codex:

- Update `docs/MACHINE-DEPENDENT.md` with any path/process/socket/account/OS/shared-host
  change: behavior, code location, machine assumption, remote-engine needs and task.
- Plans answer **"Does this work on a remote engine?"** Cite inventory entries, engine work
  and server/engine crossings, or why none is affected. Ask about unresolved boundaries;
  never assume locality.
- Codex reads `CLAUDE.md` via `project_doc_fallback_filenames` without `AGENTS.md`
  (`apps/server/src/runner/providers/codex/args.ts`). If adding `AGENTS.md`, include these rules there too.

## Module ownership (parallel workstreams)

- **runner**: `apps/server/src/runner/**`, `apps/server/test/fixtures/fake-{claude,codex,tui}.mjs`
- **mcp**: `apps/server/src/mcp/**`
- **core**: `apps/server/src/{contracts,db,kernel,core,runtime,services,api,auth,config,ws,http,control,full-test,exec,logging,instance,machine,engine-host,engine-link,history-semantic}/**`
  (except github below), `apps/server/src/{app,index,start,engine-app,shutdown,assembly,history-semantic-profile,history-semantic-profile-control}.ts`,
  `apps/server/test/**`, `scripts/**`, `projectman.structure.yaml`
- **web**: `apps/web/**`
- **github**: `apps/server/src/services/github/**`
- **context**: `packages/templates/**`, `apps/server/src/{context,worktree,agent-text}/**`
- **widget**: `apps/feedback-widget/**`

Shared: additive changes, reported by everyone. Otherwise stay in your paths.
Cross-module imports use only `index.ts` factories/facades, never internals.
Every server source belongs to `apps/server/test/architecture/module-map.ts` (layers:
`dependencies.test.ts`). No new dependency exceptions; each refactor removes its own.
Server paths live only in `projectman.structure.yaml`, read by module-map. Add uncovered
paths to YAML, new server modules also to module-map (`layer`, `target`); covered folders
need no entry. Add web feature/top-level folders to YAML (`structure-map.test.ts`).

## Code style

- Strict TypeScript, ESM, `moduleResolution: bundler`, extensionless relative imports.
  `erasableSyntaxOnly`: no enums, namespaces, constructor parameter properties.
  `verbatimModuleSyntax`: `import type` for types.
- Validate boundaries with zod (HTTP, hooks, MCP, YAML). Prettier: `.prettierrc.json`, `npm run format`.
- Before UI design review, self-check `docs/design/style.md#checklist-for-a-designers-review`,
  including focus after an action.
- Effect only where `docs/EFFECT.md` allows, behind a plain TypeScript facade; read before changing it.
- Vitest: `*.test.ts` beside code or under `test/`. Use temp directories, never real user repos
  or `~/.claude`. Reuse `apps/server/test/helpers/` (domain/app harness, fake CLIs, login,
  requests). Web tests use the in-memory backend; assert requests and rendered output.
  - One test per behavior/branch/edge case; variants only for distinct branches/boundaries (`it.each`).
  - No verbatim prompt/UI wording tests. Snapshots (`apps/server/src/context/__snapshots__`)
    guard whole prompts; tests check conditional parts/required keys/rules. UI text may locate elements.
  - Real git, filesystem, processes, ports or browsers only when that boundary is the risk;
    unit-test logic once, without duplicating in integration tests.
  - Test only new/changed behavior, with one regression test per bug fix; prefer existing files.

## Commands

- `npm install` once per worktree. Heavy commands use the machine pool;
  details: `docs/modules/scripts.md#machine-places-pm-332-pm-1278`.
- While working, before hand-over and in fixes: affected workspace tests only
  (`npx vitest related <files> --run`) and `npm run typecheck -w <workspace>`. For central
  files (shared, server contracts/kernel/assembly/helpers, web locales/mocks), run changed
  behavior's test files instead of broad `related`. Never run the full suite; merge runs it.
- Before hand-over and in fixes: commit, then `npm run handover-check` at root (the step names
  it; the move into review needs its green result): nearest workspace tests, typechecks,
  dead-code (`-- --dry-run` lists them). Fix new dead-code; never extend baseline. It does
  not replace the merge test.
  SQL/metadata migrations have no import edge; this selects schema tests.
- Removed capabilities: search tests for retired tools, inbox kinds and route/file paths;
  run their boundary tests too (HTTP/string fixtures escape import selection).
- Shared `ErrorCode`: update both web `errors.codes` locales; run web typecheck/i18n tests.
  Path/HTTP tests need `SELECTION_RULES` (`scripts/merge-test/handover.ts`); program entries need
  `RUNTIME_ENTRIES`. New fast merge checks must update hand-over selection in the same change.
- Exit 79: already running; wait, never restart. Only Claude Code may background checks;
  Codex/Gemini/NanoGPT wait in foreground, following running command ids to completion.
  Never finish while it runs; follow provider context instructions.
- Exit 78 / sandbox refusal means not run: record command/reason on the card and hand over.
  Never bypass or ask for outside execution; merge covers it (PM-346, PM-656).
- `npm run dev`: server 4700, web `http://127.0.0.1:5173`, data `~/.projectman-dev`
  (or `PROJECTMAN_HOME`). Never develop against `~/.projectman`: newer migrations block older builds.
  Live: `docs/DEPLOY.md`; team AI members never update it.
- `npm run shots -- <scenario>`: disposable screenshots (`docs/SCREENSHOTS.md`).

## Git

English imperative commits, on your branch; never push. Only the merger merges verified work
and pushes main via `merge_task` (21, PM-386); public repo. Never commit to main or switch
branches in its checkout; main moves only by merging.
