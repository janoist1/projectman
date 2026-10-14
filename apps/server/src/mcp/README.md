# Team tools MCP server (`src/mcp`)

AI members (Claude Code or Codex sessions) reach their team through an MCP server named `team`;
Claude sees its tools as `mcp__team__<tool>`. It replaces the desktop app's SendMessage between
sessions. The handler contracts live in
`src/contracts/team-tools.ts` (`TeamToolsHandler`). This module owns the MCP transport,
module tool definitions and handlers, and the text the model reads.

## Where a tool goes

A module's tools live in `mcp/<module>/`: `tools.ts` exports a `TeamToolGroup`,
`handler.ts` implements the module's handler contract, and `index.ts` exports both.
The groups so far are `members`, `tasks`, `attachments`, `merges`
(`merge_task`, `prioritize_merge`; module `services/merges`), `feedback`, `github`
(`link_pull_request`; module `services/github`) and `boundary`. `tools.ts` collects their
definitions in `TEAM_TOOL_GROUPS`; `TeamToolsService` in `domain/team-tools.ts`
forwards to their handlers. New tools belong in the module's group and handler,
never in either collector. The remaining tools move with their own module's
refactor pass (PM-577).

Assembly creates one shared `ToolCaller` (`caller.ts`) for caller checks, the
Operator's request and guest access, step logging, and opening session files.
Every handler receives that instance so signal-step reservations stay shared.
Shared definition types, schemas and helpers live in `kit.ts`.

REST routes already register by module: `api/<module>.ts` exports
`register<X>Routes(app, deps)`, collected by `registerApiRoutes` in `api/index.ts`.
No REST code or contract changes are needed for this registration.

## Endpoint

The runner gives every session its own URL:

```json
{ "mcpServers": { "team": { "type": "http", "url": "http://127.0.0.1:4700/mcp/<token>" } } }
```

Pre-allow the tools with `mcp__team` (all tools of the server) in the session's allowed tools.

| Request                     | Answer                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- |
| `POST /mcp/:token`          | Streamable HTTP, stateless, JSON responses (`202` for notifications)              |
| `GET`, `DELETE /mcp/:token` | `405`: no server-to-client stream and no MCP session to end (allowed by the spec) |

**Stateless**: each POST gets a fresh MCP server and transport, bound to the `ToolContext`
that `resolveContext(token)` returns for that request. No MCP session id is issued, nothing is
kept between requests, and a revoked token stops working at once.

**Access** (checked before the body is read):

1. Local callers only, else `403`: the socket address must be loopback (127.0.0.0/8, `::1`,
   `::ffff:127.x.x.x`); no forwarding headers (`Forwarded`, `X-Forwarded-For`,
   `X-Forwarded-Host`, `X-Real-IP`, e.g. added by `tailscale serve`); the `Host` must be
   `127.x.x.x`, `localhost` or `[::1]`, and an `Origin`, if present, a loopback origin
   (both guard against DNS rebinding).
2. Unknown token: `404`. Not `401`: on a 401 MCP clients, Claude Code included, start an
   OAuth flow.

The token is part of the URL, so Fastify's request logs for these routes are limited to
`warn`. The module logs tool calls itself (debug; failures at warn/error), without the token.

