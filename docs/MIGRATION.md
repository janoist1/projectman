# Moving the live installation to the VM (PM-143, last part of PM-135)

How the owner's installation moves from the Mac to the managed VM ([VM.md](VM.md)), how the move is
rehearsed, what the owner approves, and how it is taken back. **This page is not a permission to move.**
The real move needs its own, concrete approval by the owner (the approval sheet below); until then the
live instance on the Mac is never touched, stopped or updated by anything described here.

What exists to carry it out, all in this repository:

| Piece                                       | What it is                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `scripts/migrate/` (`npm run migrate -- …`) | The move tool: `inventory`, `plan`, `package`, `apply`, `verify`, `instance`, `work`                         |
| `instance.json` in a home                   | The role of a copy: no file = active, `standby` = shows data and starts no AI, `retired` = never starts      |
| `deploy/vm/migrate.sh`                      | Runs the tool on the VM as the service account                                                               |
| `deploy/vm/backup.sh`, `restore.sh`         | The VM's restore point; `restore.sh` first runs `check-backup.sh` and refuses a newer schema                 |
| `deploy/vm/check-backup.sh`                 | Proves an archive restorable by this build, on a scratch copy, without touching the running installation     |
| `deploy/vm/rehearse.sh`                     | The machine-checkable part of the VM rehearsal, with a log: readiness, the whole test suite, restart, backup |
| `apps/server/test/migration-*.test.ts`      | The tool and the standby rule, on a realistic source home (repositories, worktrees, dirty work, transcripts) |

## Rules the move keeps

These come from the task and decisions 25 and 26; each is enforced by the tool or by the procedure, and the
tests named in the last column hold them.

| Rule                                                                                                   | Where it holds                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The source is only read: no stash, reset, clean or delete of any repository, worktree or file          | `package` reads the database from a scratch copy; `migration-package.test.ts` compares the source before and after                                                                                |
| Dirty, untracked and local-only work is neither dropped nor stashed: it is carried and named           | One git bundle per repository (every branch, tag, stash, remote-tracking ref) and a tar of the dirty files per checkout; `work/` in the package                                                   |
| That work is assigned to a member by a person, never applied automatically                             | `apply` puts it in `migrated/pending-work.json` as `pending`; `work apply` goes only into a clean checkout of the same commit                                                                     |
| Old worktrees are not deleted, and are not carried as directories                                      | Left out of the package (listed in `notCarried`); their work is captured as above                                                                                                                 |
| The package is a secret: never a repository file, a task attachment or a message                       | Directory mode 0700, files 0600; refused inside the source home or inside any git repository                                                                                                      |
| Mac absolute paths are translated explicitly                                                           | `--map FROM=TO`, longest match at a path-segment boundary; the old home maps onto the new one; the rest is reported (`unmapped_path`), not guessed                                                |
| No personal Mac CLI home is copied; the VM has new subscription logins and its own publishing identity | The package has no CLI home, no `github-publish/`; the logins are human steps ([VM.md](VM.md))                                                                                                    |
| Old conversations stay as history; none is resumed from another working directory or profile           | Their rows and carried transcripts stay readable; the server never resumes across execution profiles (decision 26, PM-141); a new conversation starts from the task brief and the member's memory |
| A newer schema is never opened by an older build                                                       | `migrate()` refuses it (`db.test.ts`); `verify`, `package` and `check-backup.sh` name it a blocker; the rollback goes back to the untouched old database, never to the migrated one               |
| Only one copy works                                                                                    | `instance.json` (below); `apply` always produces a `standby` copy; `activate` needs proof that the other is retired                                                                               |
| The move never overwrites a home or a non-empty repository                                             | `apply` refuses a non-empty target home and skips a non-empty repository path                                                                                                                     |

## The instance role: only one copy works

Two copies of one home would answer the same inbox, move the same tasks and spend the same subscription.
The rule is a marker file in the home directory (`packages/shared/src/deploy/instance-role.ts`):

- **no file** — the active instance. Every installation made before this rule is one.
- **`standby`** — a rehearsal copy or a copy not yet released. The server starts and shows its data, but runs
  no scheduler, no GitHub polling and no automatic start, and refuses every AI session start (`instance_standby`).
