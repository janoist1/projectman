#!/usr/bin/env bash
# Trial of the publishing identity's limits on a THROWAWAY GitHub repository (PM-142, docs/GITHUB.md).
#
# Run by the owner, with the VM identity's token in GH_TOKEN, against a repository that exists only
# for this trial: it tries to write the default branch, force push, delete it, push a tag, push a
# workflow file and merge a pull request (all must be refused), and pushes an own branch and opens its
# pull request (both must succeed). It cleans up its own branch and pull request.
#
#   GH_TOKEN=<the VM identity's token> bash deploy/github/trial.sh \
#     --repo <owner>/<throwaway> --confirm-throwaway <owner>/<throwaway>
#
# Never point it at the real repository: the "refused" attempts are real attempts, and a rule that
# GitHub accepts but does not enforce lets them through.
set -uo pipefail

repo=""
confirm=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --confirm-throwaway) confirm="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$repo" ] || [ "$repo" != "$confirm" ]; then
  echo "usage: GH_TOKEN=... bash trial.sh --repo owner/name --confirm-throwaway owner/name" >&2
  echo "(name the repository twice: it must be one that exists only for this trial)" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN (the VM identity's token) is not set" >&2
  exit 2
fi
unset GITHUB_TOKEN

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" GH_CONFIG_DIR="$work/gh" GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME" "$GH_CONFIG_DIR"
# The token reaches git through the environment, scoped to github.com; it is never on a command line.
basic="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
export GIT_CONFIG_VALUE_0="Authorization: Basic $basic"
export GIT_CONFIG_KEY_1="credential.helper"
export GIT_CONFIG_VALUE_1=""

failures=0
pass() { echo "ok      $1"; }
fail() { echo "FAILED  $1" >&2; failures=$((failures + 1)); }
expect_ok() { local name="$1"; shift; if "$@" >"$work/out" 2>&1; then pass "$name"; else fail "$name (it should have worked)"; sed 's/^/        /' "$work/out" >&2; fi; }
expect_refused() { local name="$1"; shift; if "$@" >"$work/out" 2>&1; then fail "$name (it WAS ACCEPTED: the protection does not hold)"; else pass "$name (refused)"; fi; }

default_branch="$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)"
if [ -z "$default_branch" ]; then
  echo "cannot read $repo with this token (is the repository named right, and the token's access set?)" >&2
  exit 2
fi
echo "Trial on $repo (default branch: $default_branch)"

git clone --quiet "https://github.com/$repo.git" "$work/repo" || { echo "clone failed" >&2; exit 2; }
cd "$work/repo" || exit 2
git config user.name "projectman trial"
git config user.email "trial@example.invalid"
git config commit.gpgsign false

branch="pm-trial-$(date +%Y%m%d%H%M%S)"
git checkout --quiet -b "$branch"
echo "trial $(date -u +%FT%TZ)" > pm-trial.txt
git add pm-trial.txt
git commit --quiet -m "projectman publishing trial"

# What must work: an own branch and its pull request.
expect_ok "push an own branch" git push --quiet origin "HEAD:refs/heads/$branch"
pr_url="$(gh pr create --repo "$repo" --head "$branch" --base "$default_branch" \
  --title "projectman publishing trial" --body "Opened by deploy/github/trial.sh; safe to close." 2>"$work/err")"
if [ -n "$pr_url" ]; then pass "open its pull request ($pr_url)"; else fail "open its pull request"; sed 's/^/        /' "$work/err" >&2; fi
pr_number="${pr_url##*/}"

# What must be refused.
expect_refused "push to the default branch" git push --quiet origin "HEAD:refs/heads/$default_branch"
expect_refused "force push to the default branch" git push --quiet --force origin "HEAD:refs/heads/$default_branch"
expect_refused "delete the default branch" git push --quiet origin ":refs/heads/$default_branch"
expect_refused "push a tag" git push --quiet origin "HEAD:refs/tags/pm-trial-tag"
if [ -n "$pr_number" ]; then
  expect_refused "merge the pull request with gh" gh pr merge "$pr_number" --repo "$repo" --merge
  expect_refused "merge the pull request through the API" \
    gh api --method PUT "repos/$repo/pulls/$pr_number/merge" -f merge_method=merge
fi
mkdir -p .github/workflows
printf 'on: workflow_dispatch\njobs:\n  trial:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo trial\n' > .github/workflows/pm-trial.yml
git add .github/workflows/pm-trial.yml
git commit --quiet -m "projectman trial workflow"
expect_refused "push a workflow file on an own branch" git push --quiet origin "HEAD:refs/heads/$branch-workflow"

# Clean up what this trial made (the identity may delete its own branch and close its pull request).
if [ -n "$pr_number" ]; then gh pr close "$pr_number" --repo "$repo" --delete-branch >/dev/null 2>&1 || true; fi
git push --quiet origin ":refs/heads/$branch" >/dev/null 2>&1 || true

if [ "$failures" -eq 0 ]; then
  echo "All attempts behaved as required."
  exit 0
fi
echo "$failures check(s) failed: do not enable publishing on a repository where this happens." >&2
exit 1