**Client compatibility**, from reading the MCP client bundled in Claude Code 2.1.223 (the
tests use the SDK's own client, which behaves the same way here):

- It connects to `http` servers with the classic `initialize` handshake (protocol
  `2025-11-25`, the SDK's latest), needs no session id, sends no `Origin`, and treats a `405`
  on GET as "no stream". Its default MCP tool timeout is about 28 hours, hence our own.
- With protocol negotiation on (`MCP_PROTOCOL_NEGOTIATION=auto` or a feature flag) it first
  probes with `server/discover` (protocol `2026-07-28`). This server answers the probe with a
  JSON-RPC error (`-32601`, or `400`/`-32000` when the probe sends the 2026 version header),
  and the client falls back to `initialize`. Covered by a test.
- It routes even `127.0.0.1` through `HTTP(S)_PROXY` unless `NO_PROXY` names the host, so
  the runner should put `127.0.0.1,localhost` into `NO_PROXY` of every session.

## Tools

| Tool                        | Input                                                                                                                                                                                                     | Handler call                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `send_message`              | `to` (handles, 1–20), `text`, `task_key?`, `attachments?` (1–10 file paths, as for `attach_file`; all or nothing)                                                                                         | `sendMessage(ctx, { to, text, taskKey?, attachments? })`                                                              |
| `list_members`              | none                                                                                                                                                                                                      | `listMembers(ctx)`                                                                                                    |
| `list_tasks`                | `status?`, `stage?`, `assignee?`, `limit?`                                                                                                                                                                | `listTasks(ctx, args)`                                                                                                |
| `get_task`                  | `task_key`                                                                                                                                                                                                | `getTask(ctx, { taskKey })`                                                                                           |
| `update_task`               | `task_key`, `stage_id?`, `add_labels?` (max 10), `remove_labels?` (max 10), `note?`, `title?`, `description?`, `repo?` (name or `null`)                                                                   | `updateTask(ctx, { taskKey, stageId?, addLabels?, removeLabels?, note?, title?, description?, repo? })`               |
| `create_task`               | `title` (max 200 chars), `description?`, `labels?` (max 10), `visibility?`, `parent_key?`                                                                                                                 | `createTask(ctx, { title, description?, labels?, visibility?, parentKey? })`                                          |
| `link_pull_request`         | `task_key`, `repo` (`owner/name`), `number`                                                                                                                                                               | `linkPullRequest(ctx, { taskKey, repo, number })`                                                                     |
| `ask_human`                 | `question`, `options?` (1–10: labels, or `{ label, consequence? }`), `recommended?`, `recommendation_reason?`, `details?`, `task_key?`, `to?`, `attachments?` (1–6 `att_…` ids of the card or its parent) | `askHuman(ctx, { question, options?, recommended?, recommendationReason?, details?, taskKey?, to?, attachmentIds? })` |
| `withdraw_question`         | `item_id`, `reason` (1–1000 chars)                                                                                                                                                                        | `withdrawQuestion(ctx, { itemId, reason })`                                                                           |
| `save_memory`               | `note` (max 2000 chars)                                                                                                                                                                                   | `saveMemory(ctx, { note })`                                                                                           |
| `list_attachments`          | `task_key`, `offset?` (default 0), `limit?` (1–200, default 50)                                                                                                                                           | `listAttachments(ctx, { taskKey, offset, limit })`                                                                    |
| `read_attachment`           | `task_key`, `attachment_id`                                                                                                                                                                               | `readAttachment(ctx, { taskKey, attachmentId })`                                                                      |
| `attach_file`               | `task_key`, `path` (relative to the session's working directory, or absolute inside it or inside the session folder)                                                                                      | `attachFile(ctx, { taskKey, path })`                                                                                  |
| `delete_attachment`         | `task_key`, `attachment_id`                                                                                                                                                                               | `deleteAttachment(ctx, { taskKey, attachmentId })`                                                                    |
| `take_screenshots`          | `scenario` (1–500 chars), `widths?` (1–8 × 200–4000), `full_page?`, `scale?` (1 or 2), `timeout_seconds?` (1–600), `seed?` (`demo` or `none`)                                                             | `takeScreenshots(ctx, { scenario, widths?, fullPage?, scale?, timeoutSeconds?, seed? })`                              |
| `get_screenshot_run`        | `run_id` (1–64 chars)                                                                                                                                                                                     | `getScreenshotRun(ctx, runId)`                                                                                        |
| `hand_off`                  | `task_key`, `note` (1–`HANDOFF_NOTE_MAX` chars)                                                                                                                                                           | `handOff(ctx, { taskKey, note })`                                                                                     |
| `get_feedback`              | `mark_id?` (`fbm_…`), `status?` (`todo` default, `open`, `all`), `limit?` (1–100, default 30)                                                                                                             | `getFeedbackList(ctx, { status, limit })` or `getFeedbackMark(ctx, { markId })`                                       |
| `reply_feedback`            | `mark_id`, `body` (1–4000 chars)                                                                                                                                                                          | `replyFeedback(ctx, { markId, body })`                                                                                |
| `create_task_from_feedback` | `mark_id`, `title`, `description`, `visibility?`, `reply?`                                                                                                                                                | `createTaskFromFeedback(ctx, { markId, title, description, visibility?, reply? })`                                    |
| `link_feedback`             | `mark_id`, `task_key`, `reply?`                                                                                                                                                                           | `linkFeedback(ctx, { markId, taskKey, reply? })`                                                                      |
| `forward_feedback`          | `mark_id`, `reason` (1–1000 chars), `reply` (1–4000 chars)                                                                                                                                                | `forwardFeedback(ctx, { markId, reason, reply })`                                                                     |
| `close_feedback`            | `mark_id`, `reply?`                                                                                                                                                                                       | `closeFeedback(ctx, { markId, reply? })`                                                                              |

- The feedback tools (PM-512) are for AI members that hold the `feedback_processing` duty (by default the
  project manager); everyone else, the Operator included, gets `forbidden` with `feedback_processor_only`.
  The domain's refusals reach the caller as `<code>: <message>` (e.g. `feedback_waiting_owner`: an AI does not
  act on a mark that waits for the owner). `get_feedback { mark_id }` gives the stored screenshot's path only
  to a session that runs on the server's machine; a session on a remote engine is told to read the image
  from the card's attachment once a card is opened from the mark.

- `get_project_state { task_key? }` (PM-465) is a read-only Operator tool, available without an open owner request.
  A task report starts with the shared TaskWait explanation, then its active system signals and recorded causes.
  Without a task key it returns stage counts, live sessions, waiting starts, pauses, owner inbox items and signals.
  Guest conversations cannot call it until a separate task provides a viewer filter.
  The overview also carries the `release` block (PM-542: the running version, commit and tag, the latest live and the
  open release, the latest merges into the default branch), the starts that wait without a card (`general`) and the
  undelivered team messages per AI member.
- `prioritize_merge { task_key, reason }` (PM-576) puts the card's queued merge at the front of its repository's
  merge queue. The card's merger and the Operator (in an owner's open request, logged as the step `task_update`)
  may call it; it answers `moved` or `not moved` (first already). The running merge is not interrupted, a card
  whose merge is not queued (none, requested, running, failed…) is refused with `merge_not_prioritizable`,
  someone else with `merge_not_merger`. The reason and the cards it went ahead of go on the card's timeline
  (`task_merge_prioritized`). Handler method: `prioritizeMerge(ctx, { taskKey, reason })`. An owner does the
  same in the UI (`POST …/tasks/:taskKey/merge/prioritize`, the "Előre" button of the queued merge box).
- `check_release { commit? }` (PM-542) is a read-only Operator tool, available without an open owner request and
  not in guest conversations. It is the preview of `propose_release`: the same checks, the answer is either the
  candidate or the refusal (same code and message) `propose_release` would give now, plus the members with the
  deployment duty who may propose it. It records nothing; the Operator never proposes a release itself.
- `read_project_doc { doc, from_line?, line_count? }` and `write_project_docs { base_commit, message, edits }`
  (PM-495) are Operator tools for the decision log and the roadmap: the first reads the file at the fresh head of
  the default branch (a read tool: no open request needed, not in guest conversations), the second replaces text
  in them as one commit pushed to the default branch (the owner's own conversation and an open request only; it
  answers `published`, `queued` or `running`). Handler methods: `readProjectDoc(ctx, { doc, fromLine?, lineCount? })`,
  `writeProjectDocs(ctx, { baseCommit, message, edits })`. See ARCHITECTURE.md, "Operator documents".
- `list_decision_candidates { limit? }` and `mark_decision_candidates { items }` (PM-496) are Operator tools for
  the owner's answers on cards that may be decisions: the first lists them (a read tool: no open request, not in
  guest conversations; `limit` 1..50, default 20; `{ candidates, more }`), the second records the owner's verdict
  per item (`recorded` with an optional `decision` number, `declined`, `skipped`; the owner's own conversation and
  an open request only; all or nothing). Handler methods: `listDecisionCandidates(ctx, { limit? })`,
  `markDecisionCandidates(ctx, { items })`. See ARCHITECTURE.md, "Decision candidates".