- **`retired`** — the home was moved away. The server refuses to start on it, before it creates or opens
  anything in it.
- A marker that cannot be read stops the server (the role is unknown), and nothing in the server changes a role.

A person changes it with `npm run migrate -- instance …` (on the VM through `migrate.sh`):

```sh
npm run migrate -- instance status  --home <home>
npm run migrate -- instance retire  --home <old home> --reason "moved to the VM"
npm run migrate -- instance activate --home <new home> --other-home <old home>        # same machine: the old marker must say retired
npm run migrate -- instance activate --home <new home> --confirm-source-retired      # other machine: the person states it
```

Every change refuses while a server has the database open. **An old build ignores the marker.** The live
instance on the Mac runs an older checkout, so retiring its home only protects it after the live checkout is
updated to a build with this change (an owner-approved live update, as always). Until then the safeguard on the
Mac is the procedure: the live instance is stopped and not started again.

## Dry run: rehearsing the move without the live instance

The rehearsal needs a **stopped** source and a separate target home, never the running live instance and never
`~/.projectman` of the running Mac instance. A source for it: the development home (`~/.projectman-dev`, a test
instance that is stopped), or a copy of the live home made while the live instance is stopped for any other
reason (for instance during an update switch): `cp -Rp ~/.projectman ~/pm-rehearsal/source`.

```sh
cd <a clean checkout of the build to be moved>
npm install
npm run migrate -- inventory --home ~/pm-rehearsal/source                          # read-only; no blocker expected
npm run migrate -- plan --home ~/pm-rehearsal/source --out ~/pm-rehearsal/sheet.md # the concrete sheet, as for the real move
npm run migrate -- package --home ~/pm-rehearsal/source --out ~/pm-rehearsal/package
npm run migrate -- apply --package ~/pm-rehearsal/package --target-home ~/pm-rehearsal/target \
    --map <old workspace>=$HOME/pm-rehearsal/repos/<KEY>  # an absolute path, one --map per workspace in the sheet
npm run migrate -- verify --home ~/pm-rehearsal/target
```

