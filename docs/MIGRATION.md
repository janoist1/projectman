# Moving an installation (PM-143, PM-318)

The migration tool packages a stopped installation, remaps its paths and prepares a standby copy.
A real move needs the owner's concrete approval. The running installation must not be touched
without that approval. For the hybrid migration procedure, see [HYBRID.md](HYBRID.md).

Use `npm run migrate -- inventory|plan|package|apply|verify|instance|work` from `scripts/migrate/`.

## Rules the move keeps

These come from the task and decisions 25 and 26; each is enforced by the tool or by the procedure, and the
tests named in the last column hold them.

| Rule                                                                                                   | Where it holds                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The source is only read: no stash, reset, clean or delete of any repository, worktree or file          | `package` reads the database from a scratch copy and opens the source database in place only when a log or shared-memory file is left beside it (a lock probe: it may fold a left-over log into the main file, as SQLite would at the next start; no data changes); `migration-package.test.ts` compares the source before and after                                                                                |
| Dirty, untracked and local-only work is neither dropped nor stashed: it is carried and named           | One git bundle per repository (every branch, tag, remote-tracking ref), made from a scratch repository that borrows the source's objects so that **every stash entry** (not only the newest) travels with its message and is stored again in the same order, and a commit only a detached HEAD holds is kept as the branch `migrated/detached-<sha>`; a tar of the dirty files per checkout; `work/` in the package |
| That work is assigned to a member by a person, never applied automatically                             | `apply` puts it in `migrated/pending-work.json` as `pending`; `work apply` goes only into a clean checkout of the same commit                                                                                                                                                                                                                                                                                       |
| Old worktrees are not deleted, and are not carried as directories                                      | Left out of the package (listed in `notCarried`); their work is captured as above                                                                                                                                                                                                                                                                                                                                   |
| The package is a secret: never a repository file, a task attachment or a message                       | Directory mode 0700, files 0600; refused inside the source home or inside any git repository                                                                                                                                                                                                                                                                                                                        |
| Mac absolute paths are translated explicitly                                                           | `--map FROM=TO`, longest match at a path-segment boundary; the old home maps onto the new one; the rest is reported (`unmapped_path`), not guessed                                                                                                                                                                                                                                                                  |
| Old conversations stay as history; none is resumed from another working directory | Their rows and carried transcripts stay readable; a new conversation starts from the task brief and member memory. |
| A newer schema is never opened by an older build                                                       | `migrate()` refuses it (`db.test.ts`); `verify`, `package` name it a blocker; the rollback goes back to the untouched old database, never to the migrated one                                                                                                                                                                                                                                 |
| Only one copy works                                                                                    | `instance.json` (below); `apply` always produces a `standby` copy; `activate` needs proof that the other is retired                                                                                                                                                                                                                                                                                                 |
| The move never overwrites a home or a non-empty repository                                             | `apply` refuses a non-empty target home and skips a non-empty repository path                                                                                                                                                                                                                                                                                                                                       |

## The instance role: only one copy works

Two copies of one home would answer the same inbox, move the same tasks and spend the same subscription.
The rule is a marker file in the home directory (`packages/shared/src/deploy/instance-role.ts`):

- **no file** — the active instance. Every installation made before this rule is one.
- **`standby`** — a rehearsal copy or a copy not yet released. The server starts and shows its data, but runs
  no scheduler, no GitHub polling and no automatic start, and refuses every AI session start (`instance_standby`).
- **`retired`** — the home was moved away. The server refuses to start on it, before it creates or opens
  anything in it.
- A marker that cannot be read stops the server (the role is unknown), and nothing in the server changes a role.

A person changes it with `npm run migrate -- instance …`:

```sh
npm run migrate -- instance status  --home <home>
npm run migrate -- instance retire  --home <old home> --reason "moved to another machine"
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

## The hybrid mode (PM-318): the same tool, a different move

The hybrid move is from the single-machine mode to the board in the cloud, the Mac as an engine ([HYBRID.md](HYBRID.md) has the whole procedure).
It uses the same tool and the same rules (the source is only read, a package is a secret, only one copy
works), with these additions:

- `hybrid plan|package|back` (`scripts/migrate/hybrid.ts`). The package has `kind: "hybrid_cloud"` and
  holds a closed list of six entries; it has no repositories, no work, no transcripts, no CLI logins. The
  machine key is made on the Mac and never enters the package (only its hash does).
  `apply` refuses a `hybrid_cloud` package, and `verify --hybrid-cloud` checks the cloud's data
  (`forbidden_entry`, `engines_missing`, `default_engine`, `session_engine_missing`) without looking for
  Mac paths.
- A fourth instance role, `engine` (`instance engine`): the Mac's home after the move. No server works on
  it, the engine may start on it, and the former database is kept for the way back.
- `hybrid back` puts the cloud's data into the home and keeps the former entries in
  `pre-hybrid/YYYY-MM-DD/` (denied to the sessions' sandboxes, like `.hybrid-back/`, its staging folder).
  It tolerates, and does not carry, what a running cloud writes itself (`logs/`, `engine-spool/`,
  Litestream's folder, a restored copy's `instance.json`). It and `instance activate` from the `engine`
  role refuse while the engine's LaunchAgent is installed; `activate` also needs the cloud's engine row
  in the database (or `--discard-cloud-data`).
