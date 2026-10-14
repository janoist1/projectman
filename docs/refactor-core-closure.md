# Phase 5 core and kernel closure (PM-645)

Baseline: PM-629's plan at `796d9b0ea4ef68d0b82e193d09d3fe93a8a57120`.
This inventory records the completed PM-631–644 slices and the boundary passed to
PM-630. The module map, facades and source files remain authoritative.

## Final module inventory

Every row has `sealed: true`, a final `index.ts`, and only the listed folder in
`paths`. The baseline id, layer, target and pass are unchanged; the eight separate
core descriptors assemble in the original public `MODULES` order and shape.

| Module / final folder | Layer | Pass  | Implementations moved by |
| --------------------- | ----- | ----- | ------------------------ |
| `kernel/`             | infra | move  | PM-631                   |
| `core/base/`          | core  | split | PM-637                   |
| `core/projects/`      | core  | split | PM-638                   |
| `core/tasks/`         | core  | split | PM-639                   |
| `core/members/`       | core  | split | PM-640                   |
| `core/timeline/`      | core  | move  | PM-641                   |
| `core/messages/`      | core  | split | PM-642                   |
| `core/inbox/`         | core  | split | PM-643                   |
| `core/attachments/`   | core  | move  | PM-644                   |

`domain/` contains only `index.ts`: composition plus public compatibility exports
from module facades. There are no former core/kernel implementations or forwarding
shims. Internal attachment subfolder indexes are implementation entry points, not
old-location shims. `TaskMoves`, `MessageImageRenderer` and `WAKE_REPLY_WAIT_MS` remain
private; their consumers are the three relocated internal test files.

## All fifteen original exception pairs

| From          | To                | Removed by |
| ------------- | ----------------- | ---------- |
| core/tasks    | runtime/watchers  | PM-612     |
| core/tasks    | runtime/sessions  | PM-632     |
| core/tasks    | runtime/usage     | PM-632     |
| core/tasks    | services/github   | PM-632     |
| core/base     | runtime/sessions  | PM-632     |
| core/projects | runtime/sessions  | PM-632     |
| core/members  | auth              | PM-633     |
| core/members  | runtime/admission | PM-633     |
| core/members  | runtime/sessions  | PM-633     |
| core/messages | runtime/delivery  | PM-634     |
| core/messages | services/operator | PM-634     |
| core/messages | runtime/admission | PM-634     |
| core/messages | runtime/sessions  | PM-634     |
| core/inbox    | runtime/sessions  | PM-635     |
| core/inbox    | runtime/admission | PM-635     |

PM-612 had already removed the AutoAdvance re-export when phase 5 started. The
remaining fourteen were removed by its preparation chain; closure adds no new
exception deletion. `EXCEPTIONS` now has no core source.

## Slice result notes and their disposition

All slices are done and reviewed on their cards. The checks below are recorded
slice results, not suite runs repeated by PM-645. Server type checks passed on all
slices; PTY integration coverage belongs to the merger's full check.

