# projectman and GitHub

Tasks live in projectman's own database. GitHub is used for what it does best: pull
requests, reviews, checks, merges and releases (decision 9 in [DECISIONS.md](DECISIONS.md)).
In v1 projectman only **reads** from GitHub; it never changes anything there.

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

`<fields>` = `number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,additions,deletions,changedFiles,updatedAt,mergedAt`.

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
title, state }` (built by `pullRequestLink`). The `pr_merged` gate is checked against the
  link's state.

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
- Only `gh auth status`, `gh pr view` and `gh pr list` are run: nothing on GitHub changes.
- `gh` runs non-interactively (`GH_PROMPT_DISABLED`), without update checks, and always
  prints plain JSON (colors and forced terminals are switched off).
- Automated tests use a fake `gh` (`apps/server/src/github/test-fixtures/fake-gh.mjs`) and
  never contact GitHub.

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
  members (handles, sponsors, capacities), pipeline stages with gates (`check_passed`,
  `pr_merged`, `human_approval`), per-task checks, internal/shared visibility, and later
  meetings and observations.
- **Clients would need GitHub accounts** and access to the repository or project just to
  take part in the client test stage.
- **No webhooks on a local app.** A two-way sync would rely on polling. It would be slow,
  it would conflict whenever both sides change, and it would spend the owner's rate limit.
  One source of truth avoids all of that.
- **Independence.** The board, the inbox and the attributed timeline keep working when
  GitHub is slow, rate-limited or offline, and tasks can exist without any repository.

GitHub stays the source of truth for code: pull request state, reviews, checks and merges.
projectman reads them and mirrors them into task links.
