# projectman — working rules

Read `docs/ARCHITECTURE.md` first. Decisions and their reasons: `docs/DECISIONS.md`. What
comes next and the owner's open questions: `docs/ROADMAP.md`.
`docs/DECISIONS.md` records the owner's decisions: add an entry only for a decision the owner
made. A choice of your own that the owner should confirm goes to them as a question.

## Language

- **All source code is English**: identifiers, comments, file and folder names, commit
  messages, test names, log messages, error codes.
- The UI language is Hungarian, but Hungarian text lives **only** in locale files:
  `apps/web/src/i18n/hu.ts` (UI) and `packages/templates/src/locales/hu.ts` (default
  display names in templates). Components use `t('some.key')`; never hardcode UI text.
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
  `fake-tui.mjs`) and `apps/server/src/github/test-fixtures/fake-gh.mjs`.

## Contracts

- `packages/shared` (zod schemas + types) and `apps/server/src/contracts` are the source
  of truth between modules and between server and web.
- Prefer adding to contracts over changing them. If a contract must change, keep the
  change minimal and list it in your final report.
- A rule lives in one place. Pure rules (label refusal, gates, duty resolution,
  invariants, owner-only changes) belong in `packages/shared`, used by the server and by the
  web's test fake (`apps/web/src/mocks`); never re-implement one there or in a route handler.
- Route handlers parse the request, check access and call a domain service; business logic
  lives in `apps/server/src/domain`. Only `apps/server/src/index.ts` reads the environment.
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

| Workstream | Owns                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| runner     | `apps/server/src/runner/**`, `apps/server/test/fixtures/fake-{claude,codex,tui}.mjs`                                                      |
| mcp        | `apps/server/src/mcp/**`                                                                                                                  |
| core       | `apps/server/src/{db,domain,api,auth,config,ws,http,full-test}/**`, `apps/server/src/{app,index}.ts`, `apps/server/test/**`, `scripts/**` |
| web        | `apps/web/**`                                                                                                                             |
| github     | `apps/server/src/github/**`                                                                                                               |
| context    | `packages/templates/**`, `apps/server/src/{context,worktree,agent-text}/**`                                                               |

`packages/shared` is everyone's contract: change it additively, and name the change in your
report. Stay inside your paths otherwise. Each module exposes the factory declared in its
`index.ts`; import other modules through their `index.ts`, never their internals.

## Code style

- TypeScript strict, ESM, `moduleResolution: bundler` (extensionless relative imports).
- `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties.
- `verbatimModuleSyntax`: use `import type` for type-only imports.
- Validate data at boundaries with zod (HTTP bodies, hook payloads, MCP args, YAML).
- Prettier config in `.prettierrc.json` (`npm run format`).
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
npx vitest related <files> --run   # while working: the tests of what you changed, in the workspace (no queue)
```

One heavy run goes at a time on the machine (PM-332, `docs/ARCHITECTURE.md` "Heavy-run
queue"): the root `npm test`, `typecheck` and `shots` wait behind the other members' and the
server's full test, and print who they wait for. Only Claude Code members run them in the
background: Claude Code sends a completion notification. Codex, Gemini (agy) and NanoGPT
members run them in the foreground and keep waiting until completion, including when the
shell tool returns a running command id; follow the provider-specific waiting instructions
in the context pack. Do not finish the turn while the command is still running. Runs inside
one workspace (`npm test -w …`, `npx vitest related …`) do not queue; use them while working
and the full run once before the hand-over. If a heavy command says its queue cannot be used
(exit status 78), it did not run: note this on your card and ask for the command to run outside
your sandbox; never run it another way (PM-346).

`npm run dev` keeps its data in `~/.projectman-dev` unless `PROJECTMAN_HOME` is set. The
owner's live instance is a separate checkout (`~/projectman-live`, `npm start` on port 4800,
data in `~/.projectman`), updated only with the owner's approval. Never run a development
build against `~/.projectman`: a database migrated by a newer build is refused by older ones.
Open development instances at `http://127.0.0.1:5173`; the live instance's login cookie is on
`localhost`.

## Git

English, imperative commit messages ("Add session runner state machine"). Commit your
work on your branch; do not push. The integrating session merges verified work into `main`
and pushes `main` (decision 21); the repository is public.