| Card   | Recorded result / verification                                                                                | Closure disposition                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PM-631 | Kernel moves, descriptors and docs; 256 developer tests, 162 reviewer tests.                                  | Final folders/facade verified. Reviewer covered engines/invitations/auth-restart initially blocked by developer EPERM.                                                                                                                                         |
| PM-632 | Four core ports, shared session facts and internal PR records; 130 targeted tests.                            | Ports and PR records now at final core locations; all five pairs accounted for above.                                                                                                                                                                          |
| PM-633 | Invitation/account, profile/session and capacity ports; reviewer 89 targeted tests and security approval.     | Existing `claudeTmpRoots: []` test isolation and inventory retained; production root discovery unchanged. Three pairs accounted for.                                                                                                                           |
| PM-634 | Message ports, `EnsureSessionOptions` moved to contracts; 171 developer / 233 reviewer tests.                 | Existing `restartWithMessages` port addition retained: required by description-change notices. Four pairs accounted for; no further contract change here.                                                                                                      |
| PM-635 | Permission policy and screening ports; reviewer 356 targeted tests and security approval.                     | Canonical engine realpath, first-input/lock and delivery order retained. Existing engine regression tests retained; SECURITY.md needs no change because policy remains in runtime. Two pairs accounted for.                                                    |
| PM-636 | Eight sealed facades, six factories, consumer inventory and three internal test moves; 16 architecture tests. | Final facades and compatibility exports verified. Reviewer covered all four release socket tests initially blocked by developer EPERM. Factory placement before imports is cosmetic and requires no closure change; signatures and construction remain intact. |
| PM-637 | Three base implementations moved; reviewer 33 targeted tests.                                                 | Final paths verified. Initial golden-path merge failure was followed by the successful recorded merge; no core change is required here.                                                                                                                        |
| PM-638 | Four project implementations moved; 142 developer targeted tests.                                             | No internal `tests/` folder is required: external tests consume the facade. Existing config facade import is correct.                                                                                                                                          |
| PM-639 | Seventeen task/board implementations moved; architecture and targeted task/board checks passed.               | Final paths verified, old task index removed; public facade and internal PR records retained.                                                                                                                                                                  |
| PM-640 | Five member implementations moved; reviewer 91 targeted tests.                                                | Final paths verified; existing invitation record alias and access/commit order retained. No internal tests were relocated for this module.                                                                                                                     |
| PM-641 | Timeline moved; 16 architecture and 15 domain/extension tests.                                                | Module docs now describe final sealed path and external tests. No separate ports, timeline/task-notes test file or internal tests folder is needed.                                                                                                            |
| PM-642 | Four message implementations moved; 106 targeted tests.                                                       | Old messaging index is gone. PM-645 corrects the reported stale `runtime/sessions/sessions.ts` comment to `core/messages` (and its adjacent admission reference).                                                                                              |
| PM-643 | Seven inbox implementations moved; architecture and targeted checks passed.                                   | Final paths and permission/screening ports verified; behavior and approval contracts retained.                                                                                                                                                                 |
| PM-644 | Both attachment subfolders moved; 257 developer / 275 reviewer targeted tests.                                | Final docs and machine inventory now identify card/message storage behind the facade; protections and engine transfers remain intact.                                                                                                                          |

## Import and documentation audit

- `src`, `test` and `scripts` were searched for former implementation paths,
  including exports and embedded `import('…')` types. No import points at a former
  core/kernel implementation. Bare `domain` imports resolve to the retained assembly
  compatibility facade and are intentionally distinguished from removed deep paths.
- The unchanged architecture checker includes value/type imports, export-from and
  embedded import types. Its production-source check passes without new exceptions
  or relaxed rules. Core has no runtime/service/auth edge and no Effect import.
  Kernel Effect helpers and sweeps are unchanged.
- ARCHITECTURE.md now states final folders, responsibility rows, core ports and
  card/message attachment and permission locations. All eight linked module docs
  match their facades; stale preparation text is corrected where it remained.
- CLAUDE.md now names core/runtime/service business logic and core/kernel ownership.
  EFFECT.md already names `kernel/sweeps.ts` and the still-current composition file;
  MCP README already names `src/kernel/local-guard.ts`. Neither requires a path edit.
  DECISIONS.md and ROADMAP.md are untouched. Shared-domain paths, historical comments
  and synthetic old test-output paths are not obsolete core implementation imports.

## Handoff to PM-630

Keep `domain/index.ts` composition and its compatibility exports until its planned
move to `assembly.ts`. Context still consumes that assembly surface; narrowing and
sealing context, sealing MCP and removing connector exceptions belong to phase 6.
The four remaining pairs are `api → assembly`, `auth → assembly`, `ws → assembly`
and `instance → entry`; PM-646 begins their connector work. Do not restore any core
exception or make private implementation exports public to accommodate that work.

Core remains server-side. Kernel helpers run in their consumer process. Permission
and session operations use the existing engine ports; attachment storage and image
processing remain on the server, while authorized session copies use EngineHost /
engine-link. No filesystem assumption, CLI/socket operation or RPC payload changed.

PM-645 verification: architecture 2 files / 16 tests, server typecheck and formatting
checks passed. The related run for the changed session comment also selected socket,
PTY and sandbox integration tests. Those encounter `listen EPERM`, denied legacy
temporary roots or sandbox execution failures in the member environment. The run
stopped producing output after its last reported tests and was interrupted (exit
130); no final related-run totals are claimed. An
authorized retry of MCP, engine-app and release tests still returned 129 failures
and 54 passes, with the same socket restriction. These integration results require
the merger's full-test environment; this card does not claim a fully green related
run. Only documentation and a source comment change; no runtime behavior, API,
shared/contract shape, migration, configuration or timeline event changes.
