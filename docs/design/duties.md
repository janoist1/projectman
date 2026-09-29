# Roles as bundles of duties

The fixed catalogue contains 26 duties. Testing and acceptance form one quality duty;
standup, refinement and retro facilitation are separate so teams can delegate each ritual.
Release approval and final decision are human-only. All other duties admit humans and AI,
including monitoring (the watchdog is no longer artificially AI-only).

Roles are named bundles of duty ids plus prompt-only instructions. Built-in defaults live
in shared code; `team.roleOverrides` replaces a built-in bundle (removing the entry resets
it). Custom roles add `duties` alongside existing instructions. Human members union their
roles; AI members still hold one. Holder eligibility is the intersection of duty eligibility.
The legacy `holders` field is accepted for YAML compatibility but is not a policy knob.
Legacy custom roles without duties migrate to research, or final decision for human roles.

Stages may name a duty. An explicit owners array, including an empty array, overrides the
resolved holders. Approval gates may name a duty instead of explicit approvers; only human
holders qualify. Explicit old owners and approvers remain unchanged. Template stages use
duties. Gate and stage dependencies without holders are errors; missing recommended retro
facilitation is a warning. Issues add severity without changing their existing codes.

Release approval membership, bundles containing it, effective release approvers, and the
optional `team.releaseFourEyes` setting are protected by owner-only configuration checks.
AI cannot approve. Code/security/QA results reject the assignee and linked PR authors;
release four eyes excludes them from approval too. PR links retain attributed member authors
independently of GitHub logins; unattributed links default to the task assignee at attachment. External authors require explicit member attribution; GitHub login alone is not a team member identity.

Duty fragments precede role free text and member instructions. File-editing duties require
a task worktree; read-only duties grant read tools. Mixed roles union these policies, while
self-review remains forbidden. Ritual and event attachment metadata describe future hooks;
this change does not implement meeting orchestration or monitoring execution.

The settings matrix groups duties and shows role holders, missing coverage and incompatible
cells, with a read-only people view. Existing config PATCH handles atomic bundle edits and
reset; custom role creation continues through the roles API. Server and mock use shared
resolution and validation helpers.

## Default bundles

| Role              | Duties                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| operator          | final decision, release approval, monitoring                                  |
| product owner     | prioritization, requirements analysis, testing and acceptance, final decision |
| project manager   | scheduling, triage, standup facilitation, refinement facilitation             |
| business analyst  | requirements analysis, task breakdown                                         |
| architect         | technical direction, task breakdown                                           |
| designer          | UX design                                                                     |
| developer         | implementation                                                                |
| code reviewer     | code review                                                                   |
| security reviewer | security review                                                               |
| QA                | testing and acceptance                                                        |
| DevOps            | deployment, monitoring                                                        |
| communication     | client communication                                                          |
| support           | support, triage                                                               |
| researcher        | research                                                                      |
| maintainer        | maintenance                                                                   |
| coach             | retro facilitation, process improvement                                       |
| watchdog          | monitoring                                                                    |
| content           | content                                                                       |
| translator        | translation                                                                   |
| docs              | documentation                                                                 |

Deployment is a read-only source policy: deployment commands still require the normal
permission decision. It does not grant application-file editing. Mixed read/edit bundles
union both policies. Empty bundles admit both holder kinds and supply no duty fragment.
The recommended retro duty is nonblocking, including for old and intentionally small teams.
