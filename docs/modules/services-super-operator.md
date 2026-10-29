# services/super-operator

## Responsibility

The super mode (PM-757): the owner-bound operations an integrator key or the in-app project manager starts, the owner's
question for a reserved effect, the external MCP endpoint (`mcp/super-operator`), and the closed project diagnostics
catalogue.

## Owner-bound super operations (PM-762, PM-764)

The Operator's queue handoffs (PM-1003) use the existing integrator inbox: `no_grant`, `no_typed_operation`
and `processing_failed` leave machine work there, with `payload.operatorHandoff` describing the action and
context. The super client lists it through `list_integrator_inbox` and resolves it through
`resolve_integrator_todo` or `resolve_integrator_fix_limit` (MCP, including the CLI proxy). With no super
client running, it waits; held cards remain held. Operator leave or AI being off does not send this work to
the owner (`integratorSideAvailable` checks only that an Operator exists). Only `owner_reserved` goes to
the owner, using the operation's existing question when available. The queue outcome records
`handoff.to` (`super` or `owner`; missing on old rows means owner). The web shows a short outcome, without
an owner inbox link for super work; no extra owner notification or badge is created.

A super operation runs one `SuperCommand` of a closed set (`operate`, `member_update`, `invite_create`, `merge`,
`merge_order`, `administration`, and the task, inbox, credential and workspace kinds). The integrator starts it with
the `super_operate` MCP tool or `POST …/operator-super/operations`, the in-app project manager with
`execute_operation` (`SuperHandoffService.operate`); one `(project, token, request id)` is one `SuperOperation`, so a
retry returns the same record and a different command under the same id is 409 `super_request_conflict`. The stored
handoffs of the retired base-Operator request (`super_handoffs`, PM-762) are no longer created or listed; their
`super_handoff_changed` timeline events still render, as plain text.

The server classifies the command itself (`superCommandEffects`, a projection onto the closed mutation list of
PM-759; what cannot be classified is refused). With no deletion, security or cost effect it runs on
the integrator's own power. With one, the operation waits (`waiting_owner`) and an owner question carries
`payload.superOperation = {operationId, commandHash, expectedConfigVersion, expiresAt}`; only the owner's own
login answers it (not the token, not a relay), within 24 hours. After a yes the integrator executes the same
request id again; the service verifies the config version, the command hash and that the same token is still
valid (stale: 409 `super_operation_stale`) and opens a grant for that one command only. A no cancels it
(`owner_declined`); an expiry cancels the operation. After a restart a running operation is
`unknown` and never started again by itself.

The relay (`POST …/inbox/:id/relay-answer`) lets the integrator give the owner's words as the answer to an open
question the asker marked as plain information (`ask_human` `response_purpose: "information"`). It is marked
`ownerAnswerRelayed`, is not an owner decision and never reaches the decision candidates. The rule lives in
`services/super-operator/relay.ts`; the REST route and the MCP tool `relay_owner_answer` (PM-760) both call it.

### In-app Operator on the shared path (PM-888, decision 55)

The in-app Operator uses the same path as a super-mode key: `execute_operation {request_key, task_key?, command}`
(not `operate` or `member_update`, which keep `operate`) and `get_operation` (PM-only application coordination).
They call `SuperOperations`, `SuperOperator.execute` and `SuperHandoffService.operate`, so the
rights check, audit and owner question for a K3 effect are shared with the key path.
The supervisor's machine grant, tools and API were removed in PM-1113; its table and rows stay.

- **Credential.** There is no stored key. `services/super-operator/app.ts` issues an `IntegratorPrincipal` with
  `source: 'app'`, `prefix: 'operator-app'` and `keyId` = the Operator session id, acting as the first owner (by
  handle) with a user account. The authority wrapped around the key authority accepts an app principal only when it
  was issued there (a `WeakSet`) and `OperatorAppSessions.active` holds: the session is live, it is the Operator's own
  general conversation (no guest) and an owner message or answer request is open. Otherwise `insufficient_access`.
- **Idempotence.** The request id of an operation is a UUID v8 from the first 16 bytes of
  `sha256(operatorRequestId:request_key)`, so a retry in the same request is the same operation.
