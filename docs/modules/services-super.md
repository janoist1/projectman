# services/super

## Responsibility

The typed operations a connected Claude (with an integrator key) or the project manager (in its app session) starts,
the owner's question for a reserved effect, the external MCP endpoint (`mcp/super`), and the closed project
diagnostics catalogue. The code names (`super`, `integrator`, `operator-super`) are explained in
`docs/ARCHITECTURE.md`, "Code names".

## Owner-bound super operations

The connected Claude's work waits in the existing integrator inbox (todos and fix limit decisions; see
[core/inbox](core-inbox.md)). A connected Claude lists it through `list_integrator_inbox` and resolves it through
`resolve_integrator_todo` or `resolve_integrator_fix_limit` (MCP, including the CLI proxy). With no connected Claude
running, it waits; held cards remain held. `getIntegratorInboxStatus` (`get_integrator_inbox_status`, PM-1466) answers
only whether that queue has an open item, with the same super access check and the same selection
(`InboxService.integratorQueue`, which cuts its limit after selecting the integrator's items, so newer items for
others never hide an older one). The owner's own client calls it first on a scheduled check and lists only on
`true` (`INSTALL.md` 5.5); the schedule lives in that client, the hub runs nothing for it. Whether the work stays on the integrator side is decided by
`integratorSideAvailable` (`packages/shared/src/domain/member-queue.ts`): it holds while some owner has a live super
key, and without one the items go to the owners. No server code writes `payload.operatorHandoff` or a queue outcome
`handoff` (`reason`, `to`) any more: they are read only, so that old items and rows keep rendering (a missing `to`
means owner), and the web shows a short outcome, without an owner inbox link for super work.

A super operation runs one `SuperCommand` of a closed set (`operate`, `member_update`, `invite_create`, `merge`,
`merge_order`, and the task, inbox, credential and workspace kinds). A connected Claude starts it with the
`super_operate` MCP tool or `POST …/operator-super/operations`, the project manager in its app session with
`execute_operation` (`SuperHandoffService.operate`); one `(project, token, request id)` is one `SuperOperation`, so a
retry returns the same record and a different command under the same id is 409 `super_request_conflict`. The stored
`super_handoffs` rows are no longer created or listed; their `super_handoff_changed` timeline events still render, as
plain text. A command of the old `administration` kind stays parseable with an opaque request, but new command schemas
reject it and execution or continuation answers `administration_unavailable`.

The server classifies the command itself (`superCommandEffects`, a projection onto the closed mutation list; what
cannot be classified is refused). With no deletion, security or cost effect it runs on the caller's own power. With one,
the operation waits (`waiting_owner`) and an owner question carries
`payload.superOperation = {operationId, commandHash, expectedConfigVersion, expiresAt}`; only the owner's own login
answers it (not the token, not a relay), within 24 hours. After a yes the caller executes the same request id again; the
service verifies the config version, the command hash and that the same token is still valid (stale: 409
`super_operation_stale`) and opens a grant for that one command only. A no cancels it (`owner_declined`); an expiry
cancels the operation. After a restart a running operation is `unknown` and never started again by itself.

The relay (`POST …/inbox/:id/relay-answer`) lets the connected Claude give the owner's words as the answer to an open
question the asker marked as plain information (`ask_human` `response_purpose: "information"`). It is marked
`ownerAnswerRelayed`, is not an owner decision and never reaches the decision candidates. The rule lives in
`services/super/relay.ts`; the REST route and the MCP tool `relay_owner_answer` both call it.

### The project manager's session on the shared path

The project manager uses the same path as a super key: `execute_operation {request_key, task_key?, command}` and
`get_operation` (see [services/coordination](services-coordination.md)). They call `SuperOperations`,
`SuperExecution.execute` and `SuperHandoffService.operate`, so the rights check, the audit and the owner question for a
K3 effect are shared with the key path. The old supervisor's machine grant, tools and API are gone; its table and rows
stay.

