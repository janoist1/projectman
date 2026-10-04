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

- Never use or set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` or other
  API-billing variables. The runner strips them from the environment of every session.
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
server's full test, and print who they wait for, so run them in the background. Runs inside
one workspace (`npm test -w …`, `npx vitest related …`) do not queue; use them while working
and the full run once before the hand-over.

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
