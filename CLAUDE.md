# projectman — working rules

Read `docs/ARCHITECTURE.md` first. Decisions and their reasons: `docs/DECISIONS.md`. What
comes next and the owner's open questions: `docs/ROADMAP.md`. The lessons learned while
building projectman are in `docs/LESSONS.md`.
`docs/DECISIONS.md` records the owner's decisions and `docs/ROADMAP.md` the plan. Only the
Operator writes them, at the owner's request or after the owner's yes (decision 50); nobody
changes them on a card branch. An owner decision made on a card is offered by the Operator
(`list_decision_candidates`, `mark_decision_candidates`). A choice of your own that the owner
should confirm still goes to them as a question.

## Language

- **All source code is English**: identifiers, comments, file and folder names, commit
  messages, test names, log messages, error codes.
- The UI language is Hungarian, but Hungarian text lives **only** in locale files:
  `apps/web/src/i18n/hu.ts` (UI), `apps/feedback-widget/src/i18n/hu.ts` (the embeddable
  feedback widget's own text) and `packages/templates/src/locales/hu.ts` (default display
  names in templates). Components use `t('some.key')`; never hardcode UI text.
- Prompt text for AI members (role instructions, context pack) is English; it tells the
  agent to communicate in the project's language.

## Subscription rule

- Never use or set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY` or other API-billing variables. The runner strips them
  from the environment of every session (`BILLING_ENV_VARS` in `apps/server/src/runner/env.ts`).
  The sole exception is the projectman-managed `NANOGPT_API_KEY` from
  `secrets/nanogpt.json`, passed only to NanoGPT member sessions (decision 34, PM-319).
  It never permits ChatGPT login fallback or OpenAI API billing.
  The runner also strips Codex OAuth overrides: `CODEX_APP_SERVER_LOGIN_CLIENT_ID`,
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and `CODEX_REVOKE_TOKEN_URL_OVERRIDE`.
- Never run the real `claude`, `codex` or `gh` CLI in automated tests. Use the fakes in
  `apps/server/test/fixtures/` (`fake-claude.mjs`, `fake-codex.mjs`, sharing
  `fake-tui.mjs`) and `apps/server/src/services/github/test-fixtures/fake-gh.mjs`.

## Contracts

- `packages/shared` (zod schemas + types) and `apps/server/src/contracts` are the source
  of truth between modules and between server and web.
- Prefer adding to contracts over changing them. If a contract must change, keep the
  change minimal and list it in your final report.
- A rule lives in one place. Pure rules (label refusal, gates, duty resolution,
  invariants, owner-only changes) belong in `packages/shared`, used by the server and by the
  web's test fake (`apps/web/src/mocks`); never re-implement one there or in a route handler.
- Route handlers parse the request, check access and call a domain service; business logic
  lives behind the `apps/server/src/core`, `runtime` and `services` module facades.
  `apps/server/src/domain/index.ts` composes them. Only `apps/server/src/index.ts` reads the environment.
- Older configuration shapes, database rows and timeline events exist in real installations.
  Configuration migrations live in `apps/server/src/config/migrations.ts`, database
  migrations in `apps/server/src/db/migrations.ts`; timeline events are append-only, so old
  event types keep rendering.

## Machine-dependent assumptions

These rules apply to every member, including Codex:

- When adding or changing a machine-dependent part (local paths, processes, sockets,
  accounts, OS features or a shared-host assumption), update the **Machine-dependent parts**
  inventory in `docs/ARCHITECTURE.md` in the same change. Record what it does, its code
  location, the machine assumption, what a remote engine needs and the related task.
- Every technical plan must answer **"Does this work on a remote engine?"** Refer to the
  affected inventory entries and state what must run on the engine, what must cross the
  server/engine boundary, or why no machine-dependent part is affected. An unresolved
  boundary choice is a planning question, not an implicit local assumption.
- Codex reads `CLAUDE.md` through `project_doc_fallback_filenames` when there is no
  `AGENTS.md` (`apps/server/src/runner/providers/codex/args.ts`). If an `AGENTS.md` is added
  to this repository, include these rules there too so they still reach Codex.

## Module ownership (parallel workstreams)

| Workstream | Owns                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runner     | `apps/server/src/runner/**`, `apps/server/test/fixtures/fake-{claude,codex,tui}.mjs`                                                                          |
| mcp        | `apps/server/src/mcp/**`                                                                                                                                      |
| core       | `apps/server/src/{db,kernel,core,domain,runtime,api,auth,config,ws,http,full-test}/**`, `apps/server/src/{app,index}.ts`, `apps/server/test/**`, `scripts/**` |
| web        | `apps/web/**`                                                                                                                                                 |
| github     | `apps/server/src/services/github/**`                                                                                                                          |
| context    | `packages/templates/**`, `apps/server/src/{context,worktree,agent-text}/**`                                                                                   |
| widget     | `apps/feedback-widget/**`                                                                                                                                     |

`packages/shared` is everyone's contract: change it additively, and name the change in your
report. Stay inside your paths otherwise. Each module exposes the factory declared in its
`index.ts`; import other modules through their `index.ts`, never their internals.

Every file under `apps/server/src` belongs to a module in
`apps/server/test/architecture/module-map.ts`; `dependencies.test.ts` enforces its
layer rules. Register new files in that map with an explicit path in the appropriate
module row. Do not add dependency exceptions: each refactor slice removes its own.

## Code style

- TypeScript strict, ESM, `moduleResolution: bundler` (extensionless relative imports).
- `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties.
- `verbatimModuleSyntax`: use `import type` for type-only imports.
- Validate data at boundaries with zod (HTTP bodies, hook payloads, MCP args, YAML).
- Prettier config in `.prettierrc.json` (`npm run format`).
- Effect (the `effect` package) is used only where `docs/EFFECT.md` allows it, behind a plain
  TypeScript facade; read that file before writing or changing Effect code.
- Tests: vitest, `*.test.ts` next to the code or under `test/`. Use temp directories;
  never touch real user repositories (e.g. client projects) or `~/.claude` in tests.
  Server test helpers live in `apps/server/test/helpers/` (domain harness, app harness with
  the fake CLIs, login and request helpers); reuse them instead of copying setup. Web UI
  tests run against the in-memory fake backend; assert on requests and rendered output.

## Commands

```
npm install          # once per checkout / worktree
npm run typecheck    # all workspaces; waits its turn in the machine's heavy-run queue
npm test             # all workspaces; waits its turn in the machine's heavy-run queue
npm run dev          # server (4700) + web (5173)
npm run shots -- <scenario>  # screenshots of a disposable instance (docs/SCREENSHOTS.md); queues too
npm run heavy -- <command>   # any other heavy command, at its turn (--label, --max-wait <s>)
npm run merge-test          # merge checks selected from HEAD's first-parent diff (-- --all forces all)
npm run full-test -- --workers 4 --timeout 60 -- npm run merge-test -- --all  # macOS, outside member sandboxes
npx vitest related <files> --run   # while working: the tests of what you changed, in the workspace (no queue)
npm run typecheck -w <workspace>  # type check only the workspaces you touched (no queue)
```

One heavy run goes at a time on the machine (PM-332, `docs/ARCHITECTURE.md` "Heavy-run
queue"): the root `npm test`, `typecheck` and `shots` wait behind the other members' and the
server's full test, and print who they wait for. Only Claude Code members run them in the
background: Claude Code sends a completion notification. Codex, Gemini (agy) and NanoGPT
members run them in the foreground and keep waiting until completion, including when the
shell tool returns a running command id; follow the provider-specific waiting instructions
in the context pack. Gemini's native `command_status` follows a running command; bounded
`schedule` wakeups are an optional path described there. Do not finish the turn while the
command is still running. Developers run only related tests (`npx vitest related <files> --run`
inside the affected workspace) and the type check of the workspaces they touched, including
before hand-over and in fix rounds. They never run the full suite. The merger (`team.merger`,
`claude` in PM) merges with `merge_task`. The server runs the card's single full check at merge,
before `main` moves: `npm run merge-test` in the full test sandbox, in the machine's queue.
Shared code or configuration changes require the whole suite; workspace checks do not queue
(decision 40, PM-380, PM-386). If a heavy command says its queue cannot be used
(exit status 78), it did not run: note this on your card and ask for the command to run outside
your sandbox; never run it another way (PM-346).

`npm run dev` keeps its data in `~/.projectman-dev` unless `PROJECTMAN_HOME` is set. The
owner's live instance is a separate checkout (`~/projectman-live`, port 4800, data in
`~/.projectman`), updated only with the owner's approval. It runs under the `com.projectman.live`
LaunchAgent (`npm run live -- install|status|uninstall`, `docs/DEPLOY.md`); after the owner approves
a release in the app, the `com.projectman.live-watcher` agent builds, tests and switches it, with
a rollback, then tags and publishes it. Never run a development
build against `~/.projectman`: a database migrated by a newer build is refused by older ones.
Open development instances at `http://127.0.0.1:5173`; the live instance's login cookie is on
`localhost`.

## Git

English, imperative commit messages ("Add session runner state machine"). Commit your
work on your branch; do not push. The merger member merges verified work and pushes `main`
through `merge_task` (decision 21, PM-386); the repository is public. Nobody commits to `main`
or switches branches in the default branch's checkout: `main` moves only through merging.
