# projectman — working rules

Read `docs/ARCHITECTURE.md` first. Decisions and their reasons: `docs/DECISIONS.md`.

## Language

- **All source code is English**: identifiers, comments, file and folder names, commit
  messages, test names, log messages, error codes.
- The UI language is Hungarian, but Hungarian text lives **only** in locale files:
  `apps/web/src/i18n/hu.ts` (UI) and `packages/templates/src/locales/hu.ts` (default
  display names in templates). Components use `t('some.key')`; never hardcode UI text.
- Prompt text for AI members (role instructions, context pack) is English; it tells the
  agent to communicate in the project's language.

## Subscription rule

- Never use or set `ANTHROPIC_API_KEY` (or other API-billing variables). The runner
  strips them from the environment of every session.
- Never run the real `claude` CLI in automated tests. Use the fake CLI in
  `apps/server/test/fixtures/`.

## Contracts

- `packages/shared` (zod schemas + types) and `apps/server/src/contracts` are the source
  of truth between modules and between server and web.
- Prefer adding to contracts over changing them. If a contract must change, keep the
  change minimal and list it in your final report.

## Module ownership (parallel workstreams)

| Workstream | Owns                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| runner     | `apps/server/src/runner/**`, `apps/server/test/fixtures/fake-claude*`                                     |
| mcp        | `apps/server/src/mcp/**`                                                                                  |
| core       | `apps/server/src/{db,domain,api,auth,config,ws}/**`, `apps/server/src/app.ts`, `apps/server/src/index.ts` |
| web        | `apps/web/**`                                                                                             |
| github     | `apps/server/src/github/**`                                                                               |
| context    | `packages/templates/**`, `apps/server/src/{context,worktree}/**`                                          |

Stay inside your paths. Each module exposes the factory declared in its `index.ts`.

## Code style

- TypeScript strict, ESM, `moduleResolution: bundler` (extensionless relative imports).
- `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties.
- `verbatimModuleSyntax`: use `import type` for type-only imports.
- Validate data at boundaries with zod (HTTP bodies, hook payloads, MCP args, YAML).
- Prettier config in `.prettierrc.json` (`npm run format`).
- Tests: vitest, `*.test.ts` next to the code or under `test/`. Use temp directories;
  never touch real user repositories (e.g. client projects) or `~/.claude` in tests.

## Commands

```
npm install          # once per checkout / worktree
npm run typecheck    # all workspaces
npm test             # all workspaces
npm run dev          # server (4700) + web (5173)
```

## Git

English, imperative commit messages ("Add session runner state machine"). Commit your
work on your branch; do not push.
