# Roles as bundles of duties

Status: built (decision 16). Approval gates became labels afterwards (decision 17): where
this note once said "approval gates name a duty", an approval is now a label that only humans
holding a duty may set (`setBy: { humans: true, duties: [...] }`).

The fixed catalogue contains 26 duties. Testing and acceptance form one quality duty;
standup, refinement and retro facilitation are separate so teams can delegate each ritual.
Release approval and final decision are human-only. All other duties admit humans and AI,
including monitoring (the watchdog is no longer artificially AI-only).

Roles are named bundles of duty ids plus prompt-only instructions. Built-in defaults live
in shared code; `team.roleOverrides` replaces a built-in bundle (removing the entry resets
it). Custom roles add `duties` alongside existing instructions. Human members union their
roles; AI members still hold one. Holder eligibility is the intersection of duty eligibility.
Legacy custom roles without duties retain their declared `holders` eligibility and
resolve to an empty duty bundle. They receive no approval or other code-backed duties.
Explicit duties determine eligibility for newer roles.

Stages may name a duty. An explicit owners array, including an empty array, overrides the
resolved holders. Labels name who may set them (`setBy`), by duty or by member; an approval
label is one only humans may set, and only human holders qualify. Template stages and labels
use duties. Gate and stage dependencies without holders are errors; missing recommended retro
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

The settings matrix groups duties by direction, delivery, quality, release, communication
and team. Columns show roles in use and custom roles, their holders and prompt-only extras.
Missing coverage is red, incompatible cells show why they are disabled, and a read-only
people view shows the union of each person's duties. Config PATCH accepts `roleOverrides`,
`roles` and `releaseFourEyes` atomically, with the usual version conflict check; custom role
creation goes through the roles API, whose catalogue adds resolved `duties` and
`instructions`. Server and the web's test fake use the shared resolution and validation
helpers.

## Compatibility

The config schema version remains 1. Old explicit stage owners load unchanged. Old custom
roles without duties resolve in memory to an empty duty bundle and keep their declared
`holders` eligibility; explicit duties determine eligibility for newer roles. Existing member
instructions remain prompt-only text; new hires do not copy role prompts.

PR links persist their member authors in SQLite, so reassigning a task cannot enable
self-review. A link without explicit attribution defaults to the assignee when it is
attached. GitHub authors are matched case-insensitively to members with an optional
`githubLogin` in `team.yaml`; the matched handle is persisted. Other external authors keep
the explicit attribution or the assignee fallback.

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