- **Owner's yes.** The operation waits (`waiting_owner`) with the usual question. After the owner's own login says yes,
  the `inbox_resolved` event calls `SuperHandoffService.resumeApprovedAppOperation`, which re-runs `operate` under an
  approved app principal (no live session needed; the yes, command hash and config version are checked again).
- **Step log.** `OperatorAction` has `operation`; `operator_steps.operation_id` (migration 96) links the operation.

**Does this work on a remote engine?** The whole path runs on the hub; a machine operation reaches an engine through the
existing engine ports for application work. Machine administration uses the owner's integrator.

## The external MCP endpoint (PM-760, part of the super mode PM-757)

`POST /mcp` (no token in the path) is the integrator's MCP door: a bearer `pmi_` key, HTTPS or a local connection,
no login, no session and no engine. The member door `/mcp/:token` is separate and unchanged (a session token, a local
connection, `ToolContext` with a `sessionId`).

- **Stateless.** The SDK `WebStandardStreamableHTTPServerTransport` runs per request with no session id, over the SDK's
  low-level `Server` (`mcp/super-operator/server.ts`), so an unknown or forbidden tool is a domain denial and not an
  `isError` text. `GET` and `DELETE` are `405` with `Allow: POST`. The route (`mcp/super-operator/route.ts`) requires the
  `request.principal` the root auth hook resolved (`resolveIntegratorCredential(secret, 'mcp')`); a missing, wrong, expired,
  revoked or over-HTTP key is `401` (`integrator_key_invalid`, `integrator_https_required`), never the member door's `404`
  and never a `200` with an error text, also for a batch element and a notification. The key is re-read in each tool call
  (`assertActive`); a key found revoked in the middle of a request turns the whole answer into `401`. The `Authorization`
  and `Cookie` headers are removed before the request reaches the SDK (`requestInfo`) and nothing logs a body or a header.
- **Its own context.** `ExternalToolContext = {principal, projectKey, actor, requestId}` (`contracts/team-tools.ts`) has
  no `sessionId`; `ToolContext` is not changed. The shared tool definitions get a caller adapter: a definition is
  **denied by default** until it carries an explicit `external` binding (`mcp/kit.ts`: modes, read or write access, the
  project and card argument). `mcp/super-operator/registry.ts` lists the served tools (`EXTERNAL_TOOLS`) and the denied
  shared ones with the reason (`EXTERNAL_DENIED`); a test checks that every shared tool is exactly one of the two.
- **Project switching is stateless.** Every project tool takes a required `project_key`; `list_projects {}` returns the
  projects where the key's holder is an owner at this moment. An unknown project and one the holder does not own are
  refused alike (`insufficient_access`). `tools/list` is filtered by the key's mode (`super`, `read`); a forbidden
  tool called directly is refused by the same table (`integrator_not_allowed`, `integrator_read_only`).
- **Same right, same audit.** A call runs through `SuperOperator.execute` (`super` and `read` keys: the REST scope; `super`:
  the audit row `mcp_<tool>`). Legacy keys fail authentication with 401 (PM-1037). The super tools
  (`super_operate`, `get_super_operation`, `query_super_diagnostics`,
  `relay_owner_answer`) are `super` only and answer with structured
  JSON plus the domain `errorCode`.
- **Entrance.** The tunnel and proxy rules pass `/mcp` and refuse `/mcp/` and `/hooks` (`^/mcp/` in
  `scripts/cloud/cloudflare.ts` and `deploy/cloudflare/config.example.yml`); the root auth hook treats `/hooks/` and `/mcp/` as
  literal prefixes so no spelling opens the member door to a bearer. [DEPLOY.md](../DEPLOY.md) "The integrator's MCP endpoint".

**Does this work on a remote engine?** The endpoint, the key check and the audit run on the server and nothing of them
crosses to an engine: the tools call the same domain facades as the REST routes. A tool that needs an engine (the
operation reads and a diagnostics run) uses the engine path the matching REST route uses; the key is never sent
to an engine.

## Super-mode operations and diagnostics (PM-1113)

The connected integrator starts application commands through the shared operation path and
queries the closed project diagnostics catalogue. `services/super-operator/facade.ts`
exposes `SuperOperations`; machine actions stay with the owner's integrator.
The uninstalled supervisor and its RPC/read tools have been retired. Historical
`administration` commands remain parseable with an opaque request, but new command
schemas reject them and execution/continuation returns `administration_unavailable`.