- `screen_question { item_id, outcome, note, answer?, forward_to?, todo? }` (PM-558) is the Operator's tool for
  the questions AI members ask people (`ask_human` puts them in the inbox state `screening` first). Outcomes:
  `answered` (needs `answer`), `forwarded` (needs `forward_to`), `moot`, `decision`, `todo` (needs `todo`
  `{ what, where, expected }`); `note` is always required, a field the outcome does not take is refused
  (`invalid_outcome_fields`). Only the Operator, not in guest conversations, no open request needed; a question
  no longer in screening answers `question_not_screening` (moot still works). `ask_human` answers
  `{ screening: true }` for a screened question and takes `reask_of` + `reask_reason` (together) to ask a settled
  question again unscreened (`reask_not_allowed` otherwise). Handler method: `screenQuestion(ctx, { itemId,
outcome, note, answer?, forwardTo?, todo? })`. See ARCHITECTURE.md, "The Operator".
- `hand_off` (PM-342) is for the member a card is being handed over from, after the system told it to
  write the handoff note: only that member, while the handoff is open (`handoff_not_open` otherwise,
  also when the time ran out and the summary stands in). It records the note and the state of the
  worktree, and the session closes at its next idle moment.
- Inputs are zod schemas (`tools.ts`), strict: an unknown key is an error rather than
  silently dropped. Handles, task keys, stage ids, task statuses and visibility reuse the
  `@projectman/shared` schemas; label ids are strings of at most 40 characters.
