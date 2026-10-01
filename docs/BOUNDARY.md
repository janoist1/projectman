# External operation requests

PM-139 adds authorization records; it does not execute external operations, change CLI
permissions or activate a VM profile. Without an injected `BoundaryOperationAdapter`, operation
ids are refused. PM-140 supplies the first protected registry/executor (egress, below); PM-141 and
PM-142 use the same contract.

## Egress operations (PM-140)

The domain's `EgressService` is a registry the boundary service consults before the injected
adapter (`AppModules.boundaryAdapter` answers every id that is not `egr_...`). When the egress
proxy refuses a destination for a session, the service registers an operation once per session and
destination (`egress_operations`), bound to exactly that project, member, session and task; its
target is `read_external` of `egress:<host>:<port>` in `development`, so the category is
`delegable` and a lead may decide it. The session finds it with the team tool
`list_network_denials` and asks with `submit_boundary_request`. The operation's expiry (default 8
hours, `EGRESS_GRANT_HOURS`) bounds both the request and the allowance.

The proxy is the executor: on the first connection of that member, in that project, to that
destination, it consumes the allowed grant through `BoundaryService.consume` and records an
allowance (`egress_allowances`) in the same transaction. The allowance opens that host and port for
the member in the project, in any of its later sessions, until the expiry. Owners list allowances
with `routes.egressAllowances` and close one with `routes.revokeEgressAllowance`, which appends a
`boundary_changed` event (`revoked`, `owner_revoked`) and ends the tunnels the allowance opened
(domain event `egress_allowance_revoked`). A member on leave, removed, or with AI work
switched off is refused whatever it was allowed.

The additive shared contracts are `BoundaryTarget`, `BoundaryRequest`, `BoundaryGrant`,
`BoundaryRequestView`, `SubmitBoundaryRequest` and `DecideBoundaryRequest`. The adapter contract
is exported by `apps/server/src/contracts/index.ts`. Inject it as `AppModules.boundaryAdapter`
or `DomainOptions.boundaryAdapter`. Its synchronous `resolve(requester, operationId)` looks up
an opaque operation id in a protected registry and verifies the project/member/session/task
binding. It returns canonical, public metadata only. Never return credentials, command text,
request bodies, token-bearing URLs or a target asserted by the requesting process.

`boundaryCategory` derives the category from the adapter's operation, environment and branch
protection metadata. Cost; production, release or protected/default/main publication; new
accounts, tokens or secrets; and permanent host boundary expansion always require a human
with owner access. A caller cannot submit a category. The adapter must mark all protected
branches, including a repository's custom default branch, and use `publish_main` for main
publication. These records are authorization for the registered operation only; gates,
release labels and final decisions retain their existing human-only checks.

`boundary_authorization` is a fixed duty in the new `lead_developer` bundle. Existing bundles
and members are not migrated to it. The owner may assign it to a custom role or another
bundle, and enable `team.boundary.enabled`; absent settings keep delegation disabled.
Assignment/removal and settings changes are owner-only. `leadTimeoutSeconds` defaults to
120 (1–600). No lead, a lead on leave, or disabled AI work routes directly to owners; a busy
lead is notified through ordinary messaging/admission and has only the stored deadline.
Independent eligible leads are notified together. Owners also see and may decide their
requests. A lead cannot decide its own request; another eligible holder, else an owner, does.

`submit_boundary_request` takes only `operation_id` and `deduplication_key`, returns immediately
and binds identity from the MCP session. Retry with the same key to retrieve the same request;
another operation with that key is refused. Only the key's digest is persisted.
`get_boundary_request` retrieves its current state.
`decide_boundary_request` allows only independent live duty holders to decide a delegable request
still waiting for a lead. Human REST decisions use `routes.decideBoundary`, inspection uses
`routes.boundaryRequest`, revocation uses `routes.revokeBoundary`. Ordinary `inbox.resolve`
cannot decide boundary requests and remains human-only. Reasons are structured codes rather
than free text, so no credentials enter an explanation or audit record.

The same duty holders also decide a CLI's own permission question for a member whose approver is
`ai` (PM-169): that is a `permission` inbox item, not a boundary request, and has its own tool,
`decide_permission_request`, with a free-text reason (shown on the timeline and the inbox item), the
same lead deadline and the same owner exceptions as categories. See PROVIDERS.md.

Requests wait for a lead or an owner, then become allowed/denied/expired/revoked. The deadline
sweep runs at startup and once per second, and decision/read/consume revalidate immediately.
The absolute deadline never resets on retries or restart. Escalation never grants permission.
Configuration revision changes send pending requests to owners under the current revision and
revoke existing grants. Changed or missing adapter targets and removed/inactive requesters revoke
requests. Late/double decisions are refused. The server stores the request, grant, inbox projection
and attributed `boundary_changed` audit in one transaction (DB migration 12). Older inbox kinds
and timeline event types remain readable. The owner sees AI decisions and can revoke grants.
The original decision actor/reason and resolved inbox entry are preserved when an unused grant
expires or is revoked. `BoundaryRequest.invalidation` records that separate lifecycle change;
its attributed timeline event carries the invalidation reason. After consumption,
`BoundaryRequest.consumedAt` and the grant's consumed state are final: sweeps and revocation
cannot turn an operation already handed to the executor into a historical denial.
Each sweep isolates a failed project/request, logs only its identifiers and retries it on the next
tick. Other deadlines and server startup continue; failure never grants authorization.

Publishing a task branch (PM-142) is not a boundary operation: it is the managed VM's own gate
(`publish_task_branch`, [GITHUB.md](GITHUB.md#publishing-from-the-managed-vm-pm-142)), so a member
needs no request or grant for its own branch. Publishing the default branch (`publish_main`) is not
offered at all: the gate refuses it and the publishing identity could not do it anyway, so that
category stays the owner's own act with the owner's own identity.

The protected executor calls `domain.boundary.consume(requester, requestId, operationId)` before
execution. It checks the current policy/target and all identity fields and atomically consumes
the single-operation grant. A consumed, expired or revoked grant cannot be reused. The executor
must perform exactly that registered operation with the returned target, including its exact
resource and scope; it must not reinterpret the grant as a general shell or network permission.
An execution failure requires a new operation/request; consumption is deliberately fail-closed.
The domain cannot undo an operation already executed or stop one already handed to an executor.
