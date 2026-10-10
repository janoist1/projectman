# projectman and GitHub

Tasks live in projectman's own database. GitHub is used for what it does best: pull
requests, reviews, checks, merges and releases (decision 9 in [DECISIONS.md](DECISIONS.md)).
projectman **reads** GitHub pull requests with the owner's login. A member's merge_task (PM-452) pushes the
approved merge commit to the default branch through the engine's git login, never through the publisher.
The publishing gate's separate identity still cannot write the default branch. Its writing path is
the managed VM's publishing gate
([Publishing from the managed VM](#publishing-from-the-managed-vm-pm-142)); everywhere else agents do
not push (decision 21).

```
projectman server ── execFile (no shell) ──▶ gh CLI ──▶ GitHub API
   src/github            owner's `gh auth login`         (read-only calls)
      │
      └─ watch(): polls the PRs linked to tasks ─▶ domain updates task links and gates
```

## Setup

- Install the GitHub CLI (2.40 or newer) and log in once: `gh auth login`. The token needs
  the `repo` scope to read private repositories.
- projectman never sees or stores the token; every call runs `gh` with the owner's login.
- In the project configuration, give each repo its GitHub name: `repos[].github: owner/name`.
- `isAvailable()` tells the UI whether GitHub is connected (gh installed and logged in).

## What is read

| Purpose                   | Command                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Is GitHub usable?         | `gh auth status --active --hostname=github.com` (exit code only)                        |
| One pull request          | `gh pr view <n> --repo=<owner/name> --json=<fields>`                                    |
| Pull requests of a branch | `gh pr list --repo=<owner/name> --head=<branch> --state=all --limit=30 --json=<fields>` |

`<fields>` = `author,number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,statusCheckRollup,reviewDecision,additions,deletions,changedFiles,updatedAt,mergedAt`.

The JSON is validated (zod) and mapped to `PullRequestInfo`
(`apps/server/src/contracts/github.ts`):

- **state**: `open`, `closed` or `merged`.
- **checks**: the checks of the PR's head commit rolled up into one value. GitHub Actions
  check runs and classic commit statuses are both understood. Any failing check (failure,
  error, cancelled, timed out, action required, startup failure) gives `failure`. Otherwise,
  any unfinished check (queued, in progress, waiting, expected, stale) gives `pending`.
  Otherwise the result is `success` (neutral and skipped count as passed). No checks at all
  gives `none`. If a check ran more than once (re-runs), only its latest run counts.
- **reviewDecision**: `approved`, `changes_requested`, `review_required`, or `null` when
  the base branch does not require reviews (GitHub then reports no decision at all).

## How pull requests find their task

- An AI member links a PR with the `link_pull_request` team tool (repo + number). A PR URL
  can be turned into repo + number with `parsePullRequestUrl`.
- Task branches are named after the task key: `AR-21-short-name`. `taskKeyFromBranch`
  reads the key back (also after a prefix such as `feature/`). Give it the project key
  whenever you have it, so look-alikes such as `UTF-8-fix` are ignored. Legacy ClickUp
  branches (`CU-869f4byk9-name`) give no key. `findPullRequestsForBranch` lists the PRs of
  a branch.
- A linked PR is stored as a task link: `{ kind: 'pull_request', ref: '<number>', repo,
title, state }` (built by `pullRequestLink`). When the PR merges, the system label
  `pr-merged` goes on the task, and a gate may require it.
- The link also remembers the PR's head commit (`headRefOid`, database only). When the head
  moves (new commits, a force push or a base update), the labels with
  `clearedWhen: pr_updated` come off the open tasks linking the PR, for example a code
  review or a merge approval of the previous code. The first head seen for a link (a new
  link, or the first poll after this was introduced) changes nothing.

## Repositories without GitHub

A repo configured without `github` is **local-only**: the owner has not allowed anything to go to
GitHub. The server denies `git push`, `gh pr create` and `gh pr merge` there (`deniedToolsFor` and
`commandVerdict` in `apps/server/src/domain/session-policy.ts`), and the context pack words the
steps without a pull request (PM-67, `apps/server/src/context/work-item.ts`). Repos on GitHub keep
the pull request wording, and so do tasks that work in no repo. The repo of a task is its own, else
the project's only repo, so a task without a repo in a one-repo project follows that repo (PM-68);
in a project with several repos such a task has no repo until a person chooses one.

- The developer, and every duty that changes files, commits on the task's own branch in its
  worktree, makes sure everything is committed, and names the branch and its last commit in the
  hand-over message. Fixes after a review are new commits on the same branch; the request for a
  re-review names them. The duty fragments of implementation and documentation say the same.
- The reviewer reviews the branch against the repo's `defaultBranch`, not a pull request, with
  commands the server allows without asking: `git branch --list '<TASKKEY>-*'` (the worktree
  manager names the branch `<TASKKEY>-<slug of the title>`), `git log <base>..<branch>` and
  `git diff <base>...<branch>`. Every worktree shares one git repository, so this works from the
  reviewer's own directory (the workspace root; a repo in a folder of it is entered with `cd`).
  The reviewer never edits or commits the reviewed work, or merges or pushes manually. When selected
  as the card merger, they use merge_task after approving the commit.
- Where requireMerge applies, the selected member uses merge_task before the merge target; the gate
  checks that the approved commit is in the default branch. Integrating-session repositories
  (fullTestAtMerge) retain the owner's integration workflow. A deployment step names the branch only.

## Polling

A local app cannot receive GitHub webhooks, so `watch(targets, onChange)` polls:

- Every watched PR is fetched every `pollIntervalMs`. One `gh` call runs at a time, and
  polling rounds never overlap. A PR watched by several subscribers is fetched once.
- Each subscriber gets a PR's state as soon as it is known, then **only when it changes**.
  `updatedAt` alone does not count: it moves with every comment. Pushes, check results,
  reviews, merges, title and draft changes do count.
- A merged PR cannot change state any more, so it is re-checked only every `maxBackoffMs`.
- Errors of one PR (not found, timeout, GitHub server error, unexpected output) back off
  only that PR: 2×, 4×, 8× … the interval, capped at `maxBackoffMs` (default 10 minutes).
- Rate limiting, no network, or gh missing or logged out pause **all** polling with the
  same exponential backoff. After rate limiting the pause is at least one minute. The first
  successful call resumes normal polling for every PR.
- The function returned by `watch` unsubscribes. When nobody is watching any more, the
  running `gh` call is cancelled.
- `watch` does not report errors to subscribers. Failures are logged (warn) with the PR,
  the error code and the next retry time.

**Cost**: each check is one GraphQL request on the owner's account. The owner's own `gh`
use shares the same limit of 5,000 points per hour. For example, 20 open PRs checked every
60 seconds make 1,200 requests per hour. Keep `pollIntervalMs` at 60 seconds or more, and
stop watching PRs of finished tasks.

## Errors

Every failure is a `GithubError` (exported from `apps/server/src/github`) with a `code`:
`invalid_argument`, `not_installed`, `not_authenticated`, `rate_limited`, `not_found`,
`timeout`, `unreachable`, `server_error`, `invalid_response`, `aborted` or `failed`.
Callers can turn `not_found` into a friendly "no such PR" message; the others mean
"GitHub is not usable right now".

## Safety

- `gh` is started with `execFile` (no shell). Repo names, PR numbers and branch names are
  validated first and passed as `--flag=value`, so no value can act as another flag.
- The reading service runs only `gh auth status`, `gh pr view` and `gh pr list`: nothing on GitHub
  changes through it, and it never holds the publishing token (a second object with its own
  home, environment and token).
- `gh` runs non-interactively (`GH_PROMPT_DISABLED`), without update checks, and always
  prints plain JSON (colors and forced terminals are switched off).
- Automated tests use a fake `gh` (`apps/server/src/github/test-fixtures/fake-gh.mjs`) and
  never contact GitHub.

## Publishing from the managed VM (PM-142)

Decision 26 lets members in the managed VM profile publish their own task branches and open pull
requests, without a question, through a restricted gate and a **separate GitHub identity**. Never
`main`, never another member's branch, never a merge. Two halves hold this, and neither relies on
the other: the **gate** in projectman (what a member can ask for) and the **remote protection**
(what the identity can do even if the gate were wrong).

```
worker session ──▶ team tool publish_task_branch(commit) ──▶ PublishingGate (domain/publishing.ts)
                    (MCP, authenticated session)               │ member, task, repo, branch from the server's records
                                                               ▼
                                         GithubPublisher (src/github/publisher.ts, token in this process only)
                                           1. fetch the branch from the member's workspace into a server-owned bare repo
                                           2. check the tip is the named commit
                                           3. git push <commit>:refs/heads/<branch>   (never forced, never main)
                                           4. gh pr list/create: one open pull request per branch
                                                               ▼
                                         task link: pull request, author = the publishing member (durable)
```

### What the gate checks (all from the server's own records)

| Binding     | Where it comes from                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| member      | the authenticated MCP session; it must be an AI member whose session ran in the `managed_vm` profile                                                                                                                                                  |
| task        | the task of that session; naming another is refused                                                                                                                                                                                                   |
| repository  | the task's own repo, else the project's only one; it must have `github` (local-only and repository-less tasks cannot publish)                                                                                                                         |
| branch      | the member's own `work` binding of the task in its workspace; `main`, the repo's default branch and other protected names, another task's branch and any name that is not a plain branch name are refused (`checkPublishTarget` in `packages/shared`) |
| commit      | named by the member, a full 40-character id; the publisher refuses it unless it is the branch tip                                                                                                                                                     |
| refspec     | built by the publisher: `<commit>:refs/heads/<branch>`; never a `+`, a delete, a tag, `--all` or `--mirror`                                                                                                                                           |
| credentials | the publisher's; the member never sees or names one                                                                                                                                                                                                   |

A raw `git`, `gh` or any HTTP client in a session gets nothing wider than that: **the token is never
in a session**. It lives in a file only the service reads (`PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE`,
refused unless group and others cannot read it), reaches `git` as an `http.<host>.extraheader` in one
process's environment and `gh` as `GH_TOKEN`, and passes through a redaction before anything is logged
or returned. The git and gh started for publishing get a minimal environment of their own (own `HOME`,
no `GITHUB_TOKEN`, none of the owner's `gh` login or git configuration). The publisher never runs
`git` inside the member's repository: it fetches the branch into its own bare repository
(`PROJECTMAN_HOME/github-publish/staging`) and pushes from there, so hooks, config includes, `pushurl`
and credential helpers of a worker's clone never run. It refuses a workspace that borrows objects
(`alternates`) or is a linked worktree. Behind the VM boundary (PM-140) the service does not even read
the worker's repository: the member's worker bundles the task branch into its own spool, the service
copies that file (no link, no FIFO, the worker's own) into `PROJECTMAN_HOME/spool` and fetches from the
copy, which is removed afterwards. The poller (`GithubService`) is another object with the
owner's read login and holds no write right.

Repeated calls are idempotent: the same commit uploads nothing and returns the same pull request; a
later commit fast-forwards the branch and shows in the same pull request; an open pull request of the
branch is reused, and a "already exists" answer is read back. A branch that moved on the remote is a
refusal (`not_fast_forward`), never a force.

### Provenance: who authored the pull request

The shared bot login says nothing about which AI member wrote the change, and the poller used to pick
the first member whose `githubLogin` matched. A pull request opened by the gate gets its author from
the authenticated session: the task link records `author` (a member handle) and `author_source =
'published'` (database migration 15, not part of the shared `TaskLink` shape). Polling and a later
`link_pull_request` never replace it, and it stays when the task is reassigned, so the no-self-review
rule (`taskAuthors`) keeps holding for the publisher. A pull request that was not published here
(opened by a person, or linked with `link_pull_request`) is attributed by `githubLogin` as before. The
first publication of a link wins: a teammate who later takes the branch over and publishes to the same
pull request does not take the authorship away (they are the assignee by then).

### Remote state for the integrator and the review step

`get_remote_state(task_key)` returns the remote default branch's head, the task branch's head, how far
apart they are, the branch's pull requests and who published them. The server reads it, so the
integrator and the reviewers need no credential and no network access to GitHub.

### One-time setup by the owner

This is a human step, and the token is never created, copied or stored by an agent. Nothing here
copies the owner's `gh auth login` into the VM.

1. **The identity.** A separate GitHub identity, never the owner's: a GitHub App installed on the one
   repository (best: per-repository permissions, its own rate limit), or a machine user with a
   fine-grained personal access token for that repository alone. Permissions: Contents read and
   write, Pull requests read and write, Metadata read. **Not**: Administration, Workflows, Actions,
   Secrets, Environments, Deployments. Without the Workflows permission the identity cannot push a
   change to `.github/workflows`, so a published branch cannot carry a workflow that runs with the
   repository's secrets. The identity must not be an owner or admin of the repository and must not
   appear in any bypass list. (An App installation token lasts an hour; refresh the token file from
   outside, since the publisher reads it at every call.)
2. **The protection** ([`deploy/github/default-branch-ruleset.json`](../deploy/github/default-branch-ruleset.json),
   [`tag-ruleset.json`](../deploy/github/tag-ruleset.json), import under Settings → Rules → Rulesets):
   the default branch cannot be updated, force pushed or deleted except through a pull request with a
   review, and tags cannot be created, moved or deleted, **for everybody but the owner's own
   identity**, which is the only bypass actor (the integrating session pushes `main` after each
   verified merge, decision 21). No other bypass.
3. **Deployments.** Anything that deploys or releases sits in a GitHub Environment with required
   reviewers (the owner) and its deployment branches limited to the default branch; no
   repository-level secret reaches a branch workflow. A release or tag path cannot start without the
   owner's approval, whatever a published branch contains.
4. **The token file.** On the VM, as root, a file the service alone can read, for example
   `/etc/projectman/github-publish.token` (owner `projectman`, mode `0600`), and
   `PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE=/etc/projectman/github-publish.token` in the service's
   environment next to the managed VM profile. The server refuses it on any other profile.
5. **Check that the plan enforces it.** Rulesets and branch protection on a private repository need a
   paid plan; whether a given account and repository enforce them is only known by trying. Run the
   trial below on a **throwaway repository** first, and again on the real one before enabling
   publishing there. A rule that GitHub accepts but does not enforce fails the trial.

### The trial on a throwaway repository

`deploy/github/trial.sh` is run by the owner, with the VM identity's token, against a repository that
exists only for the trial (never the real `main`). It expects: a push to the default branch, a
force push, a deletion, a tag push and a merge through `gh pr merge` and through the API all
**refused**; a push of an own branch and the opening of its pull request **succeed**. It prints what it
did and deletes its own branch afterwards.

```sh
GH_TOKEN="$(sudo cat /etc/projectman/github-publish.token)" \
  bash deploy/github/trial.sh --repo <owner>/<throwaway> --confirm-throwaway <owner>/<throwaway>
```

Status: the script and the rulesets are written and reviewed but have **not** been run against GitHub
(no throwaway repository or identity exists yet). The automated tests cover the gate and the
publisher with the fake `gh` and a temporary git remote that refuses the default branch the way the
protection does (`apps/server/src/github/publisher.test.ts`, `apps/server/test/github-publishing.test.ts`);
they cannot prove that a real GitHub plan enforces the protection.

### What is not covered

- A member in the managed VM can still use the network as the gate (PM-140) allows; the publishing
  token is not reachable from there, but a session that reaches GitHub anonymously reads public data
  only.
- The check that a workspace has no borrowed objects is a guard, not a proof: a hostile worker owns
  its clone. The only things that leave are the objects of the named task branch, and the published
  branch is reviewed before it is merged like any other.
- The first publisher stays the pull request's author; a pull request several members commit to is
  recorded as the first publisher's, plus the task's assignee, for no-self-review.

## Recommended next steps

1. **Branch protection (or rulesets) on `main`.** Require a pull request, at least one
   approving review, the CI status checks, and optionally code owners. Dismiss approvals
   when new commits are pushed. GitHub then enforces what our gates expect, and
   `reviewDecision` starts reporting `review_required` / `approved` (without protection it
   stays empty).
2. **Environments with required reviewers as the release gate.** Deployment jobs that
   target a `production` environment wait until a named reviewer approves in GitHub. Use
   the same people as the release stage's `human_approval` approvers. Later, projectman can
   read waiting deployments and show them in the inbox ("Rád vár"); the approval itself
   stays in GitHub.
3. **Create a GitHub issue from a task** (one way, on request). This is useful when outside
   contributors work from issues. The task stays the source of truth; the issue is stored
   as a task link of kind `issue`, and PRs can close it with `Closes #n`. This is the first
   write access, so it needs an explicit decision by the owner.
4. **Optional one-way mirror of the board into a GitHub Project** for people who live in
   GitHub. projectman writes items and a stage/status field; nothing is ever read back as
   truth. It needs the `project` token scope (`gh auth refresh -s project`).
5. **Webhooks or a GitHub App once the server leaves the laptop.** `pull_request`,
   `pull_request_review` and `check_suite` events replace polling (instant, no rate-limit
   pressure). A GitHub App also gives per-repo permissions, a bot identity and its own rate
   limit instead of the owner's personal login. Keep polling as a fallback.

## Why tasks stay in our database

- **The model does not fit GitHub Projects.** projectman has a mixed team of humans and AI
  members (handles, sponsors, capacities), pipeline stages with label gates, meaningful
  labels with rules, internal/shared visibility, and later meetings and observations.
- **Clients would need GitHub accounts** and access to the repository or project just to
  take part in the client test stage.
- **No webhooks on a local app.** A two-way sync would rely on polling. It would be slow,
  it would conflict whenever both sides change, and it would spend the owner's rate limit.
  One source of truth avoids all of that.
- **Independence.** The board, the inbox and the attributed timeline keep working when
  GitHub is slow, rate-limited or offline, and tasks can exist without any repository.

GitHub stays the source of truth for code: pull request state, reviews, checks and merges.
projectman reads them and mirrors them into task links.