- `task_key` of `send_message` and `ask_human` defaults to the session's task
  (`ctx.taskKey`); from a session without a task, an omitted key means a general message.
- `to` is deduplicated. `send_message` also drops the caller's own handle and refuses a
  message addressed only to the caller.
- `ask_human` is written for a human who is not a specialist; the tool description (and the
  system prompt's guardrails) say how. `question` is one plain sentence that names the decision.
  Each option is a label or `{ label, consequence }` (what happens if it is picked).
  `recommended` is the exact label of one option and `recommendation_reason` one sentence (it
  needs `recommended`); `details` is markdown background that the inbox shows folded. The
  schema checks only what can be wrong beyond doubt, before the handler: `recommended` must
  name an option, and a reason needs a recommendation. The wording is never refused: a question
  over 300 characters, or one without a recommendation, is asked all the same, and the result
  adds a "Tip for your next question" line (`Consider moving detail into details.`; a
  recommendation is suggested when there is none). The domain stores the fields in the inbox
  item (`payload.recommended` as the option's id, `recommendationReason`, `details`;
  `consequence` on the option) and makes the recommended option the primary button, so
  questions without them stay as they were.
- `update_task` needs at least one of `stage_id`, `add_labels`, `remove_labels`, `note`,
  `title`, `description` and `repo`. Labels follow the project's label definitions (who may set them,
  groups, a required note, no self-review, human-only approvals), enforced by the domain; the
  note is the comment that explains them. `description` replaces the whole description (the
  analyst's specification, the architect's technical plan); the change is recorded in the
  timeline as `task_updated`. `repo` is the name of one of the project's repositories, or `null`
  to clear it (PM-68); an unknown name is refused with the names the project has. It is refused
  while any session of the task runs, the caller's own included (`task_session_live`); the change
  is recorded as `task_updated` with `fields: ['repo']`, `repo` and `previousRepo`.
- Attachments (PM-113) go through the PM-111 attachments service in the caller's name (actor
  `ai:<handle>`, never the sponsor), with the REST rules. `get_task` lists the first 20 with the
  total; `list_attachments` pages the rest, so a long list is never cut silently.
  `read_attachment` answers with text only: the local path (an image or PDF has a path with its
  extension, a hard link to the stored file), its type and how to read it with the agent's own
  tools; the content is never put into the answer and never run. `attach_file` takes no
  directory, uploader or storage place from the caller: the domain reads the session's working
  directory from the session the token names (and, for an absolute path inside it, the session's
  own folder, PM-268) and has the session's engine open the file with `EngineHost.openWorkspaceFile`
  (`engine-host/workspace-file.ts`, PM-312). `delete_attachment` deletes only the caller's own.
- Screenshots (PM-351) are for the members whose own sandbox cannot start Chromium (Codex).
  `take_screenshots` starts `npm run shots` in the caller's worktree, in the server's own `srt`
  sandbox (`domain/screenshot-runs.ts`, `full-test/screenshots.ts`), and waits at most 40 s; a run
  still going is answered as `running`, and `get_screenshot_run` waits another 40 s. The arguments
  are built from the validated fields only: `--out`, `--keep-data` and `--machine` cannot be given,
  and the scenario must be a file inside the working directory or the session folder (real path).
  The images land in `shots/` of the session folder; the answer lists their paths, to open with the
  agent's image tool or to `attach_file`. One run at a time per session; both tools are refused
  (`forbidden`) for a session without a folder in a worktree and off macOS. The answer is text only.