Then start a server on the target on a spare port, with its own data, and look at it as a person would:
`cd apps/server && env PORT=4701 PROJECTMAN_HOME=$HOME/pm-rehearsal/target npx tsx src/index.ts` (the port 4800 and
`~/.projectman` are the live instance's; `npm run dev` may pick them, so it is not used here). Check the owner's login (the same password), the board, a task's
attachment, a conversation's history, and that starting an AI session is refused as `instance_standby`.
Stop it, delete only the rehearsal directory. The automated version of exactly this is
`apps/server/test/migration-apply.test.ts` (“keeps the logins and the data …”). The dry run never changes the
source: compare `git status` of the repositories before and after if in doubt.

## The restore point and the restore rehearsal

The restore point of the VM is `deploy/vm/backup.sh` (the service stopped, SQLite and its log consistent,
`customization/` with `.git`, the cookie secret, attachments, memory, transcripts, the workers' homes). The package
of the move is the restore point of the **Mac side**: it is immutable (every file has a checksum in its manifest;
`apply` refuses a package that does not match it) and the source home it was made from is untouched.

```sh
sudo bash /srv/projectman/deploy/vm/backup.sh /root/projectman-backup.tar.gz     # restore point
sudo bash /srv/projectman/deploy/vm/check-backup.sh /root/projectman-backup.tar.gz  # restorable by this build? (scratch copy)
sudo bash /srv/projectman/deploy/vm/restore.sh /root/projectman-backup.tar.gz    # runs check-backup.sh first, moves the old state to *.before-restore-<time>
```

`check-backup.sh` extracts the data to a private scratch directory and runs `verify` on it: database integrity and
schema against this build (a newer schema is a blocker), the cookie secret and its mode, attachments against their
rows, the customization repository (`git fsck`, submodules, every project's configuration loading). A full restore
rehearsal is the existing one in [VM.md](VM.md#backup-and-restore): back up, destroy the throwaway VM, build it again,
restore, `verify.sh`, log in. Backups are secrets: mode 0600, encrypted before they leave the machine.

## The approval sheet (what the owner approves)

`npm run migrate -- plan --home ~/.projectman` (it reads only, and also works while the live instance runs)
writes the cutover sheet for the real home: what moves, the path mappings, every decision only the owner can take
(the unpushed and uncommitted work, by repository and by member), the blocking findings and the exact commands. The
owner approves **that sheet**, together with the checks below, in words like:

> I approve moving the live instance (`<home>`, schema `<n>`) to the VM `<name>` at commit `<sha>`, with the path
> mappings and the decisions of the sheet dated `<date>`. The Mac instance stays stopped but intact as the rollback.

Nothing in the procedure below runs before that sentence, and a changed sheet (new findings, another commit) needs
it again. **Preconditions** (each is checked, not assumed):

1. PM-140 (the protected launcher and the domain gate) is in `main` and deployed to the VM, and `rehearse.sh all`
   passed on that build: `verify.sh` reports `launcher` and `domain-gate` as passed. Without it the question-free
   profile refuses every session, and a moved installation could only show its data.
2. The VM trial of [VM.md](VM.md) (manual protocol and the question-free trial) is done and its results are on the card.
3. The owner has created the publishing identity and installed its token file ([GITHUB.md](GITHUB.md)); the
   subscription logins of both providers were made in the VM by a person.
4. The dry run above succeeded on a copy of the live home, and its result is attached to the card.
5. Tailscale Serve works from the phone (the checks of [DEPLOY.md](DEPLOY.md)).

## The cutover, step by step

A quiet moment; the team is told. `<old>` is the Mac home, `<new>` the VM's `PROJECTMAN_HOME`.

| #   | Where | Step                                                                                                                                                                                                                                      | Check before going on                                                                                               |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Mac   | Switch AI work off in every project, let running sessions finish, push or commit what is finished (the decisions of the sheet)                                                                                                            | No session is working                                                                                               |
| 2   | Mac   | **Stop the live instance.** It is not started again until step 12 or a rollback                                                                                                                                                           | `inventory --home <old>` shows no `source_running`, no blocker                                                      |
| 3   | Mac   | `npm run migrate -- package --home <old> --out ~/pm-move/package`                                                                                                                                                                         | Exit 0; the summary lists the repositories, pending work and transcripts of the sheet                               |
| 4   | Mac   | Encrypt the package, move it to the VM (`multipass transfer`), decrypt into `$SERVICE_HOME/incoming` (0700, owned by `projectman`). Keep the Mac's copy until the move is accepted                                                        | Checksums verify on the VM (`apply` verifies every file)                                                            |
| 5   | VM    | A restore point of the VM as it is (`multipass snapshot` of the stopped VM, and `backup.sh`)                                                                                                                                              | `check-backup.sh` passes                                                                                            |
| 6   | VM    | `systemctl stop projectman`; move any rehearsal data aside (`mv data data.rehearsal-<date>`, never delete)                                                                                                                                | The target home does not exist or is empty                                                                          |
| 7   | VM    | `sudo bash /srv/projectman/deploy/vm/migrate.sh apply --package … --target-home <new> --map …` (the lines of the sheet)                                                                                                                   | `verify` at the end of `apply` is OK; the report lists no unexpected `unmapped_path`                                |
| 8   | VM    | Start the service **as standby**; open it from the browser (SSH forward) and the phone (Tailscale)                                                                                                                                        | Login works with the old password; board, attachments, a conversation's history open; starting a session is refused |
| 9   | Mac   | `npm run migrate -- instance retire --home <old> --reason "moved to the VM"`                                                                                                                                                              | `instance status` says retired                                                                                      |
| 10  | VM    | Stop the service; `migrate.sh instance activate --home <new> --confirm-source-retired`; set the profile drop-in of [VM.md](VM.md#the-question-free-profile-pm-141) (`PROJECTMAN_WORKSPACES=member`, `managed_vm`, the report path); start | `verify.sh` and the verdict are READY; the service is `active`                                                      |
| 11  | VM    | Switch AI work on for one project, start one member's task: a **new** conversation from the brief and the memory; check the inbox stays empty for routine work                                                                            | No inbox item for a routine command; the member works in its own workspace                                          |
| 12  | VM    | `backup.sh` + `check-backup.sh`: the first restore point of the live VM; update the pending work (assign each item to a member, or keep it pending)                                                                                       | Both pass                                                                                                           |
| 13  | Mac   | Update the live checkout to a build with the marker (an owner-approved live update) so a stray start of the old home is refused                                                                                                           | The old home refuses to start                                                                                       |

The old worktrees on the Mac are not deleted by any step. The window for the rollback stays open until the owner
accepts the move (step 12 done and a working day without a problem).

## Rollback

The Mac home is never changed by the move (the tool only reads it; step 9 adds one marker file), and the package is
unchanged, so every rollback starts from a known state.

- **Before step 10 (the VM was only standby).** Nothing worked on the VM. Stop it; on the Mac remove the marker
  (`instance activate --home <old> --confirm-source-retired`) if step 9 was done, and start the live instance as
  before. The VM data can be kept for diagnosis. Nothing is lost.
- **After step 10, before any AI session or edit on the VM.** The same, after retiring the VM home
  (`instance retire --home <new> --reason "rolled back"`): the Mac home is exactly as it was stopped.
- **After the VM worked.** What was done on the VM (new tasks, comments, sessions, pushed branches) exists only in the
  VM's data. Going back to the Mac loses it from the Mac's view unless a person re-enters it; pushed branches are on
  GitHub and the Mac can fetch them. The owner decides this explicitly: keep the VM and fix forward, or go back and
  accept the loss. The migrated database is **never** given to an older build (it refuses it); a rollback always
  returns to the untouched old database.
- **A failed `apply` or `verify`.** The target is left as it is (a standby, never active) for diagnosis; delete only
  that directory (it is a copy) and start again from the package.

## Acceptance matrix: the evidence

Each row of the task's trial, with what proves it. “Automated” runs in `npm test`; “VM” is a step that only a real
VM can show and that a person records on the card (the log of `rehearse.sh` for the scripted ones, the checklist
of [VM.md](VM.md) for the rest). **A VM row that was not run is not evidence.** This work was done without a VM:
every “VM” row below is open until then.

Titles are those of the tests; a path without a prefix is under `apps/server/`.

| #   | Row of the trial                                                                                                                 | Automated (`npm test`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | VM / human (open until run)                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Each provider's developer: own durable workstation, code, install, test, commit, push, PR                                        | `test/member-workspaces.test.ts` (“gives each member its own clone, and every new task a fresh branch of its own”, “keeps the workspace, its branches, dependencies and the member memory after the task is done”); `test/github-publishing.test.ts` (“publishes the member own task branch and opens its pull request, never touching the default branch”, “is idempotent and adds a later commit to the same pull request”); `src/github/publisher.test.ts`; `test/managed-vm-sessions.test.ts` (“starts a developer question-free in its own workspace …”)                                                                                                                                                                          | [VM.md](VM.md#the-question-free-profile-pm-141) human trial, step 2, for **a Claude and a Codex developer**; `deploy/github/trial.sh` for the real GitHub push and PR ([GITHUB.md](GITHUB.md))                                          |
| 2   | QA and reviewer on their own station, pinned to the commit                                                                       | `test/member-workspaces.test.ts` (“reviews the handed-over commit in the reviewer's own workspace; a new round on a stage entry or the developer's message”, “reviews the assignee's latest commit, not the copy of a developer who opened the task later”); `src/worktree/member-workspace-manager.test.ts` (“checks out the pinned commit for a review, not the developer's later or uncommitted work”); `test/managed-vm-sessions.test.ts` (“puts a reviewer on the handed-over commit in its own workspace, question-free too”)                                                                                                                                                                                                    | Human trial intro: a QA and a reviewer member on both providers. (No test names a QA role itself; the workspace tests use a reviewer.)                                                                                                  |
| 3   | A second task in the same place, on a new branch                                                                                 | `test/member-workspaces.test.ts` (“never switches away from uncommitted work: the start fails and nothing is stashed or reset”, “refuses a switch during an interrupted git operation”, “does not start a new task from a stale base when the default branch cannot be fetched”); `src/worktree/member-workspace-manager.test.ts` (“starts a new task branch from the freshly fetched default branch”, “keeps every task branch and its commits; continuing a task returns to its branch without a reset”)                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                       |
| 4   | Parallel members                                                                                                                 | `test/member-workspaces.test.ts` (“gives each member its own clone …” runs two developers at once; “keeps a second task of the same repository waiting while the first one works there”, “lets another repository of the same member run in parallel”, “keeps a reservation over a restart until the old processes are proven gone”)                                                                                                                                                                                                                                                                                                                                                                                                   | OS-level separation of two uids: `verify.sh` `worker-isolation`; the measurement of [VM.md](VM.md) (`measure.sh` with 1, 2 and 3 sessions)                                                                                              |
| 5   | An old task and conversation (resume)                                                                                            | `test/managed-vm-sessions.test.ts` “changing profile” (“starts a new conversation in the new place: no old working directory, no resume”, “resumes in the same profile, in the same place”, “voids what the session asked or was granted at the boundary under the old profile”); `test/session-continuation.integration.test.ts` (both providers); **the move:** `test/migration-apply.test.ts` (“keeps the logins and the data, shows them as a standby …”: history readable from the carried transcript, no session resumed)                                                                                                                                                                                                        | Human trial step 3 (resume without a question) on the real CLIs                                                                                                                                                                         |
| 6   | Permission requests in the routine round: zero                                                                                   | `src/runner/managed-vm.integration.test.ts` for the fake Claude and the fake Codex (“runs a routine turn without any local approval request”, “refuses a request that arrives anyway, without asking a human and without stopping the work”); `test/managed-vm-sessions.test.ts` (“answers a request at once, without an inbox item and without judging the command”)                                                                                                                                                                                                                                                                                                                                                                  | **The number on the real CLIs**: human trial steps 1, 2 and 6 (the tests prove the settings the fakes see, not that the real CLIs never prompt, e.g. on `.git`/`.claude`)                                                               |
| 7   | New domain to the lead; deny, allow, expiry; owner without an answer; the four owner categories; gate and release never by an AI | `test/boundary.test.ts` (lead first: “routes a custom-duty request, wakes the lead through messaging …”; deny and late decisions: “refuses unauthorized, self, double and late decisions without issuing a grant”; expiry: “expires unanswered owner requests, including after restart”; escalation: “escalates persisted absolute deadlines on restart and refuses the late lead”; the four categories: “keeps %s exclusively with owners”; “never relaxes ordinary inbox or release approvals for a delegation holder”); `packages/shared/src/domain/boundary.test.ts`; `test/boundary-api.test.ts`; `test/gates.test.ts` (“an AI member or a non-approver can never resolve a gate decision”); `test/release-four-eyes-api.test.ts` | The real launcher and domain gate (PM-140) answer for real traffic: needs PM-140 on the VM. No test is named “never allowed automatically”; it follows from the tests above                                                             |
| 8   | Push to `main` and merge are refused                                                                                             | `src/github/publisher.test.ts` “what the publisher never does” (“refuses %s before it touches git or gh”, “never forces …”, “never merges: the identity has no merge right at GitHub …”); `test/github-publishing.test.ts` “what the gate refuses”; `packages/shared/src/deploy/publishing.test.ts`; `publish_main` is owner-only (row 7)                                                                                                                                                                                                                                                                                                                                                                                              | The real GitHub ruleset and the identity's missing merge right: `deploy/github/trial.sh`; human trial step 4 (`git push` to GitHub fails at the gate)                                                                                   |
| 9   | OS boundaries: no Mac or host access, no other member's half-done work, protected control                                        | Only the contract and the scripts: `test/vm-profile.test.ts` (“verify.sh measures every check of the contract”, “does not share anything of the Mac with the VM”, “closes all non-loopback IPv6 …”), `packages/shared/src/deploy/vm-readiness.test.ts`, `src/runner/managed-vm.test.ts`. **No automated test measures an isolation property**                                                                                                                                                                                                                                                                                                                                                                                          | `verify.sh` on the VM: `worker-denied-read`, `worker-denied-write`, `worker-isolation`, `no-host-mounts`, `gate-blocks-host`, `gate-control`, `proc-hidden` …; [VM.md](VM.md) manual trial steps 2, 6, 7, 8, 9; `rehearse.sh readiness` |
| 10  | Failure, restart, lost connection                                                                                                | `test/sessions.test.ts` (“marks live sessions as exited after a restart”); `test/deferred-starts.test.ts` “deferred starts across a restart”; `test/deferred-starts.integration.test.ts`; `test/auth-restart.test.ts`; `apps/web/src/api/socket.test.ts` (“reconnects with backoff and replays subscriptions and terminal attachments”)                                                                                                                                                                                                                                                                                                                                                                                                | VM restart with the gate rules back from the unit: manual trial step 5, `rehearse.sh restart`; a lost phone connection is a human check                                                                                                 |
| 11  | Browser and phone                                                                                                                | `test/api.test.ts` (“rejects cross-origin mutations including login, and sets secure proxy cookies”); `test/ws.test.ts` (“closes foreign-origin sockets (%s) …”, “rejects connections without a login cookie”)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Manual trial steps 3 and 4: the forward, Tailscale Serve, [DEPLOY.md](DEPLOY.md)'s HTTPS checks from a tailnet client, **a login and a live update on the phone**                                                                       |
| 12  | The whole server suite, the pseudo-terminal files included                                                                       | The suite itself; `apps/server/vitest.config.ts` leaves 13 files out when no pseudo-terminal can be opened (a sandbox), with a notice and **no “skipped” count**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `rehearse.sh tests` runs it on the VM and **fails** if the notice appears or no integration or golden-path file ran (the exemption of PM-134 is not accepted there)                                                                     |
| 13  | The move: inventory, package, apply, verify, standby, retire, activate                                                           | `test/migration-package.test.ts` (inventory, package, source untouched, damage detected); `test/migration-apply.test.ts` (paths, repositories, transcripts, pending work, submodules, standby on a running server, only one active, an older schema migrated); `test/migration-verify.test.ts` (each damage named; the command line); `test/migration-plan.test.ts` (the cutover sheet); `test/migration-paths.test.ts`; `test/instance-role.test.ts`                                                                                                                                                                                                                                                                                  | `check-backup.sh`, `restore.sh`, `migrate.sh`, `rehearse.sh backup` on Ubuntu; the dry run on a copy of the real home; the real cutover (after the owner's approval)                                                                    |

The PTY-dependent files (`*.integration.test.ts` and `test/golden-path-*.test.ts`, 13 files) are listed in
`apps/server/vitest.config.ts`. The tests added by this card (`migration-*`, `instance-role`) need no pseudo-terminal
and run in the sandbox as well.

## What a VM is needed for (nothing here has been run yet)

The scripts and the tool were written and tested on the Mac with fakes and temporary directories. Not run, and not
claimed: `bootstrap.sh`, `install-app.sh`, `verify.sh` on Ubuntu with the new files (the first trial's fixes are in
`46684e5`), `rehearse.sh` (it only runs as root on the VM), a real `check-backup.sh`/`restore.sh` on a throwaway VM, the
real provider CLIs, Tailscale from a phone, and the full test suite with the pseudo-terminal files (the sandbox this
work ran in forbids pseudo-terminals, which is exactly the PM-134 exemption the task does not accept for the VM).

## Handover to PM-45 (the long-running server)

The same files build a rented Ubuntu 24.04 server; no cloud purchase is part of this card. The reproducible Linux
installation is: `bootstrap.sh` (accounts, pinned Node and CLIs, egress rules, units), `install-app.sh` (the commit
as a `git archive`, build, smoke test), the human steps of [VM.md](VM.md) (logins, owner, Tailscale), `verify.sh` and
`rehearse.sh all` (proof), and this page for the data. For a new server, replace the Mac and Multipass steps by the
server's SSH; the move itself does not change.

## Decisions for the owner

- The VM paths of the repositories. The sheet proposes `/var/lib/projectman/repos/<KEY>` (service home, outside the
  data directory, inside the backup). Say if another place is wanted.
- Whether the personal accounts (the login hashes in the database) travel with the data: they do, with the cookie
  secret, so browser logins stay valid. A new owner account instead would mean the tasks lose their authors.
- How long the rollback window stays open (proposed: until a working day passes after step 12).
