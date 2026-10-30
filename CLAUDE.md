# projectman — working rules

Read `docs/ARCHITECTURE.md` first (the overview; a module's details are in `docs/modules/`). Decisions and their reasons: `docs/DECISIONS.md`. What
comes next and the owner's open questions: `docs/ROADMAP.md`. The lessons learned while
building projectman are in `docs/LESSONS.md`, maintained by the project manager.
`docs/DECISIONS.md` records the owner's decisions and `docs/ROADMAP.md` the plan. Only the
project manager writes them, at the owner's request or after the owner's yes (decision 50, PM-1023); nobody
changes them on a card branch. An owner decision made on a card is offered by the project manager
(`list_decision_candidates`, `mark_decision_candidates`). A choice of your own that the owner
should confirm still goes to them as a question.

## Language

- **All source code is English**: identifiers, comments, file and folder names, commit
  messages, test names, log messages, error codes.
- The UI has two languages, Hungarian and English, but UI text lives **only** in locale
  files, one `hu` and one `en` per place: `apps/web/src/i18n/{hu,en}.ts` (UI),
  `apps/feedback-widget/src/i18n/{hu,en}.ts` (the embeddable feedback widget's own text),
  `packages/templates/src/locales/{hu,en}.ts` (default display names in templates), and
  `deploy/mac/menubar/Resources/{hu,en}.lproj/Localizable.strings` (native engine menu bar
  app). Components use `t('some.key')`; the native app uses `L10n`. Never hardcode UI text.
  A new key goes into both files of its place, `errors.codes` entries included. `hu` is the
  source of the key set; the web `en.ts` is translated section by section, and a section it
  does not hold yet shows Hungarian (the English wording follows `docs/design/glossary.md`).
  Exception: the names, summaries and link labels in `projectman.structure.yaml` are UI text
  in the project's language (Hungarian here); its ids stay English.
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
  lives behind the `apps/server/src/kernel`, `core`, `runtime` and `services` module facades.
  `apps/server/src/assembly.ts` composes them. Only `apps/server/src/index.ts` reads the environment.
- Older configuration shapes, database rows and timeline events exist in real installations.
  Configuration migrations live in `apps/server/src/config/migrations.ts`, database
  migrations in `apps/server/src/db/migrations.ts`; timeline events are append-only, so old
  event types keep rendering.

## Machine-dependent assumptions

These rules apply to every member, including Codex:

- When adding or changing a machine-dependent part (local paths, processes, sockets,
  accounts, OS features or a shared-host assumption), update the machine-dependent
  inventory in `docs/MACHINE-DEPENDENT.md` in the same change. Record what it does, its code
  location, the machine assumption, what a remote engine needs and the related task.
- Every technical plan must answer **"Does this work on a remote engine?"** Refer to the
  affected inventory entries and state what must run on the engine, what must cross the
  server/engine boundary, or why no machine-dependent part is affected. An unresolved
  boundary choice is a planning question, not an implicit local assumption.
- Codex reads `CLAUDE.md` through `project_doc_fallback_filenames` when there is no
  `AGENTS.md` (`apps/server/src/runner/providers/codex/args.ts`). If an `AGENTS.md` is added
  to this repository, include these rules there too so they still reach Codex.

## Module ownership (parallel workstreams)

| Workstream | Owns                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runner     | `apps/server/src/runner/**`, `apps/server/test/fixtures/fake-{claude,codex,tui}.mjs`                                                                                                         |
| mcp        | `apps/server/src/mcp/**`                                                                                                                                                                     |
| core       | `apps/server/src/{db,kernel,core,runtime,api,auth,config,ws,http,full-test}/**`, `apps/server/src/{app,index,assembly}.ts`, `apps/server/test/**`, `scripts/**`, `projectman.structure.yaml` |
| web        | `apps/web/**`                                                                                                                                                                                |
| github     | `apps/server/src/services/github/**`                                                                                                                                                         |
| context    | `packages/templates/**`, `apps/server/src/{context,worktree,agent-text}/**`                                                                                                                  |
| widget     | `apps/feedback-widget/**`                                                                                                                                                                    |

`packages/shared` is everyone's contract: change it additively, and name the change in your
report. Stay inside your paths otherwise. Each module exposes the factory declared in its
`index.ts`; import other modules through their `index.ts`, never their internals.

Every file under `apps/server/src` belongs to a module in
`apps/server/test/architecture/module-map.ts`; `dependencies.test.ts` enforces its
layer rules. Do not add dependency exceptions: each refactor slice removes its own.

A new file inside an already covered folder needs no map entry. Server paths live only in
`projectman.structure.yaml`; `module-map.ts` reads them from there. Add a new folder or a file
outside all covered folders to the YAML. A new server module needs both a YAML entry and a
`module-map.ts` row with its `layer` and `target`. Add a new web feature folder or top-level
folder to the YAML as well (`structure-map.test.ts` checks it).

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
  - **One test per behavior.** One branch or edge case is one test. A variant gets its own
    case (use `it.each` when needed) only if it reaches a different branch or boundary.
  - **Do not test wording verbatim.** Do not assert prompt or UI sentences one by one. The
    snapshots in `apps/server/src/context/__snapshots__` guard the full prompt; an individual
    test only checks that a conditional part or a required key (label id, tool name, the
    presence of one rule) appears or is absent for the given input. In UI tests, text may be
    used to find an element.
  - **Integration tests only at the boundary.** Real git, filesystem, process, port or
    browser only where the boundary itself is the risk; logic is covered by unit tests and
    is not covered a second time by an integration test.
  - **A card's tests are the card's behavior.** Add tests only for new or changed behavior,
    and one regression test for a bug fix. Prefer extending an existing test over a new file.
  - **Review.** Code review checks this too: a substantial amount of per-variant duplication
    and verbatim wording tests are changes to fix. So is logic added to `assembly.ts`
    (it only wires modules; `test/architecture/assembly-wiring.test.ts` caps it) and a copy
    of a helper that already exists: ask for the fix.

## Commands

```
npm install          # once per checkout / worktree
npm run typecheck    # all workspaces; waits its turn in the machine's heavy-run queue
npm test             # all workspaces; waits its turn in the machine's heavy-run queue
npm run dev          # server (4700) + web (5173)
npm run shots -- <scenario>  # screenshots of a disposable instance (docs/SCREENSHOTS.md); queues too
npm run heavy -- <command>   # any other heavy command, at its turn (--label, --max-wait <s>)
npm run merge-test          # merge checks selected from HEAD's first-parent diff (-- --all forces all)
npm run dead-code           # before hand-over and in fix rounds: unused files/exports (fast, no queue)
npm run full-test -- --workers 4 --timeout 60 -- npm run merge-test -- --all  # macOS, outside member sandboxes
npx vitest related <files> --run   # while working: the tests of what you changed, in the workspace (no queue)
npx vitest run src/i18n/i18n.test.ts --configLoader runner  # in apps/web: after changing locale keys or their usage
npx vitest run test/architecture  # in apps/server after adding, moving or renaming files; before hand-over too (no queue)
npx vitest run test/web-get-contracts.test.ts --configLoader runner  # in apps/server after changing web GET responses or hot-read query costs
npx vitest related test/helpers/app-harness.ts --run --configLoader runner  # in apps/server after changing the app harness, covering every harness consumer
npx vitest related ../../scripts/merge-test/scope.ts --run --configLoader runner  # in apps/server after changing merge-test scope, including CLI selection
npx vitest run test/merge-test-watchdog.test.ts --configLoader runner  # in apps/server after changing merge-test execution or reporting
npx vitest run test/start-offer.test.ts test/golden-path-small-team.test.ts --configLoader runner  # in apps/server after changing admission wake-ups or start timing
npm run typecheck -w <workspace>  # type check only the workspaces you touched (no queue)
```

One heavy run goes at a time on the machine (PM-332, `docs/modules/scripts.md` "Heavy-run
queue"): the root `npm test`, `typecheck` and `shots` wait behind the other members' and the
server's full test, and print who they wait for. Only Claude Code members run them in the
background: Claude Code sends a completion notification. Codex, Gemini (agy) and NanoGPT
members run them in the foreground and keep waiting until completion, including when the
shell tool returns a running command id; follow the provider-specific waiting instructions
in the context pack. Gemini's native `command_status` follows a running command; bounded
`schedule` wakeups are an optional path described there. Do not finish the turn while the
command is still running. Developers run only related tests (`npx vitest related <files> --run`
inside the affected workspace) and the type check of the workspaces they touched, including
before hand-over and in fix rounds. When removing a capability, also search tests for its
retired tool names, inbox kinds and route or file paths, then run the matching boundary tests:
HTTP calls and string fixtures are not covered by import-based related selection.
When changing the shared `ErrorCode` union, update
`errors.codes` in `apps/web/src/i18n/hu.ts`, run `npm run typecheck -w @projectman/web`, and
run the web i18n test listed above. Also run `npm run dead-code` from the repository root
before hand-over and in fix rounds; it is fast and does not queue. Fix new findings rather
than extending the baseline.
After changing `apps/web/src/mocks`, run `npx vitest run src/mocks` in `apps/web`. After adding, moving or renaming files, also run
`npx vitest run test/architecture` in `apps/server`, including before hand-over; it is fast
and does not queue. They never run the full suite. The merger (`team.merger`,
`claude` in PM) merges with `merge_task`. The server runs the card's single full check at merge,
before `main` moves: `npm run merge-test` in the full test sandbox, in the machine's queue.
Any card adding a merge check that can run quickly in the developer's worktree must update
the developer hand-over checklist in the same change.
When a merge fails a check the developer could have run locally, the merger names that
command in the send-back note; if it was missing from the checklist, propose adding it
and send the lesson to the project manager for `docs/LESSONS.md`.
Shared code or configuration changes require the whole suite; workspace checks do not queue
(decision 40, PM-380, PM-386). If a heavy command says its queue cannot be used
(exit status 78), or the sandbox refuses a test (a local port, a pseudo-terminal), it did not
run: note on your card what did not run and why, and hand over; the merge test runs it.
Never run it another way, and do not ask anyone to run it outside your sandbox (PM-346, PM-656).

`npm run dev` keeps its data in `~/.projectman-dev` unless `PROJECTMAN_HOME` is set. The
owner's live instance uses a cloud hub and a Mac engine, updated only on the owner's request:
`npm run cloud -- deploy --ref <commit>`, then rebuild and reinstall the engine at the same commit
(`docs/DEPLOY.md`). `publish_release` publishes on request after a preview; there is no release watcher.
`npm run live -- install|status|uninstall` is retained only for single-mode disaster recovery.
Never run a development build against `~/.projectman`: a database migrated by a newer build is
refused by older ones. Open development instances at `http://127.0.0.1:5173`.

## Git

English, imperative commit messages ("Add session runner state machine"). Commit your
work on your branch; do not push. The merger member merges verified work and pushes `main`
through `merge_task` (decision 21, PM-386); the repository is public. Nobody commits to `main`
or switches branches in the default branch's checkout: `main` moves only through merging.