- `get_task` includes the parent and one-level subtasks with keys, titles, stages and statuses.
  Its `Repo:` line is the repository the work happens in (the task's own, else the project's only
  one), or says that none is chosen yet (the project has several) or that the work is in the
  workspace root (the project has none); the handler returns it as `effectiveRepo` and
  `repoChoiceNeeded` beside the detail.
- `create_task` accepts optional `parent_key` for a one-level subtask in the same project. It creates the task in the pipeline's first (queue) stage, unassigned and
  attributed to the calling member (`task_created` in the timeline, with the session); humans
  prioritise it. Support turns bug reports into cards with it, the architect proposes a
  breakdown, the analyst splits requests.
- Each piece of guidance is stated once. What a tool does and when to use it (link PRs right
  away, the `ask_human` answer arrives later as a team message, new tasks wait for humans to
  prioritise them, …) is in its description and parameter descriptions. Team rules that are
  not about one tool (address teammates by handle, text in your own session reaches nobody,
  be concise, the project's language, record results on the task) are in the member's system
  prompt (`src/context/system-prompt.ts`, "How the team works"), which both Claude Code
  (`--append-system-prompt`) and Codex (`developer_instructions`) receive. The server
  instructions (sent at initialize) only say what the server is and point there: Claude Code
  appends them to the system prompt, and Codex 0.159.1 shows them to the model as the
  description of the `team` tool namespace, so rules there would be stated twice.
- Results say what the call did (`Created AR-22 …`, `Question … is waiting in the inbox of
owner.`); they do not repeat the guidance of the description.

## Results and errors

Results are short plain text (a roster, a task card with the last 20 timeline events,
"Updated AR-21: …", …). Errors are tool results with `isError: true`:

| Case                                | Text                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| input does not match the schema     | `Input validation error: …` (from the SDK; the handler is not called)                                                                                  |
| handler throws `TeamToolError`      | `Error [not_found \| forbidden \| invalid \| gate_blocked]: <message>`; Operator refusals name their domain code, e.g. `operator_only`, in the message |
| handler does not settle within 60 s | `Error [timeout]: …` (the action may still complete; outcome logged)                                                                                   |
| any other exception                 | `Error [internal]: <tool> failed …` (details only in the error log)                                                                                    |

## What the handler (domain) should do

- Resolve quickly. The HTTP call, and the Claude turn with it, stays open until the handler
  settles. Queue deliveries into busy sessions instead of awaiting them: two members
  messaging each other while both wait would deadlock until the timeout.
- `updateTask`: one call is all or nothing. The title, description, labels and note count
  before the stage move, so that one call such as `add_labels: ["qa-ok"]` +
  `stage_id: "client_test"` can pass the gate; a refused label or a blocked gate records
  nothing, and a move that needs a human approval records the rest and requests it. The tool
  description promises exactly this.
- Throw `TeamToolError` for expected refusals, with a message written for the model
  (English): unknown handle or task (`not_found`), an AI handle in `askHuman.to`
  (`invalid`), a gate that is not met (`gate_blocked`), and so on.

## Wiring

```ts
createMcpModule({ handler, resolveContext, logger: app.log }).registerRoutes(app);
```

- Call it before `app.ready()` / `app.listen()`. It registers an encapsulated plugin with its
  own JSON body parser (the raw text goes to the SDK), so the app's parser settings do not
  affect `/mcp`.
- App-wide `onRequest` hooks such as the login-cookie check must let `/mcp/` through.
- Optional `toolTimeoutMs` (default 60 000) overrides the timeout, e.g. in tests.

## Tests

`npm test -w @projectman/server`: `mcp.test.ts` runs a real Fastify server and the SDK's
`Client` with `StreamableHTTPClientTransport` (initialize, tool list and schemas, every tool,
errors, timeout, tokens, HTTP methods, the `server/discover` probe, localhost enforcement);
`format.test.ts` covers the helpers; the local-request guard is `src/http/local-guard.ts`
(tested in `local-guard.test.ts`). `testing.ts` provides an in-memory
`TeamToolsHandler` that other tests can reuse.
