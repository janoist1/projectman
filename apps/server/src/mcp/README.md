# Team tools MCP server (`src/mcp`)

AI members (Claude Code sessions) reach their team through an MCP server named `team`; Claude
sees its tools as `mcp__team__<tool>`. It replaces the desktop app's SendMessage between
sessions. The behaviour lives in the domain (`TeamToolsHandler`, see
`src/contracts/team-tools.ts`); this module is the MCP transport, the tool definitions and the
text the model reads.

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

| Tool                | Input                                                       | Handler call                                            |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `send_message`      | `to` (handles, 1–20), `text`, `task_key?`                   | `sendMessage(ctx, { to, text, taskKey? })`              |
| `list_members`      | none                                                        | `listMembers(ctx)`                                      |
| `get_task`          | `task_key`                                                  | `getTask(ctx, { taskKey })`                             |
| `update_task`       | `task_key`, `stage_id?`, `check?: { name, state }`, `note?` | `updateTask(ctx, { taskKey, stageId?, check?, note? })` |
| `link_pull_request` | `task_key`, `repo` (`owner/name`), `number`                 | `linkPullRequest(ctx, { taskKey, repo, number })`       |
| `ask_human`         | `question`, `options?` (1–10), `task_key?`, `to?` (handles) | `askHuman(ctx, { question, options?, taskKey?, to? })`  |
| `save_memory`       | `note` (max 2000 chars)                                     | `saveMemory(ctx, { note })`                             |

- Inputs are zod schemas (`tools.ts`), strict: an unknown key is an error rather than
  silently dropped. Handles, task keys, stage ids and check names/states reuse the
  `@projectman/shared` schemas.
- `task_key` of `send_message` and `ask_human` defaults to the session's task
  (`ctx.taskKey`); from a session without a task, an omitted key means a general message.
- `to` is deduplicated. `send_message` also drops the caller's own handle and refuses a
  message addressed only to the caller.
- `update_task` needs at least one of `stage_id`, `check` and `note`.
- Descriptions and the server instructions (sent at initialize; Claude Code adds them to the
  system prompt) tell the model to: address teammates by handle, be concise, write in the
  project's language, answer team messages with `send_message`, record check results with
  `update_task`, link PRs, and use `ask_human` for human decisions.

## Results and errors

Results are short plain text (a roster, a task card with the last 20 timeline events,
"Updated AR-21: …", …). Errors are tool results with `isError: true`:

| Case                                | Text                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| input does not match the schema     | `Input validation error: …` (from the SDK; the handler is not called)  |
| handler throws `TeamToolError`      | `Error [not_found \| forbidden \| invalid \| gate_blocked]: <message>` |
| handler does not settle within 60 s | `Error [timeout]: …` (the action may still complete; outcome logged)   |
| any other exception                 | `Error [internal]: <tool> failed …` (details only in the error log)    |

## What the handler (domain) should do

- Resolve quickly. The HTTP call, and the Claude turn with it, stays open until the handler
  settles. Queue deliveries into busy sessions instead of awaiting them: two members
  messaging each other while both wait would deadlock until the timeout.
- `updateTask`: record the check and the note before the stage move, so that one call such as
  `check: qa passed` + `stage_id: client_test` can pass the gate. The tool description
  promises this order.
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
`guard.test.ts` and `format.test.ts` cover the helpers. `testing.ts` provides an in-memory
`TeamToolsHandler` that other tests can reuse.