- **Credential.** There is no stored key. `services/super/app.ts` issues an `IntegratorPrincipal` with
  `source: 'app'`, `prefix: 'operator-app'` and `keyId` = the project manager's session id, acting as the first owner
  (by handle) with a user account. The authority wrapped around the key authority accepts an app principal only when it
  was issued there (a `WeakSet`) and `ProjectManagerAppSessions.active` holds: the session is live, it is the project
  manager's own general conversation (no guest) and the facade's `actingRequest` yields a request: an owner message,
  answer or queue request, or a signal round (the session's own round under `outside_owner_only`, PM-1287; under
  `owner_request` only the owner's message or answer). Otherwise `insufficient_access`. The request origin is `owner`
  only on the owner's own message or answer.
- **Idempotence.** The request id of an operation is a UUID v8 from the first 16 bytes of
  `sha256(operatorRequestId:request_key)`, so a retry in the same request is the same operation.
- **Owner's yes.** The operation waits (`waiting_owner`) with the usual question. After the owner's own login says yes,
  the `inbox_resolved` event calls `SuperHandoffService.resumeApprovedAppOperation`, which re-runs `operate` under an
  approved app principal (no live session needed; the yes, command hash and config version are checked again).
- **Step log.** `ProjectManagerAction` has `operation`; `operator_steps.operation_id` links the operation.

## The external MCP endpoint

`POST /mcp` (no token in the path) is the connected Claude's MCP door: a bearer `pmi_` key, HTTPS or a local
connection, no login, no session and no engine. The member door `/mcp/:token` is separate (a session token, a local
connection, `ToolContext` with a `sessionId`).

- **Stateless.** The SDK `WebStandardStreamableHTTPServerTransport` runs per request with no session id, over the SDK's
  low-level `Server` (`mcp/super/server.ts`), so an unknown or forbidden tool is a domain denial and not an
  `isError` text. `GET` and `DELETE` are `405` with `Allow: POST`. The route (`mcp/super/route.ts`) requires the
  `request.principal` the root auth hook resolved (`resolveIntegratorCredential(secret, 'mcp')`); a missing, wrong, expired,
  revoked or over-HTTP key is `401` (`integrator_key_invalid`, `integrator_https_required`), never the member door's `404`
  and never a `200` with an error text, also for a batch element and a notification. The key is re-read in each tool call
  (`assertActive`); a key found revoked in the middle of a request turns the whole answer into `401`. The `Authorization`
  and `Cookie` headers are removed before the request reaches the SDK (`requestInfo`) and nothing logs a body or a header.
- **Its own context.** `ExternalToolContext = {principal, projectKey, actor, requestId}` (`contracts/team-tools.ts`) has
  no `sessionId`; `ToolContext` is separate. The shared tool definitions get a caller adapter: a definition is
  **denied by default** until it carries an explicit `external` binding (`mcp/kit.ts`: modes, read or write access, the
  project and card argument). `mcp/super/registry.ts` lists the served tools (`EXTERNAL_TOOLS`) and the denied
  shared ones with the reason (`EXTERNAL_DENIED`); a test checks that every shared tool is exactly one of the two.
- **Project switching is stateless.** Every project tool takes a required `project_key`; `list_projects {}` returns the
  projects where the key's holder is an owner at this moment. An unknown project and one the holder does not own are
  refused alike (`insufficient_access`). `tools/list` is filtered by the key's mode (`super`, `read`); a forbidden
  tool called directly is refused by the same table (`integrator_not_allowed`, `integrator_read_only`).
- **Same right, same audit.** A call runs through `SuperExecution.execute` (`super` and `read` keys: the REST scope; `super`:
  the audit row `mcp_<tool>`). Keys of the retired legacy mode fail authentication with 401. The super tools
  (`super_operate`, `get_super_operation`, `query_super_diagnostics`, `relay_owner_answer`) are `super` only and answer
  with structured JSON plus the domain `errorCode`.
- **Entrance.** The Cloudflare tunnel is still on the path of `/mcp`. `scripts/cloud/cloudflare.ts` (`ingressRules`) and
  `deploy/cloudflare/config.example.yml` pass the bare `/mcp` (on the integrator host, behind Cloudflare Access with the
  integrator audience) and answer `404` for `/mcp/` and `/hooks` on the board host. The root auth hook treats `/hooks/`
  and `/mcp/` as literal prefixes so no spelling opens the member door to a bearer. [DEPLOY.md](../DEPLOY.md) describes
  the endpoint and its host.

## Operations and diagnostics

A connected Claude starts application commands through the shared operation path and queries the closed project
diagnostics catalogue. `services/super/facade.ts` exposes `SuperOperations`; machine actions stay with the
connected Claude on the owner's machine.

Machine-dependent parts: see the [machine-dependent inventory](../MACHINE-DEPENDENT.md).
