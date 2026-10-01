#!/bin/sh
# Manual probe of the agent CLIs' sandboxes (PM-126). Never part of the automated tests: it runs
# the real `claude` / `codex` on the sponsor's plan only when a person runs it by hand.
#
#   sh scripts/sandbox-probe.sh setup     # builds ~/projectman-sandbox-probe (fictional data)
#   sh scripts/sandbox-probe.sh checks    # the checks; run it inside the sandbox under test
#   sh scripts/sandbox-probe.sh cleanup   # removes ~/projectman-sandbox-probe
#
# The probe area lives under the home directory on purpose: the CLIs let sandboxed commands
# write to the temp directories, so a probe there could not tell a blocked write from an
# allowed one. Start a stand-in for the live instance first:
#   node -e "require('http').createServer((q,s)=>s.end('ok')).listen(48999,'127.0.0.1')" &
# then run the checks from the worktree under each sandbox, e.g.
#   cd ~/projectman-sandbox-probe/worktrees/T-1
#   claude -p "Run exactly: sh probe.sh, then print its output verbatim" --model sonnet \
#     --permission-mode acceptEdits --settings '<sandbox settings, see docs/PROVIDERS.md>'
#   codex sandbox -c 'sandbox_mode="workspace-write"' \
#     -c 'sandbox_workspace_write.writable_roots=["<git common dir>"]' -- sh probe.sh
set -eu
ROOT="$HOME/projectman-sandbox-probe"

setup() {
  if [ -e "$ROOT" ]; then echo "$ROOT exists; run cleanup first" >&2; exit 1; fi
  mkdir -p "$ROOT/outside" "$ROOT/fake-live" "$ROOT/worktrees"
  echo "fictional secret" > "$ROOT/outside/secret.txt"
  echo "fictional live data" > "$ROOT/fake-live/db.txt"
  git init -q "$ROOT/main-repo"
  git -C "$ROOT/main-repo" config user.email probe@example.invalid
  git -C "$ROOT/main-repo" config user.name probe
  echo hello > "$ROOT/main-repo/README.md"
  git -C "$ROOT/main-repo" add README.md
  git -C "$ROOT/main-repo" commit -qm init
  git -C "$ROOT/main-repo" worktree add -q "$ROOT/worktrees/T-1" -b t-1
  mkdir -p "$ROOT/worktrees/T-1/npm-probe"
  printf '{"name":"npm-probe","version":"1.0.0","private":true,"dependencies":{"is-number":"7.0.0"}}\n' \
    > "$ROOT/worktrees/T-1/npm-probe/package.json"
  cp "$0" "$ROOT/worktrees/T-1/probe.sh"
  echo "ready: cd $ROOT/worktrees/T-1 and run 'sh probe.sh checks' under the sandbox"
}

# One line per check: "ok" when the action succeeded, "denied" when it failed.
check() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then echo "$name: ok"; else echo "$name: denied"; fi
}

checks() {
  check write_cwd sh -c 'echo x > ./probe-write.txt'
  check write_tmpdir sh -c 'echo x > "${TMPDIR:-/tmp}/probe-write.txt"'
  check write_outside sh -c "echo x > '$ROOT/outside/probe-write.txt'"
  check write_fake_live sh -c "echo x > '$ROOT/fake-live/probe-write.txt'"
  check read_outside_secret cat "$ROOT/outside/secret.txt"
  check read_fake_live cat "$ROOT/fake-live/db.txt"
  check git_commit sh -c 'date > probe-write.txt && git add probe-write.txt && git commit -qm probe'
  check write_git_hooks sh -c 'echo x > "$(git rev-parse --git-common-dir)/hooks/probe-hook"'
  check write_git_config git config probe.key 1
  check net_npm curl -s -o /dev/null --max-time 8 https://registry.npmjs.org/-/ping
  check net_other_host curl -s -o /dev/null --max-time 8 https://example.com
  check net_localhost curl -s -o /dev/null --max-time 3 http://127.0.0.1:48999/
  check bind_local node -e "const s=require('http').createServer();s.listen(0,'127.0.0.1',()=>s.close());s.on('error',()=>process.exit(1))"
  check self_loop node -e "const h=require('http');const s=h.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{h.get('http://127.0.0.1:'+s.address().port,(r)=>{r.resume();r.on('end',()=>{s.close();process.exit(r.statusCode===200?0:1)})}).on('error',()=>process.exit(1))});s.on('error',()=>process.exit(1))"
  check npm_install sh -c 'cd npm-probe && npm install --prefer-offline --no-audit --no-fund'
}

cleanup() {
  rm -rf "$ROOT"
}

case "${1:-checks}" in
  setup) setup ;;
  checks) checks ;;
  cleanup) cleanup ;;
  *) echo "usage: sh scripts/sandbox-probe.sh setup|checks|cleanup" >&2; exit 2 ;;
esac
