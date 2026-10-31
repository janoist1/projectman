# projectman — machine-dependent parts

Every part of projectman that depends on the machine it runs on: local paths, processes, sockets, accounts, OS
features or a shared-host assumption (PM-341). Each entry records what it does, its code location, the machine
assumption, what a remote engine needs and the related task. A change that adds or changes such a part updates its
entry here in the same change (`CLAUDE.md`, "Machine-dependent assumptions"); every technical plan answers "Does this
work on a remote engine?" against these entries. The overview is [ARCHITECTURE.md](ARCHITECTURE.md).

## Index

Entries in the order they appear below (search for the bold name).

- **Engine and its host:** Shared repository git settings · Engine menu bar app · Engine app package · Engine app
  release build · Interrupted card continuation · Keep awake while working · Link-headers file and the
  working-folder check · Member queue driver · Startup sweep of crash leftovers · One-shot external commands · Local
  history embeddings · Web push sender · ntfy phone channel
- **Super mode and administration:** Durable super-mode handoff and owner-bound operations · Super-mode operations
  and diagnostics · Project change journal · Private Operator knowledge
- **Cloud and AWS:** Cloud provisioning from the owner's machine · EC2 provisioning and account boundary · EC2 host
  administration through SSM · The cloud machine and its operation · The Cloudflare side of the cloud board · SES
  identity/DKIM and sender provisioning · The e-mail login code mailer on AWS SES · The e-mail login of invited
  clients · E-mail channel sender (SES) · E-mail channel inbound (SES receiving → SNS → SQS) · Feedback widget public
  entrance and screenshot store
- **Releases and tests:** Single-mode recovery service · Feedback widget public entrance · Full
  test trial CLI · Provider and engine outage watch
- **Engine link and cloud composition:** Engine link and machine keys · Engine process · Cloud composition · Cloud
  deployment and backup · Integrator credential
- **Providers and sessions:** Codex project layer check · NanoGPT Codex home and key delivery · Gemini (agy) CLI,
  conversation directories and keychain login · NanoGPT secret store · Session process liveness · Fake CLI pause
  test gates · Dependency clones and refreshes · Heavy-run queue and worker limits · Server and engine log files ·
  Session output folders · Card attachments · Message attachments · Message file in the session folder · Browser
  installation and screenshots · Machine display and orphan processes · Instance identity for process attribution ·
  Session process termination · Conversation transcripts and resume · Hooks and team MCP over loopback · Private
  session launch configuration · Work volume · Task worktrees and shared git storage · Free-disk admission guard ·
  Control socket, pause and deployment · Native sandbox and canonical paths · CLI token and plan usage · Claude
  workspace trust
- **Merge and checks:** Server full test before review · Merge-test file watchdog · Child-guard cleanup permissions ·
  Merge-test step cache · Merge check measurements · GitHub Actions runs (merge check, compute jobs) · Merge conflict fix worktrees ·
  Member initiated merge (`merge.*`) · Disposable instances and migration tools · Engine service (launchd) ·
  Non-interactive editors in member sessions

## Inventory

- **Shared repository git settings (PM-413)** — `worktree/worktree-manager.ts`
  (`ensureSharedRepoSettings`, called from `ensureWorktree` and `ensureMergeFix` under the
  repository lock). The worktree manager writes `core.useReplaceRefs=false`, `gc.packRefs=false`
  and `maintenance.pack-refs.enabled=false` into the managed repository's local git config, a
  lasting change to that repository (member workspaces, which are independent clones, are not
  touched). **Machine assumptions:** the repository lives on this machine and is writable by the
  engine's user. **Remote engine:** the worktree manager runs on the engine that holds the
  repository, so the write happens there and nothing crosses the server/engine boundary.
  Related: the Codex `packed-refs.lock` grant of PM-411.

- **Engine menu bar app (PM-1088, PM-1125, PM-1126)** — `deploy/mac/menubar/` (Swift 5.9 package, AppKit
  `NSStatusItem` / `NSMenu` and SwiftUI details and setup windows; logic in `EngineMenuCore` behind
  seams, UI in `EngineMenu`), `scripts/engine/menubar.ts`. PM-1125: the downloaded app
  (`com.projectman.engine-app`) installs itself on first launch: it moves itself to `/Applications`
  (fallback `~/Applications`), checks the prerequisites (Apple Silicon, macOS 13+, command line tools),
  copies the bundled engine package (`ditto` to `.partial`, then rename) into
  `~/Library/Application Support/projectman/engine/{versions/<ver>,current,bin/projectman-engine}`
  (PM-1200: `bin/node` moves to `engine/runtimes/<sha256>/node`, kept once per content, and
  `versions/<ver>/bin/node` becomes the relative link `../../../runtimes/<sha256>/node`; `prune` keeps the
  runtimes the kept versions link to, so the firewall sees the same path for the same Node),
  runs `service install --path <PATH>` (PATH from `$SHELL -l -i -c`, 10 s timeout, fallback list),
  registers the background item (`SMAppService`, approval in System Settings, Login Items) and starts
  the engine; a failed step is undone. The same launch removes the PM-1088 app (`launchctl bootout`
  of `com.projectman.engine-menubar`, its plist, app and `menubar.json`). The app's Details window
  uninstalls an app-managed engine (`service uninstall`, delete `engine/`, unregister); `~/.projectman`
  stays. A checkout-managed (admin) Mac only shows the menu. `npm run engine -- app install` is
  retired (`app_install_retired`); `app uninstall` removes the PM-1088 leftovers.
  `KeepAlive {SuccessfulExit:false}` of PM-1088 no longer applies; the service is the engine's
  LaunchAgent. **Machine assumptions:** macOS 13+ on Apple Silicon, Command Line Tools, `ditto`,
  `launchctl`, the login shell, `SMAppService`, the logged-in user's Applications and Library folders.
  The app re-reads the engine service's plist before every CLI call to follow release changes; then
  the engine package root (`engine/current`), and only then `menubar.json` (legacy). A package
  runs `<root>/bin/node <root>/scripts/engine/cli.js`, a checkout `node --import tsx cli.ts`.
  It takes `overall` from `status --json` without deriving engine state,
  and passes only PATH, HOME and a temporary directory to node. Polls are serialized (15 s only
  while the menu or the details window is open, 60 s otherwise even if sessions run, and a poll runs
  on every menu open; 2 s while awaiting an action's target, up to 120 s). Each poll starts a node
  process, so `status` and `logs` stay cheap: `move-work-root` loads lazily, and the CLI imports
  the kernel only through its light entry `kernel/pure.ts` (Node built-ins only), never the barrel
  that loads `effect` (PM-1130). The bundled CLI (`scripts/engine/cli.js`, the path an app-managed
  engine runs) takes about 0.17 s CPU per `status --json` instead of 0.29 s; a checkout engine
  running through tsx still pays its transform cost. `lazy-packages.test.ts` pins the eagerly
  loaded packages of the CLI bundle to `@projectman/shared`, `execa` and `zod`.
  **PM-1126, self-update:** at launch, every 6 hours, when the engine's version differs from the
  bundled one and when the status schema is too new, the app reads
  `https://github.com/<ProjectmanReleaseRepo>/releases/latest/download/projectman-motor.json`
  (`Info.plist` keys `ProjectmanReleaseRepo`, `ProjectmanTeamId`, `CFBundleVersion`). A newer
  `bundleVersion` (arm64, `minimumMacOS` met) is downloaded to
  `~/Library/Caches/com.projectman.engine-app/updates/`, checked (size, sha256), unpacked with
  `ditto -x -k`, verified with `SecStaticCodeCheckValidity` (identifier `com.projectman.engine-app`
  and the Team ID leaf OU of the running app), replaced with `FileManager.replaceItemAt` and
  relaunched by a detached `/bin/sh -c 'sleep 1; open …'`; the engine keeps running. An ad-hoc
  build (empty `ProjectmanTeamId`) never updates. A failure keeps the old app and shows menu state k.
  **PM-1126, release switch:** an app-managed (`manager: "app"`) engine whose bundled package
  version differs from the running one is staged under `engine/versions/<ver>`, switched with the
  new package's `service switch --to <root>` (automatically when `work` is 0, after a confirmation
  otherwise), then `current` is pointed at it and older versions are pruned (the running and the
  previous one stay). The menu shows the engine's `switch` state (switching, rolled back, recovery
  required). A checkout engine is never switched by the app.
  **Remote engine:** the app, the install, the removal, the update download and the CLI all run on
  the engine's Mac; the download is that Mac's own outbound traffic to GitHub (not the cloud's).
  Nothing crosses the server/engine boundary and there is no new cloud request. Linux and Windows
  are unsupported. Existing inventory entries: “Engine service (launchd)” (the app runs its
  `service install|uninstall|switch`) and “Engine app package (PM-1104, PM-1121)” (the bundled
  engine). **Machine assumptions added:** outbound HTTPS to github.com, `ditto`, the Security
  framework, a writable `~/Library/Caches` and the app's own bundle location, `/bin/sh` and `open`.
  **Language (PM-1185):** the app ships `hu.lproj` and `en.lproj` (development region `en`); macOS
  picks one from the language list of the engine's own Mac (Hungarian on a Hungarian system,
  English on any other), and numbers follow that locale (`L10n.locale`). The language is never
  taken from the hub or from the account's system language. The app file name, bundle id and
  `CFBundleName` are the same in every language.
  Core checks: `swift test --package-path deploy/mac/menubar`; fixture compatibility is checked
  by `apps/server/test/engine-menubar.test.ts`. **Module:** `deploy`, `scripts`.

- **Engine app package (PM-1104, PM-1121)** — `scripts/engine-app/` (`npm run engine-app -- package
--commit <sha> --out <dir>`), `deploy/mac/app/node.json` (the pinned Node), the manifest contract
  `apps/server/src/contracts/engine-package.ts`, its reader `engine-link/engine-package.ts`. One command builds a
  self-contained engine from one commit into `<dir>/<sha>/`: a clean checkout (`scripts/engine-app/checkout.ts`), the
  pinned Node downloaded from nodejs.org and checked by its sha256, then `npm ci`, the server build, the engine
  CLI bundle (`scripts/engine/cli.js`) and `npm prune --omit=dev`, all in the Sandbox Runtime with the pinned Node
  first on the PATH (only registry.npmjs.org and nodejs.org reachable, like the PM-750 candidate in
  `scripts/engine-app/sandbox.ts`), so the native modules (better-sqlite3, node-pty, sqlite-vec) fit the bundled
  Node's ABI. Layout (the contract the packaged service and the app build on): `engine-package.json`, `bin/node`,
  `package.json`, `package-lock.json`, `node_modules/`, `packages/`, `apps/server/{package.json,dist/}`,
  `scripts/engine/cli.js`, `deploy/mac/com.projectman.engine*.plist`. A package has no git: `resolveAppVersion` and
  `resolveAppTag` read `engine-package.json` first, and `engine start` (`scripts/engine/start-command.ts`) runs
  `bin/node apps/server/dist/index.js` when the file exists (checkout mode is unchanged). The app's staging
  (PM-1200) replaces `bin/node` with a link into `engine/runtimes/<sha256>/node`; the checks that follow it
  (`service switch` takes `statSync`, `process.execPath` is the resolved runtime path) work unchanged, and the
  unpacked package still holds a plain file. **Machine assumptions:**
  macOS arm64 only, the Sandbox Runtime, the machine's heavy-run queue, `tar`, network to nodejs.org and the npm
  registry, Xcode Command Line Tools when a native module has no prebuilt binary. **Remote engine:** the package
  runs on the engine's Mac; nothing crosses the server/engine boundary (`installDir` already travels in the
  hello). Not in the package: the menu bar app's Swift sources and the plist template of the packaged service
  (PM-1124). **PM-1156:** the package also builds on a GitHub `macos-15` runner (the `engine-app` compute job). The
  runner's Node and Python live in its toolcache under the user's home, which the sandbox closes, so the steps use
  the npm of the pinned Node archive (`bin/npm`, `lib/node_modules/npm` are unpacked next to `bin/node`; only
  `bin/node` goes into the package) and the sandbox PATH (`stepPath` in `sandbox.ts`) leaves out every folder under
  the closed user or engine home, so node-gyp finds `/usr/bin/python3`. On the Mac this means the local build also
  uses the pinned npm, not the machine's. **Module:** `scripts`, `deploy`, `contracts`, `engine-link`.

- **Engine app release build (PM-1104, PM-1122, PM-1123)** — `scripts/engine-app/build.ts`,
  `manifest.ts`, `deploy/mac/app/{Info.plist,node.entitlements}`. `npm run engine-app -- build`
  assembles the PM-1121 package and the release Swift executable into `projectman motor.app`
  (`com.projectman.engine-app`, distinct from the PM-1088 app). It signs every embedded Mach-O
  before the bundle, with hardened runtime and Node JIT entitlements, notarizes and staples
  the app, then produces `projectman-motor.zip`, a signed/notarized/stapled
  `projectman-motor.dmg` (app plus Applications link), and the hashed `projectman-motor.json`.
  The manifest schema also validates the fixture consumed by future Swift updater tests.
  `scripts/engine-app/{publish,release-config}.ts` adds `engine-app publish --tag --config`
  after `publish_release`: resolves the remote tag, checks the GitHub release, builds both
  artifacts under one heavy lock from that commit, and uploads zip, DMG, manifest in order.
  The strict configuration contains only signing/keychain names and Team ID. The total
  deadline is 45 minutes. Existing assets are downloaded and SHA-256 checked; conflicts
  refuse replacement. A complete manifest-backed release is verified without rebuilding.
  This runs on the release Mac with its owner's `gh` login; remote engines only download
  the result, with no server/engine boundary change (PM-1126).
  The CLI takes the machine's heavy-run queue. All scratch/cache files, tool temporary files
  and diagnostics stay under `--out`; existing nonempty output is refused.
  **Machine assumptions:** release Mac, full Xcode, arm64 target, macOS 13+ runtime,
  `swift`, `ditto`, `codesign`, `xcrun notarytool/stapler`, `hdiutil`, `spctl`, a Developer ID
  identity and a notary profile in the release user's keychain. Only their names and the public
  Team ID are arguments. `--ad-hoc` skips hardened runtime (native modules have no Team ID),
  notarization, DMG signing and Gatekeeper assessment;
  its empty Team ID disables app updates. **Remote engine:** this build runs only on the
  release machine; the resulting app/package runs on the engine Mac. Nothing new crosses the
  server/engine boundary. Real signing/notarization is checked at the owner's first release
  (PM-1123); automated checks use a fake process runner. **PM-1156:** the same `build --ad-hoc` runs on the
  GitHub `macos-15` runner (the `engine-app` compute job) and takes the Swift sources and the Info.plist
  template from the runner's checkout of the same commit. The Mac then needs no build: `npm run engine-app --
fetch --commit <sha> --out <new dir> [--open]` (`scripts/engine-app/fetch.ts`) downloads the run's artifact
  (manifest and zip only; the disk image is not an output, PM-1157) with the Mac's own `gh` login (read access to the repository's Actions, gh 2.49 or newer for the attestation),
  verifies it and unpacks it with `ditto` and `codesign --verify`, and `--open` starts the app with `open`; the
  app then installs itself through its own release switch. This runs on the Mac the app goes to, a remote
  engine's too; nothing crosses the server/engine boundary. **Module:** `scripts`, `deploy`.

- **Interrupted card continuation (PM-1092)** — `runtime/sessions/sessions.ts` closes lost live
  sessions with `server_restart` during startup or engine reconciliation; the internal `session_ended`
  event carries the previous state: only `starting`, `working` and `waiting_permission` turns continue;
  completed idle turns and `waiting_input` sessions awaiting an answer stay stopped. `runtime/admission/hand-over.ts`
  resumes their current work-stage assignee or review-stage owner through normal admission. The
  persisted `hand_over.resumeMember` keeps the same member while capacity, pauses or an offline engine
  hold the continuation; a changed stage or assignment invalidates it. **Machine assumptions:** the
  existing provider transcript on the session's engine supplies the resumed conversation. **Remote
  engine:** the hub stores and retries the continuation; the existing session-start RPC runs the CLI
  on the engine after it reconnects. No new transport or shared filesystem is required.

- **Keep awake while working (PM-1086)** — `engine-host/keep-awake.ts` (`createKeepAwake`,
  `spawnKeepAwakeProcess`), wired in `engine-app.ts` to its 1 s poll; `engine-handlers.ts` `activeRuns()`
  counts the merge-check and screenshot runs; `engine.json` `keepAwake` and `npm run engine -- keep-awake
on|off`. While a session, a merge check or a screenshot run is active the engine holds
  `/usr/bin/caffeinate -i -s -w <engine pid>` and lets go two minutes after the last one ended (a crashed
  `caffeinate` is started again at most once a minute). **Machine assumptions:** macOS only (other
  platforms report `unsupported`; a Linux `systemd-inhibit` is not built); `-i`/`-s` keep the system awake
  on mains power, the display may sleep, and a Mac on battery with the lid closed sleeps anyway; `-w` ends
  `caffeinate` with the engine even after a SIGKILL. **Remote engine:** everything runs on the engine's own
  machine and nothing crosses the server/engine boundary; `hello` and the RPC are unchanged.

- **Link-headers file and the working-folder check (PM-1077)** — `scripts/engine/commands.ts` (`init
--link-headers-file <path>`), `EngineHost.workspaceState(path)` (`contracts/engine.ts`; local:
  `engine-host/local-host.ts`, remote: `engine-link/remote/host.ts`), `NewProjectEngines.workspaceState`
  (`runtime/sessions/new-project-engines.ts`) and `ProjectService.create` (`core/projects/projects.ts`).
  **Machine assumptions:** `init --link-headers-file` runs on the engine's own machine, resolves the path
  against the working directory, requires an existing regular file and writes its real path into that
  machine's `engine.json` (`linkHeadersFile`; the file itself, mode 0600, is checked at engine start and never
  read by `init`). The folder check asks the engine's `host.is_directory`, which the engine answers only within
  its own roots (`path_outside_roots` in `engine-limit.ts`). **Remote engine:** both run on the engine; the
  `not_held` state is made on the hub from that existing refusal (a path the engine does not hold yet, e.g. an
  owner's folder before `project set`), so the hub never looks at the owner's disk and the wire method and the
  engine limit are unchanged, which keeps an older engine working. A project created that way waits with
  `engine_offline` until the engine reports it, after `project set` and a restart (`service install`).

- **Member queue driver (PM-925)** — `apps/server/src/runtime/member-queue/` (driver, message lane), the sweep in
  the kernel's sweep list (`DomainOptions.memberQueueSweepMs`), `member_queue_items` with the wait columns
  (migration 99). It wakes members from their queue through `admission.start`. **Machine assumptions:** none of its
  own; it runs in the server process and reads only the database. **Remote engine:** the driver, the sweep and the
  database run on the hub; the session start crosses the server/engine boundary as it did, and an offline engine
  becomes the item's wait (`engine_offline`), retried by the sweep.
  **Start lane and workspace yielding (PM-927):** known-member deferred starts live in the queue;
  their specifications are rebuilt and retried through admission. `runtime/sessions/workspaces.ts`
  also stops a holder idle for two minutes when its card has no open item and its member's queue
  needs another card. The hub decides from persisted session and queue state; the existing session
  RPC stops the process on its engine, whose workspace manager still refuses dirty checkouts.
  No new path, process or transport assumption is introduced.
  **No Operator lane (PM-1045):** the Operator lane and its reminder are gone; the driver starts no session
  for the Operator and the queue puts no item on it. Machine work waits as an open inbox item for the connected
  client, with the PM-1003 sweep escalating it to the owner when no owner has a live super key
  (`integratorSideAvailable`). Nothing new crosses the boundary.

- **Startup sweep of crash leftovers (PM-837)** — when the engine host is created (the server in local mode,
  the engine process in hybrid mode) two one-shot background sweeps remove what a crash left behind, each
  logging a warning on failure and never throwing: `sweepStaleChecks` (`engine-host/merge-check.ts`, called by
  `createLocalEngine`) over the direct children of `<worktreesRoot>/_merge` named like a merge id, and
  `sweepStaleRunDirs` (`full-test/sandbox.ts`, called by `createFullTestExecutor`) over the direct children of
  `os.tmpdir()` and `SHORT_ROOT` named `pmft-<up to 8 alphanumerics>` (full test and screenshot runs). Only
  entries older than `STALE_LEFTOVER_MS` (24 h by mtime, `contracts/engine.ts`) go; links are judged by `lstat`
  and never followed (a `_merge` link is unlinked, a `pmft-*` link is left); a `pmft-*` directory must also be
  owned by the engine's uid. The git worktree entry of a removed check is pruned by the next `releaseCheck`.
  **Machine assumptions:** the engine's local temp and worktrees roots, the shared `/tmp` (`/private/tmp` on
  macOS), which another instance of the same user may use (hence the uid and age checks), and POSIX `getuid`.
  **Remote engine:** the same code runs on the engine over its own directories; the cloud takes no part and
  nothing crosses the server/engine boundary.

- **One-shot external commands (PM-903)** — `apps/server/src/exec/` runs short commands through
  execa without a shell, preserving the supplied environment and final newlines. Timeouts,
  cancellation and output limits send SIGTERM, followed by SIGKILL after a fixed 5-second grace
  period. It waits for the child to exit; it does not create process groups or replace session
  and test process guards, and does not add parent-exit cleanup. **Machine assumptions:** POSIX
  signals and executables available on the supplied `PATH`. **Remote engine:** supported; the
  helper runs wherever its caller lives: worktree and merge git on the engine, configuration git
  and gh on the server. Later slices use it for engine probes, copies and trust, server version
  checks and supervisor service control (PM-911). Host scripts now use the helper for migration
  git/tar, the administration builder's commit check and work-root move commands
  (`scripts/migrate/{git,apply,package}.ts`,
  `scripts/engine/move-work-root.ts`, PM-912). No new data crosses the
  server/engine boundary; the change on each host is SIGKILL escalation after the grace period.

- **Local history embeddings (PM-767)** — `apps/server/src/history-semantic/**` (module `history-semantic`, engine
  layer, sealed), `db/history-semantic.ts` and migration 95, `services/history/service.ts` (the search phases),
  `apps/server/scripts/prepare-history-model.mjs` with `models/history-model.json` (the pinned model, fetched once
  and hash-checked at build time, never at run time). The semantic part of `search_history` is a worker thread of
  the server process: it owns the Xenova/multilingual-e5-small q8 model (`@huggingface/transformers`, ONNX Runtime
  with one thread) and the `sqlite-vec` extension, and has its own WAL connection of the database file
  (`openAuxiliaryDatabase`). The vectors are derived data in plain tables (`history_semantic_*`, in the journal's
  unjournaled list), rebuilt from `history_documents`; the search is an exact brute-force cosine scan, no
  `vec0` table. **Machine assumptions:** a database file path that a second connection of the same process can open
  (no `:memory:`); about 350 MiB of native memory beside the heap (2 GB machine target); the model files next to
  the bundle (`dist/models/history`) with a build that has the native binaries for the platform; no network at
  run time (`allowRemoteModels=false`). A standby copy never starts it. **Remote engine:** nothing runs on the
  engine. The history, its index and the search belong to the server/hub that holds the database, so the worker
  runs there (the cloud image carries the model, `deploy/cloud/Dockerfile`); no embedding, text or vector crosses
  the server/engine boundary. A failure of the worker, the model or the extension only leaves the word search
  (statuses in the private search log, never in a tool reply). **Release measurement (PM-910):**
  `deploy/cloud/history-semantic-profile.mjs` (docs/HYBRID.md "History semantic profile") runs the built server in
  fresh processes on a Linux ARM64 machine in a cgroup v2 with `memory.max` up to 2 GiB, no swap and no network,
  reading `/proc/<pid>/status`, the cgroup's `memory.*` files and `/proc/net/tcp*`; the server starts through
  `src/start.ts` (`index.ts` is its one-line entry) and the measurement's bundle `dist/history-semantic-profile.js`
  adds a loopback search listener with a one-time secret that `dist/index.js` never loads. It runs where the model,
  the database and the worker run, on the server machine, and nothing of it crosses the server/engine boundary.
  The cloud stays `PROJECTMAN_HISTORY_SEMANTIC=off` until a report passes.

- **Web push sender (PM-815, PM-827)** — `apps/server/src/services/web-push`, the
  `contracts/web-push.ts` transport and the personal `web_push_*` tables run on the server/hub.
  The P-256 installation key is atomically created under `PROJECTMAN_HOME/secrets/web-push.json`
  (directory 0700, file 0600), included in the cloud restic backup. Delivery requires outbound HTTPS
  to the allowlisted browser push providers (Google, Mozilla, Apple and Windows); redirects are
  not followed. Visibility is held per authenticated WebSocket connection in hub memory.
  Standby copies never create keys or send; cloud restore rehearsals additionally set
  `PROJECTMAN_WEB_PUSH_ENABLED=0`. A request to the instance host (PM-1064, `notifyHost`) is pushed
  to the host directly, not through an inbox item: the payload carries only the request title and a
  link to the host's own first project. **Remote engine:** fully supported; nothing runs on the
  engine and no new data crosses the server/engine boundary.

- **ntfy phone channel (PM-901)** — `apps/server/src/services/ntfy`, `contracts/ntfy.ts` and the personal
  `ntfy_channels` table run on the server/hub. The web push service takes the decisions (category, quiet hours,
  presence, claim, digest) and hands the same ones to the channel through the `PhoneChannel` contract; the channel
  is delivered once per user and item, also to a user without a browser device. Delivery is an outbound HTTPS POST
  (ntfy JSON API) from the hub to `https://ntfy.sh` or to the user's own ntfy server: a public DNS name without
  port or credentials, and the connection refuses any private, loopback or link-local address. Redirects are not
  followed and the answer is not read. The topic (128 random bits, made by the server) is the only secret on a public
  server: it sits in `ntfy_channels`, is shown only to its owner and never goes to a log or an error. The message
  is generic (no item title, project or card key); its link is the `Origin` of the page that saved the channel.
  Standby copies and `PROJECTMAN_WEB_PUSH_ENABLED=0` do not send. **Remote engine:** fully supported; nothing runs
  on the engine and no new data crosses the server/engine boundary. A self-hosted ntfy instance on the cloud
  machine would be an outbound call to that machine's public name.

- **Durable super-mode handoff and owner-bound operations (PM-762, Super mode 6/10)** —
  The app principal also belongs to the selected project manager (PM-1041): its server-issued `member`
  binds the actor to that member's own general session and open owner request. Project commands use
  the shared operation path under the owner's authority; machine and other unlisted command kinds
  are refused with `command_not_for_project_manager` and handed off through `open_integrator_todo`.
  Owner-reserved effects still wait for the owner's own login. App principals stay on the server;
  this adds no machine dependency or remote-engine boundary. Since PM-1045 the app principal has only the
  project manager branch: the app's Operator session is gone, so nothing issues an Operator principal;
  the super-key path (`superActorOf`) is unchanged.
  `services/super-operator/handoffs.ts` (`SuperHandoffService`), `db/super-handoffs.ts` (migration 83:
  `super_handoffs`, `super_operations`), `packages/shared/src/{api/super-handoff,config/super-command}.ts`,
  `core/inbox/inbox.ts` (the owner's-own-login rule, the relay) and the route `routes.relayOwnerAnswer`. The
  owner's integrator (a super token, `super_operate`) or the in-app project manager (`execute_operation`) starts a
  command with a request id; the stored handoffs of the retired base-Operator request are no longer created or
  listed. A command with a deletion, security or cost effect waits for the owner's own login
  to answer a bound question (24 hours; the question names the command hash, the config version and the token). The
  service and its state are on the hub only. **Machine assumptions:** none of its own — it holds no path, process,
  socket or account; the executors it calls (the Operator operations, member, invite and merge services, and the
  application services) carry their own. **Remote engine:** the operations and owner answer stay on the hub. After a restart of the hub
  an operation that was running is marked `unknown` and never started again by itself.
  The `operate` executor (PM-831, `services/super-operator/operate.ts`, wired in `assembly.ts`) runs
  `message_send`, `project_pause`, `project_resume` and `session_stop` as the key's super actor on the same
  domain services the base Operator uses; the other operations fail with `super_operation_unsupported` (PM-832).
  It runs on the hub only, so no machine-dependent part changes. A label change in super mode (PM-831) may also
  use the key owner's holding: `planLabelsOrThrow` takes the owner from the authenticated scope and passes it to
  `planLabelChange` as `authority`; owner-reserved labels stay refused.

- **Super-mode operations and diagnostics (PM-1113)** — `services/super-operator/{facade,diagnostics}.ts`
  exposes application operations and bounded project-record queries. The retired machine
  supervisor adds no runtime or remote-engine requirement; the owner's integrator handles machine work.

- **Project change journal (PM-761)** — `apps/server/src/db/change-triggers.ts`,
  `apps/server/src/db/project-change-events.ts`, `apps/server/src/core/base/change-journal.ts`,
  `apps/server/src/api/project-events.ts`, the engine fan-out in
  `apps/server/src/runtime/sessions/engine-registry.ts`. The journal is a table in the hub's
  `db.sqlite` that the hub's own transactions write, and the long-polling read is a hub HTTP route.
  **Machine assumption:** one hub database and one hub process (the in-memory wake and the safety poll
  live in it); `project_change_generation` is bound to that database file. **Remote engine:** nothing
  runs on the engine and no journal data crosses to it: the engine's state reaches the hub through the
  engine link and the cloud registry, which is in the hub's database, so the registry's write and its
  `engine` entries are one hub transaction (the cloud composition, the engine link and the registry
  keep their inventory entries); the readers talk to the hub only. In hybrid and cloud placement the
  journal lives on the hub with the database that backup and restore carry, so a restored database
  needs a new generation (see "Project change journal", `docs/AWS.md`, `docs/HYBRID.md`).

- **Private Operator knowledge (PM-687)** — `apps/server/src/config/operator-knowledge-store.ts`,
  injected by `app.ts` through `assembly.ts` as `OperatorKnowledgeStore`. Stores the approved
  agreement (summary, involvement and extra-critical steps), up to 20 approved learned principles
  (example, principle and effect), and each member's enumerated conversational preferences in
  `<server home>/operator-data/<projectKey>/knowledge.json` and `preferences/<handle>.json`.
  These records are outside the public repository and the customization git history. PM-688 adds
  a session-bound personal preference MCP writer and authenticated REST reads. PM-1021 also
  allows the selected PM to read/write its current direct owner's five style fields in an
  internal general conversation, sharing the Operator document and CAS. PM-689 adds
  owner-approved agreement/principle CAS and marker recovery under the server's configuration
  lock; the store remains private. PM-1043 (PM-1023 K4): the selected PM now leads the agreement,
  the principles and the setup checklist: it reads the project knowledge and proposes changes
  (`propose_operator_knowledge`, without recommended operations) in its internal general
  conversation, and the checklist notices go to its queue; the store, its path and the owner's
  approval are unchanged, and the PM reaches the store only through the server (a remote engine
  needs nothing new). PM-1046 (PM-1023 K7) adds the global Operator's own instance target,
  `<server home>/operator-data/_instance/knowledge.json` (`readInstanceKnowledge`,
  `compareAndSwapInstanceKnowledge`): the same format, revision and error codes, one document for the
  whole server; `_instance` is no valid project key, so it never collides with a project. It is reached
  only through the external MCP's super tools (below); the Operator runs on the owner's machine and the
  document stays in the server's home. Missing documents start at revision zero; invalid documents are refused
  without overwriting. **Machine assumption:** one server process owns a private writable home,
  with POSIX directory/file permissions (0700/0600), no-follow file opens and same-directory atomic
  rename. Target-file CAS writes are serialized within that process, including multiple store
  instances. A synced temporary file is renamed only after the full JSON is written.
  The shared `contracts/sandbox.ts` `sensitivePaths` app-home list denies the entire `operator-data`
  root to member file tools and the existing session-policy/provider consumers; no separate
  provider rule or new permission is added.
  **Remote engine:** storage stays on the server, with no file mount on an engine. Context/MCP
  services send the current person's five preference enums to authorized Operator/PM contexts
  and MCP calls (PM-688, PM-1021), or the filtered shared
  revision/agreement/principles to internal Operator/PM contexts and authorized MCP reads
  (PM-689), across the existing boundary. Markers never enter context. No new engine file or
  machine assumption is introduced.

- **Cloud provisioning from the owner's machine (PM-532)** — `scripts/cloud/*` (`npm run cloud`),
  `deploy/aws/`, `docs/AWS.md`, `apps/server/test/cloud-*.test.ts`.
  PM-1186 enables versioning on the restic backup bucket after installing 30-day noncurrent-version
  expiration and expired-delete-marker cleanup; the Litestream database bucket stays unversioned.
  PM-674's [rollback sheet](CLOUD-CUTOVER.md) preserves the final stopped-cloud data before
  Mac single activation. Credentials stay on the administration machine, outside member sessions.
  PM-1116 retired the one-off move commands (`seed` with its PM-717 integrity gate, `dns plan|import|verify|switch`);
  the last commit that has them is `358bb7c7` on `main`, tagged `retired-migrate-dns`. A tool the owner runs on their Mac
  that creates and maintains the cloud board on AWS EC2: `preflight` and `aws` (PM-534: the machine,
  the security group, the two S3 buckets, the two IAM users and their access keys), the machine part
  (PM-535, the next entry), Cloudflare (PM-536, the entry after it) and DNS (PM-537,
  `scripts/cloud/dns.ts`: `dns status` only, public delegation/DS through Cloudflare and Google DoH,
  Route 53 Domains registration status in `us-east-1`, and `up` orchestration; the delegation switch and
  its rollback are retired, there is no tool-driven delegation rollback). It calls the `aws` CLI v2 with argv (profile and
  region from the configuration, no SDK) through the injected `CloudDeps`, never a shell. Machine
  assumptions: the `aws` CLI v2 with explicit profiles on the owner's Mac (PM-664: central resources
  in `aroom`, registrar/retained Route 53 source reads in `i` through `route53.profile`; absent:
  `aws.profile`), later `ssh`/`scp`, and the secrets
  store `~/.config/projectman/cloud/` (directory 700, files 600, symbolic links and wider modes refused;
  `config.json`, `cloudflare-token`, `cloud.env`), which sits under `~/.config/projectman`, a path the AI
  sessions' sandboxes deny. No state file: resources are found by name/ownership tags. **Remote engine:** nothing runs on
  an engine; this is the owner's tool and the cloud machine it provisions is the server side. The
  `cloud.env` it writes is what the container of "Cloud deployment and backup" reads.
  PM-1197 (part of PM-1193): `github-deploy-setup [--dry-run]` (`scripts/cloud/github-deploy-setup.ts`) creates, once, the
  AWS side of the GitHub deploy (the OIDC provider `token.actions.githubusercontent.com` and the role
  `projectman-cloud-deploy`: trust by `aud` and by the `cloud-production` environment's `sub`, SSM/EIC rights on the one
  machine only) and, through `gh`, the repository's `cloud-production` environment with its three variables. It is
  idempotent and `--dry-run` changes nothing. **Machine assumption:** the owner's/integrator's `aws` profile with the IAM
  setup rights (docs/AWS.md) and a `gh` login with admin rights on the repository; the command is a live change, run only
  after the owner's yes. **Remote engine:** none; it runs on the administration machine.
  **Module:** `scripts`

- **EC2 provisioning and account boundary (PM-676, part of PM-664)** — `scripts/cloud/{config,aws,aws-cli,ec2,commands}.ts`,
  `deploy/aws/{config.example.json,ec2-bootstrap.sh}`, `apps/server/test/cloud-ec2.test.ts`,
  `apps/server/test/helpers/fake-ec2.ts`, `docs/AWS.md`. **What runs where:** owner-only AWS CLI v2
  on the Mac reads STS identity and provisions one Ubuntu 24.04 HVM/EBS EC2 instance in the
  configured central profile/region, existing VPC/public subnet, dedicated empty-inbound security
  group, EC2-only SSM host role/profile, and the shared private S3/backup-user resources. EC2 type,
  AMI and encrypted gp3 volume size are explicit, never paid defaults. Catalogue/preflight checks
  Canonical image ownership and exactly one persistent root EBS mapping (ephemeral AMI mappings
  are accepted), VPC/subnet/account, DNS, effective IGW route, conservative IPv4 NACL
  reachability and type support/AZ offering. Public IPv4 is outbound access for apt/Docker/SSM/tunnel;
  no NAT/LB/extra host, no public ingress. IMDSv2/hop-limit 1, termination protection and shutdown=stop.
  **Machine assumptions:** owner logins `aroom`/`i`, AWS CLI, selected existing internet network,
  Ubuntu apt/snap/systemd; public bootstrap installs sshd/EIC/SSM with no secret or board payload.
  The script prints instance/EBS/IPv4 cost components before launch; the owner records regional
  rates and approves execution. The newly created security group is read/validated with bounded
  propagation waits before launch; launch-time group/profile propagation retries keep the same token.
  Names/managed tags and a deterministic public-request ClientToken
  recover partial runs/restarts; ambiguity, foreign ownership or dangerous drift refuses creation,
  with no automatic destructive repair. `--dry-run` writes nothing. **Remote engine:** provisioning
  remains on the owner's machine for the central server, never on an engine; the Mac engine gets
  no AWS credentials, and no new server/engine RPC or payload crosses the boundary. SSH over SSM
  host operation is provided by PM-677 (next entry); EC2 is the only compute (PM-1036).
  PM-718 adds explicit `aws.ec2.architecture`, arm64 only since PM-1116: the Canonical
  AMI name/Architecture, type capabilities and existing instance must agree, and the machine needs an
  external image bundle (`deployment.imageBundle` is required). The approved PM-675 target is
  Frankfurt/t4g.micro/Ubuntu 24.04 arm64/20 GiB gp3; creation still requires concrete owner approval.

- **EC2 host administration through SSM (PM-677, part of PM-664)** —
  `scripts/cloud/{ec2-host,host,machine,commands,deps}.ts`, `apps/server/test/{cloud-ec2-host,cloud-deps}.test.ts`,
  `apps/server/test/helpers/fake-ec2-host.ts`, `apps/server/test/fixtures/fake-cloud-process.mjs`,
  `docs/AWS.md`, `docs/HYBRID.md`. **What runs where:** on the owner/integrator's POSIX machine,
  AWS CLI v2 with the explicit central profile/region (`aroom`), session-manager-plugin, ssh,
  ssh-keygen and tar; on EC2 Ubuntu 24.04, sshd/EIC/SSM and the existing sudo `host.sh`, Docker and
  systemd. `withHost` dispatches by compute; the unchanged `HostSession` contract and stdin/stream
  payloads use an instance id for EC2's address. Lookup requires a unique managed running instance
  and exact Online SSM target. A fixed, instance-scoped `AWS-RunShellScript` reads only the ed25519
  public host key (bounded 120-second poll, strict text/binary key validation, no raw failure output).
  Temporary 700 directory/600 key and known_hosts pin that authenticated key with strict SSH checking.
  EIC receives only the ephemeral public key for `ubuntu`/actual AZ immediately before each SSH
  connection; ProxyCommand uses validated, quoted AWS `AWS-StartSSHSession`, port 22. Cloud env/tar
  stay inside SSH encryption, never in SSM command/UserData/argv. There is no ingress mutation,
  public-SSH fallback, TOFU or imported permanent key. **Machine assumptions:** the caller has
  DescribeInstances, SSM lookup/RunCommand/start/describe/terminate-session and EIC caller rights;
  EC2 agents/tunnel connect outbound. POSIX process groups close SSH/AWS/plugin descendants even
  with inherited output, timeout or interrupt; pipe ends carry an additive AbortSignal. Cleanup
  reads all active-session pages before termination and matches the exact instance plus a set of
  random public reasons, unique per connection. It obtains at least three complete snapshots
  2s apart and a fresh empty verification after termination, within a 30s total AWS-phase deadline
  including the 5s process shutdown grace. It removes key files/handlers independently of AWS
  failures. Failed verification reports the public target/reasons, preserves the operation error
  and exits 1; the observation window is not an AWS consistency guarantee.
  Existing host paths, container uid 10001, loopback networking and one-writer/restore guards stay
  the same. **Remote engine:** this runs only on the owner's administration machine for the central
  server; no AWS credentials or new RPC/payload crosses the server/engine boundary. It works
  independently of the Mac engine link. Live execution/recovery remains an approved owner round.
  PM-1197: the same host operation also runs on a GitHub-hosted `ubuntu-24.04` runner
  (`scripts/cloud/runner-deploy.ts`, `npm run cloud -- runner-deploy`): the AWS CLI authenticates with the ambient
  OIDC session of the workflow (no `--profile`; `AwsCli` has an `ambient` mode), session-manager-plugin is installed
  by the workflow at a pinned version and checksum, and the host calls are the same `host.sh` subcommands, plus
  `env-check` (names only) and `prune-images`. `cloud.env` is never sent from the runner; the host's own
  `/etc/projectman/cloud.env` is checked. **Remote engine:** no AWS credentials cross the server/engine boundary; the
  runner holds a one-hour role session of its own.
  PM-748 adds fault tolerance to the same transport (`scripts/cloud/{ec2-host,host,errors}.ts`): a second
  fixed read-only `AWS-RunShellScript` reads `Ec2HostDiagnostics` (CPU count, 1-minute load, available
  memory, free disk, cumulative OOM kills, EIC status-124 journal count of the last 10 minutes) on EC2;
  nothing else leaves it. On the admin machine, `status` and a connection probe retry at most 3 times
  (5 s, 15 s; 120 s total including child shutdown) with a fresh EIC key each; state changes and
  tar/secret streams are never repeated and a lost answer raises `CloudTransportError` with
  `commandStarted: 'unknown'`. The first state change of a session waits (same bound) for a not-busy
  machine (`load1 <= 2 x CPUs`, `>= 128 MiB` available) and refuses otherwise. **Remote engine:** all
  AWS/EIC/SSM calls stay on the admin machine, the measuring commands run on EC2; the engine gets no
  AWS credential and only measurement metadata crosses the admin–cloud boundary. Related task: PM-748.
  PM-753 narrows its key-refusal match: stderr merges the ssh client's lines with the remote command's, so
  for a state-changing command only a stderr that is the client's single `user@host: Permission denied
(publickey...)` line (plus `Warning:`/SSM session noise) means `commandStarted: 'no'`; any other output
  that mentions it stays `unknown`, not retryable. Reads keep the loose match. **Remote engine:** unchanged,
  admin machine only. Related task: PM-753.
  PM-1029 removes the completed PM-675 trial commands and their embedded host program.
  Host administration no longer needs Python3 or provides trial archival/deletion operations.
  **Remote engine:** the remaining host operations still run on EC2 through SSH/SSM from the
  administration machine; no engine RPC or new machine assumption is added.
  PM-718 adds `receive-image` on the same encrypted stdin stream: only the arm64
  Docker tar crosses to EC2. Root-only temporary storage, bounded size, SHA-256, free disk, sole tag,
  config digest/platform/revision/version checks precede import; image inspect verifies the result.
  Only strict imageId/platform/revision JSON returns. Docker load output stays on stderr. No registry
  or credentials cross this boundary, and no container or DB starts during import.
  Ubuntu util-linux `flock` serializes import/start through the root-only
  `/var/lib/projectman/.image.lock`; current/previous immutable IDs are never dangling-image pruned.
  PM-725 also serializes bootstrap under this lock. On the Ubuntu host, `host.sh` installs `jq`
  before Docker dependencies, then atomically sets `/etc/docker/daemon.json`
  `features.containerd-snapshotter=false` (root:root, 0644), preserving unrelated settings and
  refusing malformed JSON, symlinks and non-regular configuration files. Actual `docker info`
  must report `Driver=overlay2` without the containerd snapshotter marker in `DriverStatus`.
  An existing unsupported store needs a Docker restart, allowed only with a provably stopped board
  and no current/previous deploy history; unavailable or malformed daemon information fails closed.
  A running classic daemon is not restarted. The result is verified; import/start repeat the
  store check under the lock before side effects and retain strict config-digest image IDs.
  Switching stores hides the old images/containers, so the approved bundle must be imported again;
  bootstrap neither migrates nor deletes old store data and leaves the bind-mounted board data intact.
  **Remote engine:** configuration, apt, restart and store checks run only on the central Ubuntu
  host over the existing SSH/SSM channel. No new payload, credential or engine RPC is introduced.

- **The cloud machine and its operation (PM-535, PM-718, PM-725; EC2 is the only compute since PM-1036)** —
  `scripts/cloud/{host,machine,images}.ts`,
  `deploy/aws/{host.sh,projectman-cloud.service}`, `apps/server/test/{cloud-host,cloud-machine,deploy-aws}.test.ts`,
  `apps/server/test/helpers/fake-host.ts`. PM-718's `deployment.imageBundle` (required since PM-1116; the
  host build is gone): import precedes env/start. History carries imageId/platform; status adds
  actual container imageId. Prebuilt start uses an immutable ID; health and rollback check/carry it
  and the source SHA. Digestless starts/rollback are refused, as is a non-arm64 record. Operations stay on the
  admin machine/target host, independent of remote engines.
  PM-725 applies the same explicit `/etc/docker/daemon.json` classic-store setting, stopped-board
  and empty-history restart guard, actual-daemon checks and required bundle reimport described
  in the EC2 host channel entry above. This is an Ubuntu-host assumption; Docker Desktop and
  remote engine configuration are unchanged.
  The commands `deploy`, `rollback`, `status`, `logs`, `ssh`,
  `stop`, `start`, `rehearse` and `pull-data` of `npm run cloud`. **What runs where:** on the
  Mac `ssh` (and `git ls-remote`, `tar`, the `aws` CLI); on the Ubuntu machine, as root through
  `sudo bash -c '<host.sh>' host.sh <subcommand>` (the script travels as the `-c` argument, so the
  standard input carries the payload: the unit file, `cloud.env`, a tar stream), Docker, git, `jq`
  and systemd. The unit `projectman-cloud.service` runs `docker run` of the image
  `projectman-cloud:<commit id>` with `/etc/projectman/cloud.env` and only `/var/lib/projectman/data`
  mounted; it publishes no port (the Cloudflare tunnel connects outwards), uses no host network, no
  extra privilege and no Docker socket (`deploy-aws.test.ts` checks it). State on the machine:
  `/etc/projectman/{cloud.env,image.env}`, `/var/lib/projectman/{data,deploy.json}` (`current`,
  `previous`, `lastStoppedAt`). **Machine assumptions:** the
  machine is Ubuntu 24.04 with `apt`, `systemd` and Docker from the distribution; the owner's Mac has
  `ssh` and reaches the machine through SSM with an ephemeral key (the EC2 host channel entry above;
  no inbound rule, no public-address lookup). The machine builds nothing; it imports the bundle's image. The released
  image is tagged with the full commit id, which is also `PROJECTMAN_VERSION`. **Does this work on a
  remote engine?** Nothing in it runs on an engine: it is the owner's own tool for the server side, and
  the engine neither calls nor depends on it. The entries "Cloud provisioning" and "Cloud deployment
  and backup" are the other parts of the same chain.

- **The Cloudflare side of the cloud board (PM-536)** — `scripts/cloud/cloudflare{,-api,-publish,-check}.ts`,
  the `guard-check` subcommand of `deploy/aws/host.sh`, `deploy/cloudflare/check.sh`,
  `apps/server/test/cloud-cloudflare*.test.ts`, `apps/server/test/helpers/fake-cloudflare.ts`. The commands
  `edge`, `publish`, `check` and the Cloudflare part of `preflight` of `npm run cloud`: they call the
  Cloudflare API v4 over HTTPS with the owner's own API token (`CloudflareApi`: one `fetch` through the
  injected `CloudDeps`, a read-only mode for `--dry-run`, retry on 429) and make the zone, its edge
  settings, a header transform rule, the One-time PIN provider, the two service tokens, the Access
  policies and applications, the tunnel with its ingress, `TUNNEL_TOKEN` in `cloud.env`, and last the
  proxied CNAME. `check` runs `check.sh` (`cloudflared` and `curl` on the Mac), the three engine doors
  and `deploy/cloud/smoke.sh`. **Machine assumptions:** the commands run on the owner's Mac; the token
  file `cloudflare-token` and the two service token files (`engine-access-token.json`,
  `integrator-access-token.json`) are in the secrets store `~/.config/projectman/cloud/` (mode 600, a path
  the AI sessions' sandboxes deny); the owner has done `cloudflared access login` for `check`. Secrets
  never go into an argument: the service token secrets and the login file travel in the environment of
  the child process, and the output masks them. **Does this work on a remote engine?** Nothing here runs
  on an engine and no engine holds the API token. What crosses the boundary: `cloud.env` to the machine
  (by `deploy`), `guard-check` over the machine's SSH connection (it asks the container's own guard), and
  `engine-access-token.json`, which is the engine's `linkHeadersFile` content (HYBRID.md) and is put on an
  engine by the owner.
  **Further owners (PM-1065):** each `access.owners` entry gets its own engine and integrator service
  token and policies (`<tunnel>-owner-<id>-…`) and its own two files under `owners/<id>/` in the same
  secrets store (folder 700, files 600; the host's token, policy and file never change). `edge` adds the
  policies to the engine and integrator applications and removes only a left owner's objects (policies,
  then tokens, then files). `check` tries each owner's pair from the host's copy of the files. Machine
  assumption: the same host Mac and store. Remote engine: still nothing runs on it; an owner's engine
  gets its file by hand from the host, outside projectman.
  **Separate machine entrance (PM-675):** optional explicit `cloudflare.integratorHostname`, required
  with a public integrator service token, has its own Service Auth application and audience on the same
  tunnel. Only literal `/api/...` and exact `/mcp` reach the hub on that host. `edge` writes
  `PROJECTMAN_INTEGRATOR_HOSTNAME`; `publish` verifies the running backend's `integratorHostIsolated`
  result before making its DNS record, including during private staging. `check` tests both machine
  audiences and deliberately sends a valid human cookie to the machine host (401). The CLI still runs
  on the admin machine and sends credentials only through protected files/environments. The Mac engine's
  `/engine`, key and outbound connection are unchanged; no new engine operation or inbound port exists.
  **Public board (PM-672):** with `access.boardMode: public` the same commands leave the main hostname
  without Access (one Bypass policy), keep `/engine` behind its own Access application (the engine service
  token only; the tunnel's `originRequest.access` for `/engine` names only that application's audience),
  answer `/hooks` and `/mcp` with 404 at the tunnel, and write `PROJECTMAN_PUBLIC_BOARD=1` into `cloud.env`
  (the server then refuses to start without cloud mode, an owner and the e-mail login:
  `apps/server/src/auth/public-board.ts`). `host.sh public-check <hostname>` is a second subcommand run over
  the same SSH connection as `guard-check`: it asks the running container for its own anonymous answers.
  `publish` creates the DNS record only on the exact answer, `check` runs `check.sh` with `BOARD_MODE=public`
  (no `cloudflared` login). **Remote engine:** unchanged; the public side is only the browser login boundary,
  the engine still connects outward to the protected `/engine`.

- **SES identity/DKIM and sender provisioning (PM-678, part of PM-664; own account PM-729)** —
  `scripts/cloud/{ses,config,commands,cli,secrets,aws-cli,cloudflare-api}.ts`,
  `deploy/aws/config.example.json`, `apps/server/test/cloud-ses.test.ts`,
  `apps/server/test/helpers/fake-ses.ts`, `docs/AWS.md`, `docs/HYBRID.md`.
  **What runs where:** the owner's approved provisioning CLI adds optional version-1
  `ses:{profile?,region,domain,from}`; PM-729 adds the optional `profile` (absent: `aws.profile`, resolved
  at load time without rewriting the file), so SES (identity, production access, the narrow sender IAM
  user and its key) can live in its own account (`i`) while compute/S3/host IAM stay in `aws.profile`.
  `ses plan` reads STS, SESv2 identity/account and Cloudflare DNS;
  `ses configure [--dry-run]` additionally verifies managed IAM ownership/groups/policies/keys,
  creates or retains the Easy DKIM domain, converges only three DNS-only CNAMEs from AWS tokens and
  SigningHostedZone, restricts `<instanceName>-ses` to `ses:SendEmail` on the region/account/domain
  identity with an exact `ses:FromAddress`, and writes the dedicated credential/env flags.
  Unknown/inactive/extra keys, foreign user state or conflicting mail DNS are refused, with no
  automatic rotation; partial operations are rediscovered, a lost key response needs owner repair.
  `ses request-production [--dry-run]` is a separately approved transactional invited-customer OTP
  request, not configure/up side effect; acceptance of the request is not production approval.
  `ses check` reads verification/DKIM, production/sending, exact DNS/IAM and local sender config;
  no command sends mail. With the optional `ses.inbound.replyDomain` (PM-945) the same `ses-send` policy
  also carries `ses:SendEmail` on the configuration set and the SQS read on one queue; `ses configure` and
  `ses check` keep that extended policy when it is already in place. Cloudflare list responses are shape-checked so malformed reads cannot
  be mistaken for missing records. **Machine assumptions:** AWS CLI v2/profiles on the owner's
  POSIX administration machine; every AWS call explicitly targets `ses.profile` and the SES region,
  and the key is handed over only through the protected `cloud.env` (no profile env, the backend sends
  directly with the target account's narrow key; a key of a former account is refused, not replaced).
  Existing authoritative Cloudflare zone and protected
  DNS token, no domain transfer or cross-account SES authorization. The cloud store is 0700 and
  `cloud.env` 0600, with unsafe modes/symlinks refused and other env keys preserved; credentials
  never enter argv or reports. Live configuration/request/deploy each needs owner approval;
  sending cost appears in the preview. **Remote engine:** nothing runs on the Mac engine and it
  gets no SES/AWS key. Only the existing approved deploy channel carries cloud.env to the central
  backend (PM-669); no server/engine RPC or credential boundary change. AI sandbox protection of
  `~/.aws` and the cloud store remains in force.

- **The e-mail login code mailer on AWS SES (PM-669)** —
  `apps/server/src/services/email-login/{ses-mailer,config}.ts` (facade `index.ts`),
  `apps/server/src/contracts/email-login.ts`, the six `PROJECTMAN_EMAIL_LOGIN_ENABLED` / `PROJECTMAN_SES_*`
  variables (read in `apps/server/src/index.ts` only, then immediately removed from `process.env`
  before the application version lookup can start a git child process),
  `deploy/cloud/entrypoint.sh`, `docs/AWS.md` ("The e-mail login code mailer"). **What it does:**
  `createSesEmailCodeMailer` sends one Hungarian message (the text is `emailLoginCode` in
  `packages/templates/src/locales`) through the SES v2 `SendEmail` operation with explicit keys and an
  endpoint pinned to the region; no `AWS_*` variable, profile or credential chain is read. It keeps no
  state and logs no address or code; a provider failure is a sanitized `EmailCodeDeliveryError`. The
  login itself (PM-670, the next entry) is its consumer through `BuildAppOptions.emailCodeMailer`.
  **Machine assumptions:** the keys are lines of the owner's `cloud.env` (the secrets store of the entry
  "Cloud provisioning"), which `deploy` sends to the machine; inside the container the entrypoint gives
  `PROJECTMAN_*` to the server process only, the restore rehearsal switches the mailer off, and the runner's
  child environment drops every `PROJECTMAN_` name. **Does this work on a remote engine?** Yes: sending and
  the keys live only in the cloud board; the engine, its link and its protocol do not change, and a
  disconnected engine does not stop the mail.

- **The e-mail login of invited clients (PM-670, part of PM-664)** —
  `apps/server/src/auth/email-login-routes.ts` (`POST /api/auth/email/request` and `/verify`, public),
  `apps/server/src/services/email-login/login-service.ts` (codes, limits, redemption),
  `apps/server/src/core/members/client-standing.ts` (who is eligible; accepts the open client
  invitations), `apps/server/src/db/email-login.ts` (tables `email_login_codes`, `email_login_events`,
  migration 60), `auth/secret.ts` (`deriveEmailLoginKey`). **What it does:** a person who is a client and
  nothing else (a client account or an open client invitation, not the host owner, no other access in any
  project) gets a six-digit code by mail and redeems it for a session; a first redemption creates a
  passwordless account and accepts every open client invitation of the address. Addresses, client IPs
  and codes are stored only as HMAC-SHA-256 hashes; the key is derived (HKDF, own label) from the
  `secret` file, so a copied database alone cannot be tested against guessed addresses. All limits count
  durable rows, so a restart does not reset them. **Machine assumptions:** the client address comes from
  `PROJECTMAN_CLIENT_IP_HEADER` (a trusted loopback proxy sets it; without it every client counts as
  `127.0.0.1` and shares the IP limits). For this service, `kernel/local-request.ts`'s `ipRateLimitKey`
  groups IPv6 addresses by canonical /64 and keeps IPv4 addresses whole, including mapped IPv4 (PM-703);
  other limiters retain their existing keys. The `secret` file in the home and the SQLite database
  are also local assumptions. **Password codes (PM-946):** `POST /api/auth/password/request` and
  `/password/reset` (public, same file) use the same table, the same limits and the same constant 202
  answer. A code is bound to its purpose by the HMAC label (`password-code` against `code`), so a
  password code never logs in and a login code never sets a password; an address has one live code, and
  a new one of either purpose replaces the other. Only an existing client account (never the host owner,
  an owner account or a colleague) gets the letter; a good code replaces the password and deletes every
  session of the account before the new session starts. No new machine assumption. **Does this
  work on a remote engine?** Yes: everything runs in the cloud board (hub); no engine request is made,
  and no engine protocol or payload changes.

- **E-mail channel sender (SES) (PM-941)** —
  `apps/server/src/services/email-channel/{service,ses-sender,render,config}.ts`,
  `apps/server/src/mcp/email-channel/`, `apps/server/src/api/email-channel.ts`,
  `apps/server/src/auth/secret.ts` (`deriveEmailReplyKey`). **What it does:** an enabled AI member sends a
  filtered, rate-limited e-mail to a consenting human, immediately or after owner approval; the hub stores
  only a hash of the reply token. From: the member's mailbox on the reply domain, falling back to
  `PROJECTMAN_SES_FROM` (a mailbox conflict, or the provider refusing the address). **Machine assumptions:** the hub reads `PROJECTMAN_EMAIL_CHANNEL_ENABLED`,
  `PROJECTMAN_SES_*`, `PROJECTMAN_EMAIL_*` from `cloud.env` in `index.ts`, deletes them before starting a
  child process, and makes the outgoing HTTPS call to the region's SES v2 endpoint with explicit keys.
  **Does this work on a remote engine?** Yes: sending, filtering, approval and token generation all run on
  the hub; an engine receives no AWS credentials, no SES request and no protocol change.

- **E-mail channel inbound (SES receiving → SNS → SQS) (PM-945)** —
  `apps/server/src/services/email-channel/sqs-source.ts` (reader, `createAwsSqsClient`), its wiring in
  `apps/server/src/assembly.ts`, `scripts/cloud/{ses-receive,ses,config,commands}.ts`,
  `deploy/aws/config.example.json`, `apps/server/test/cloud-ses-receive.test.ts`,
  `apps/server/test/helpers/fake-ses.ts`, `docs/AWS.md` ("Receiving e-mail replies"). **What it does:** SES
  receives the replies on the reply subdomain and publishes them (and the bounce, complaint and delivery
  events of the configuration set) to an SNS topic; an SQS queue with a dead-letter queue holds them; the
  hub's reader long-polls the queue and hands each mail or event to the e-mail channel (PM-943), deleting
  the message only when it was handled. `ses receive-plan|receive-configure [--dry-run]|receive-check` of the
  provisioning CLI create and verify the MX record, the reply identity, the topic, queues, subscription,
  configuration set, receipt rule set and the extension of the sender's IAM policy (the SQS read on one queue
  and `ses:SendEmail` on the configuration set and from member addresses on the reply domain identity,
  PM-1016). **Machine assumptions:** the hub makes outgoing HTTPS calls
  to the region's SQS endpoint with the existing `PROJECTMAN_SES_*` key and reads
  `PROJECTMAN_EMAIL_QUEUE_URL`, `PROJECTMAN_EMAIL_REPLY_DOMAIN`, `PROJECTMAN_EMAIL_CONFIGURATION_SET` from
  `cloud.env` (read in `index.ts` only); the CLI runs on the owner's POSIX administration machine with AWS CLI
  v2 profiles and the Cloudflare DNS token, like the SES provisioning entry. **Does this work on a remote
  engine?** Yes: the reader runs on the hub only; an engine gets no queue, no key and no protocol change.
  **Member addresses (PM-989, PM-1039):** the same receipt rule also takes mail to `<handle>@<reply domain>`, the
  address of an AI member (`services/email-channel/inbound.ts`, `receiveDirect`; the local part is always the
  handle, there is no separate mailbox name: `ai.email.mailbox` was removed, the config migration
  `dropEmailMailbox` and DB migration 123 delete it from old data, and a differing old name simply ceases,
  with no alias; the handle is not globally unique, so two projects with the same handle and e-mail on
  leave both without an address, `addressConflict`). The mail lands in the member's conversation as a
  reply linked by MIME headers when answering a member's mail (PM-1018), otherwise as a direct
  team message, and its attachments go through the message-attachments storage on the hub, so nothing new
  crosses to an engine. **Rename (PM-1025):** the address changes only by renaming the member, and becomes
  `<new handle>@<reply domain>` (it is refused with `email_mailbox_taken` when that mailbox is another
  member's). Mail to the old address still arrives: `emailMailboxOwners` also matches the `formerHandles`
  of an AI member, so the old name resolves to the same member; a live holder of the same name does not
  win over it but shares it, and the existing shared-name branch parks the mail. The old name stays reserved
  in every project (`emailMailboxReserved`): no e-mail switch-on or rename may take it.
  No new boundary: it is the same hub-only rule.

- **Feedback widget public entrance and screenshot store (PM-506, PM-508)** —
  `apps/server/src/services/feedback/{service,screenshots,notices,widget}.ts`, `apps/server/src/api/feedback.ts`,
  `PROJECTMAN_FEEDBACK_PUBLIC_URL` (read in `apps/server/src/index.ts` only), the table family
  `feedback_*` and `PROJECTMAN_HOME/feedback/`. The app side (this card) is cookie authenticated and
  runs on the server; the public entrance for the tool on customer pages (a later card) will be an
  internet-facing address of the server, whose origin and launch codes are bound to the surface. The
  screenshots (originals and WebP thumbnails, made with `sharp`) are files in the server's home next to
  the database and the attachments; the card's copy goes through the attachment service. The settings
  view shows the public address and the sessions the tool holds. Assumes one server host for the
  database, the screenshot files and the public entrance. **Remote engine:** everything runs on the
  server; an engine needs nothing from it and receives a mark's screenshot only as the card's
  attachment, over the existing attachment transfer. The processing (PM-512) runs on the server too: the
  wake-up message to the project manager (`services/feedback/notices.ts`) is an ordinary stored team message,
  and the feedback team tools (`mcp/feedback/`) are answered by the server.
  `get_feedback { mark_id }` hands the stored screenshot's absolute path (`FeedbackScreenshotStore.locate`) only
  to a session whose engine is the local one (`getFeedbackMark`); a session on a remote engine gets none
  and reads the image as the card's attachment (`read_attachment`, PM-315) after
  `create_task_from_feedback`. In the hybrid mode the `feedback` folder is carried
  with the other data (`HYBRID_CLOUD_ENTRIES`) and the public entrance belongs to the cloud server.

  **The public widget API (PM-509)** — `apps/server/src/api/feedback-widget.ts`,
  `apps/server/src/services/feedback/widget.ts`, routes `routes.feedbackWidgetScript()`
  (`/feedback/widget.js`) and `routes.feedbackWidgetApi()` (`/feedback/api/v1`). Outside `/api`, so
  its own guard applies: an `onRequest` hook checks the `Origin` (the address of some project's
  surface, else 403 `feedback_origin_not_allowed`), answers the CORS preflight (no credentials,
  `no-store`, `Vary: Origin`) and checks the bearer session on every request (401
  `feedback_session_invalid`), all before the body is read. `POST /sessions` swaps a single-use launch
  code for a session (30 days sliding, 90 days at most; token kept as a hash); marks, comments, the
  list (`?since` cursor) and the read mark are limited per session and hour (30 marks, 120 comments,
  in memory) and per project and day (500 marks, from the database), answering 429 with `Retry-After`.
  The widget sees only its surface's marks and never the environment, screenshot or forward reason.
  `/feedback` is a server prefix, so an unknown path there is a JSON 404, not the web app. The script is
  `apps/feedback-widget/dist/widget.js` under the install directory (`feedbackWidgetFile` in
  `index.ts`; 404 until it is built, a later card). The caller is a browser on the customer's page and
  the public address of the server (`PROJECTMAN_FEEDBACK_PUBLIC_URL`) is the only machine assumption.
  **Remote engine:** nothing runs on an engine; the API, its sessions and limits live on the server, and
  the engine is not involved. Security notes: `docs/SECURITY.md` "The feedback tool's public API".
  **Module:** `services/feedback`

- **Single-mode recovery service (PM-1113)** — `scripts/live/`, `npm run live -- install|status|uninstall`.
  Keeps the `com.projectman.live` LaunchAgent for the [cutover rollback](CLOUD-CUTOVER.md).
  It pauses, stops, installs and verifies the compiled single-mode server; no watcher, journal,
  git remote or automatic publication remains. **Assumptions:** macOS launchd and a built checkout
  on the recovery host. **Remote engine:** this runs on the recovery host only, outside engine RPC.

- **Feedback widget public entrance (PM-506)** — the hostname without Access for the marking widget on
  customer pages (PM-513). Code: `PROJECTMAN_FEEDBACK_PUBLIC_URL` checked at start in
  `apps/server/src/index.ts` (`parseFeedbackPublicUrl`; a wrong value stops the server), the host guard
  `apps/server/src/http/feedback-host-guard.ts` (an `onRequest` hook registered first in `app.ts`; on the
  public `Host` it answers the unknown-route 404 to every raw path except `/feedback/widget.js` and
  `/feedback/api/v1/<segments of [A-Za-z0-9_-]>`), `PASSED_VARIABLES` in `scripts/live/plist.ts` (the
  LaunchAgent gives the server only the variables named there),
  `deploy/cloudflare/config.example.yml` (two rules for the hostname: `^/feedback/` to `127.0.0.1:4800`,
  then a 404 rule) and `deploy/cloudflare/check.sh` (`FEEDBACK_ORIGIN`). Machine assumption: the tunnel
  (`cloudflared`) runs on the server's machine and forwards to its loopback port with the original `Host`
  (no `httpHostHeader`), which the guard reads; the Cloudflare account and the DNS record are outside the
  repository. The hybrid cloud image uses a token-managed tunnel, with the variable given by whoever
  installs it (`docs/HYBRID.md`); on EC2 `npm run cloud -- edge` sets the tunnel, the ingress and the
  variable through the Cloudflare API (PM-536). **Remote engine:** the entrance belongs to the server
  (in the hybrid mode, the cloud one); an engine receives no such traffic and needs nothing from it.
  Security notes: `docs/SECURITY.md` "The widget's public hostname".
  **Module:** `http`

- **Full test trial CLI (PM-386, PM-490)** — `scripts/full-test/cli.ts` runs a command in the current
  checkout through `createFullTestExecutor`, `fullTestSandbox` and `defaultHeavyLockDir`. It reports
  outcome, elapsed time, failed files and output tail. It needs macOS Seatbelt, srt, PTY support and
  the machine's heavy-run queue; run it outside member sandboxes, which cannot start nested Seatbelt.
  The checkout and common git directory are readable; the user/app homes are denied except those
  paths. `PROJECTMAN_FULL_TEST_SANDBOX=1` marks the command for tests that cannot run there.
  **Remote engine:** run the CLI on the engine machine with its checkout, git directory, sandbox
  dependencies and queue. Only the command and result need to cross the existing full-test boundary.
  `scripts/merge-test/{run,scope,impact,shared-impact,runtime-entries}.ts` (PM-657, PM-843, PM-864) selects checks in that detached checkout using
  argv-based git first-parent diff (`--no-renames -z`) and batched blob reads of both revisions.
  It uses the architecture module map, never evaluates old TypeScript or writes a selection cache,
  and retains the configured worker limits. Server contracts/config, changed tests/snapshots, helpers
  and script code use the server/script graph. The audited `RUNTIME_ENTRIES` table supplies runtime
  edges; unknown launchers stay uncertain, filesystem imports alone do not. Fixtures, setup and
  non-code support changes retain full server checks. `--dry-run [<commit>]` reads the named merge's
  trees without a checkout and only prints the scope and commands. Cloud-only infrastructure diffs under `scripts/cloud/`,
  `deploy/aws/` and `deploy/cloud/` (PM-734), optionally with direct cloud/deploy/release test-family
  changes, run server typecheck and the cloud, deploy, release, architecture and merge-test test
  prefixes. Manifest, lockfile, TypeScript/Vitest configuration, selector/executor scripts and non-code
  scripts retain full checks; test-only diffs select the changed tests. **Remote engine:** selection runs on the engine with
  its two git trees; no engine files or new selection API cross the server/engine boundary.
  **Module:** `scripts`

- **Provider and engine outage watch (PM-449)** — `runtime/watchers` (`WorkOutages`), `runner/runner.ts`
  (`providerStatus`). Every 30 seconds the server checks the used providers' login
  (`claude auth status`, `codex login status`, `--version`, Gemini login and the NanoGPT key)
  and engine connectivity. Checks run concurrently, with a 20-second limit and no overlapping
  rounds. The CLI and its login must live on the machine that runs the sessions.
  The bounded status wait runs on the server in `runtime/watchers/provider-status-wait.ts`
  (Effect, PM-617).
  **Remote engine:** checks use the existing `provider.status` RPC, including `refresh`;
  connectivity comes from the server's engine registry. No new engine code is needed.
  For NanoGPT the cloud's key store decides whether the key is there (PM-736).
  A remote engine that has not connected since server startup gets the same 120-second
  grace as a disconnected link; existing alerts stay open until recovery is confirmed.
  Reconnection releases waiting work even if publishing the outage update fails.
  Each project gets a `work_outage` owner alert with affected members and waiting tasks;
  confirmed recovery resolves it with `outage_ended` and retries deferred work. Unknown
  checks preserve the last confirmed outage. Acknowledgement suppresses repeats for the
  episode; open alerts and their original start times are adopted after restart.
  PM-1061: an engine of another owner (see "Engine link and machine keys") affects only the projects bound to it;
  the alert, its inbox items and its targets are built per project, so only that project's members hear of an
  outage of that engine, and the engine's own owner sees its status in the engine list. Nothing changes on the engine.
  **Module:** `runtime/watchers`

- **Engine link and machine keys** — `engine-link/{protocol,methods,rpc,event-buffer,index,version}.ts`,
  `runtime/sessions` (`EngineRegistry`), `db/engines.ts`, `api/engines.ts` (PM-313).
  PM-791 adds `engine-link/remote/hub.ts` `awaitLink`: readiness is recorded only after connect
  hooks finish. A bounded merge wait survives the registry's 120-second offline transition;
  disconnect clears readiness and an abort signal or hub close ends the wait. `stopWaiting` only
  ends the RPC relay waits, leaving merge waits to their signals during domain shutdown. This runs on the
  cloud and needs only the remote engine's existing authenticated link, with no local path assumption.
  PM-698 adds optional `hello.processScope`, running-session `scopeId`, exit `cleanup` and
  `scope_recovered`. All scope inspection and signals stay on the owning engine; only generation
  identifiers and cleanup results cross the boundary. Protocol version stays 1; update the hub first.
  Engines connect outward to `/engine/link` with a bearer machine key; the cloud stores only
  its SHA-256 hash and display prefix. Remote requests require HTTPS; forwarded protocol headers
  are trusted only from a loopback reverse proxy. Plain sockets are restricted to local requests.
  Human cookies and integrator keys do not authenticate this
  socket; machine keys grant no human API access. The method table is the sole RPC gateway,
  validated in both directions and tied to the engine contracts, including the PM-312 disk operations.
  PM-1059 adds no method, parameter or event and keeps protocol version 1: which engine a call goes to is
  decided by the cloud before the call (`EngineDirectory.projectEngine`, `hostEngine`, a session's recorded
  engine), see "Cloud composition". PM-1060 keeps that: the project's engine comes from the cloud's
  `project_engines` binding; nothing changes on the engine.
  PM-1061 isolates the owners' engines on the hub (protocol unchanged, no new wire code): `engine-link/remote/guard.ts`
  classifies every method as open, project-bound or host-only, exhaustively at compile time, and `RemoteHub.call`
  refuses a project-bound call to an engine the project is not bound to (`engine_not_bound`) and a machine
  call to any engine but `EngineRegistry.hostEngine()` (`engine_not_host`, the default engine only
  when the host owner owns it). The other way round, the engine handlers answer a session request only when the
  session is recorded on that engine and its project is bound to it, and `mcp.relay` refuses a token of a project
  the engine is not bound to. `GET /api/engines/status` lists the engines of the viewer's own projects and their own;
  `GET /api/engines` lists every engine to the host owner and the owned ones to another owner, hiding the hostname
  and last address from everyone but the engine's owner and the host owner; `engine_changed` reaches the host owner,
  the engine's owner and the members of the projects that use it (the rules are `canSeeEngine` and
  `canSeeEngineMachine` in `packages/shared`). A remote engine of another owner therefore needs nothing more than
  its link; what it may be sent is decided on the hub.
  PM-1062 adds the owner account (protocol unchanged): the host owner invites an owner by an e-mail link
  (`owner_invitations`, migration 118; a 7-day single-use token stored as a SHA-256 hash, public and
  attempt-limited `GET`/`POST /api/owner-invites/:token[/accept]`); acceptance grants `owner_accounts` and starts
  a session. An owner account creates and revokes its own engines (`canCreateEngine`, `canManageEngine`), but
  the machine default stays the host owner's. The host owner revokes the account
  (`POST /api/owner-accounts/:userId/revoke`, own login only): the account is marked, its projects the host has
  no seat in are paused, its engines and integrator keys are revoked; the login and the data stay. The folder
  check of a new project runs on the engine the creator chose (`NewProjectEngines.workspaceState(engineId, path)`,
  PM-1077: `directory`, `missing` or `not_held`), which then becomes the project's default binding. It needs
  nothing new on a remote engine: `host.is_directory` already exists, and a folder outside the engine's roots
  (`path_outside_roots`) is `not_held`, which does not refuse the project.
  File export forwards `exactRoot` when the caller requires a root without symbolic links.
  PM-739 adds `workspace.publishTaskBranch` (`[key, taskKey, branch, commit]` → strict `{path, ref}`):
  the engine hands a developer's task commit over to its own repository; the cloud never names a path
  or ref, `engine-limit.ts` binds the repository and requires a full object id. Protocol version stays
  1; an older engine answers `unknown_method` and the call fails with an update message, so update the
  engines before the hybrid hand-over is used.
  Events are acknowledged after handling; request results are not kept after they are sent (PM-1116).
  `secret.nanogpt_key` is never logged; the starting-session condition is enforced by the PM-315 handler, unavailable by default.
  `bootId` identifies a process start; `instanceTag` still identifies the engine home. Disconnects
  immediately remove the live link, but status stays online for 120 seconds. Registry and key
  management run only in cloud engine mode; single mode exposes an empty status list.
  PM-789 heartbeat: the cloud pings every 20 s (`ENGINE_HEARTBEAT_MS`) and counts the pings without
  an answer; every decoded frame and every pong is a sign of life (`lastHeard`, `unanswered = 0`).
  It drops the link (close 4400, cause `heartbeat`) only when nothing was heard for
  `ENGINE_DEAD_AFTER_MS` (90 s) **and** `ENGINE_DEAD_AFTER_PINGS` (3) pings went unanswered, so a
  loaded engine that pongs late, or a cloud whose event loop stalled (no ping went out), does not
  lose a live link. The engine's watchdog reports `link_silent` only after two consecutive ticks
  with pending events and more than 90 s of silence. Both sides log `engine link: connected` and
  `engine link: disconnected` at info level (code and cause; never the key or URL). Protocol version
  stays 1 and the wire is unchanged: an old engine with a new cloud is tolerated for 90 s (the old
  engine reconnects after 45 s when events wait). A new engine judges the link by silence only once
  it has seen the cloud repeat an acknowledgement (an `ack` equal to the highest sequence of the
  connection, the welcome's included; a cloud that never repeats one is quiet when idle, so an idle
  link to an old cloud is left alone instead of reconnecting every few minutes).
  **Remote engine:** the socket, event buffer and method dispatch run on the engine beside its
  CLIs and files; the registry, auth, idempotency store and human websocket broadcasts stay in the
  cloud. Non-JSON/large data uses purpose-scoped uploads (PM-315), with only a hash and size in
  RPC results. `PROJECTMAN_VERSION` overrides the version on both hosts; otherwise
  `resolveAppVersion` reads the installation checkout's git HEAD, falling back to `dev`.
  The override must match `[A-Za-z0-9._+-]{1,64}`. This assumes a git checkout when no override is
  supplied; packaged cloud and engine builds should set the same version explicitly.
  `resolveAppTag` (`engine-link/version.ts`, PM-541, PM-542) reads the release tag on the same checkout's HEAD
  (`git tag --points-at HEAD`, first tag matching `RELEASE_TAG_PATTERN`; `createAppTagReader` remembers only a found
  tag, because publication may happen after deployment). It reads the installation's own git checkout, so it runs
  on the server's machine and never on a remote engine; without git, on a timeout (2 s) or with a
  `PROJECTMAN_VERSION` override (a cloud package has no checkout) the tag is null.
  PM-731: JSON turns a trailing `undefined` into `null`, so `workspace.findTaskBranch` accepts
  `string | null | undefined` as its third element and the handler gets `undefined` (no other input
  is loosened). An `invalid_params` answer names the method and the failing parameter paths (never
  the values), `path_outside_roots` the refused path; an unrecognised handler exception still
  answers `internal / Engine request failed` and only its method and class name reach the local
  log (`onFailed`), on both sides. An engine older than this change rejects the `null`: update the
  engine with the cloud.
  Existing inventory boundaries use these groups:
  - Session processes, trust, sandbox and terminal: `session.*`, `terminal.*`, `term`, runner events.
  - Codex project layer inspection: `session.assert_workspace_config`.
  - NanoGPT secret delivery: `secret.nanogpt_key`; the hub's secret store and HTTP usage remain in cloud.
    An engine with its own key file (PM-1068) reads it locally, never asks for the hub's key, and announces
    that with `nanogptKey: 'engine'` in its hello; the key value never crosses the link.
  - Dependencies and task/member workspaces: `worktree.*`, `workspace.*` (including uploaded bundles).
  - Session output folders: `folders.*`; canonical paths and preparation: `host.*`.
  - Screenshots, scenario paths and image lists: `screenshots.*`, `files.resolve_scenario`, `files.list_images`.
  - Attachments: `files.export`, `files.materialize`; transcripts/resume: `transcript.*`.
  - Machine metrics and process attribution: `machine.*` and `hello.instanceTag/pid/uid`.
  - Hook decisions and team tools: `permission.*`, `mcp.relay` (integrator credentials stay in cloud).
  - Free-disk admission: `host.free_disk`; idle heavy-run protection: `host.heavy_run_sessions`;
    CLI login/plan usage: `provider.status`, `usage.plan`.
  - Full tests and their local heavy-run queue: `full_test.run`, `full_test.cancel`, and the engine's
    `full_test_started` event when the run got its turn in the queue (PM-489). PM-790 adds
    `full_test.attach {runId}` in `engine-link/{methods,engine-handlers}.ts`: attachments wait for
    an active run or read its retained result. The engine keeps completed results in memory for
    60 minutes, at most 32, pruning on run/attach calls and completion without a timer. Cancel and
    final disposal forget records; link closure leaves the executor and records alive. Only run ids
    and strict full-test results cross the boundary. Protocol version stays 1; an older engine
    answers `unknown_method`. PM-876 adds `full_test.report {runId}`: the engine reads the bounded
    `MergeTestReport` (scope, workers seen, step timings; no output) from the retained record, and the
    host asks for it after `run`/`attach`. The `report` is cut from the `run`/`attach` answers, so
    older hubs and engines keep their strict schemas; an older engine answers `unknown_method`, which
    leaves the report unknown (null), never an error.
  - Member initiated merges: `merge.*` (PM-451, see [services/merges](modules/services-merges.md)), including `merge.read_file` and `merge.commit_files` (PM-494, the Operator's documents; PM-784: also the integrator's document write through the bearer MCP, same calls, started by the hub with no member session), and the read-only `merge.list_paths` and `merge.changed_paths` (PM-595, file names only).
    The cloud history copy also consumes `merge.read_file` and `merge.is_ancestor` (PM-744, PM-788):
    `services/history/document-sync.ts`, adapted to `EngineDirectory` in `assembly.ts`, reads the fixed
    `docs/DECISIONS.md` and `docs/LESSONS.md` paths at one commit and publishes them atomically to cloud SQLite.
    `task_merged` and published `write_project_docs` trigger commit reads without fetching; startup,
    configuration changes and a ten-minute poll read the head, retrying each minute while pending, stale or unavailable.
    Git, repository paths and credentials stay on the Operator's selected engine (or the actually registered local
    engine when there is no Operator); cloud has no hidden local repository fallback. Only project/repository,
    fixed paths and base/commit leave cloud; a commit and two bounded UTF-8 texts return. `engine-host/merge-repo.ts`
    serializes upstream fetches per repository across document reads and merge preparation in one engine process.
    With the engine offline, the last received text remains searchable with a stale indication; it is not claimed
    current (owner, 2026-10-18). Database history remains searchable independently of document refresh failures.
  - Administrative control socket: cloud-owned control, with `session.pause/force_pause/release/stop` to engines.
  - Engine shutdown pause (PM-1159): the hub's database holds it, as an `engine`-scope pause (`pauses.engine_id`) and its
    rows; the engine only runs `session.pause`/`session.force_pause` for it and calls `engine.pause_for_shutdown`
    (engine → hub) before it stops. The hub resumes it when the engine connects (after `reconcileEngine`); on a hub
    restart a session of an engine that is not connected yet is handed to that engine's pause. Which sessions hold a
    heavy command comes from `EngineHost.heavyRunSessions` (the engine's heavy-run queue folder). Nothing else crosses.
  - Offline machine and the question screening (PM-708): the durable queue, the timer and the
    delivery receipt all run on the server. A screened question that waits for the PM's engine stays
    in the inbox with `payload.screening.queue` (`engine_offline`); it raises no owner alert, no
    `screening_skipped` and no human fallback. The ten minutes start from the receipt
    (`deliveredAt`) and run only while the engine is online (`screeningDeadline`,
    `screeningFrozenRemainingMs` in `packages/shared`). The server learns the link state from
    `EngineRegistry` and `engines.last_seen_at` (`lastConfirmedOnlineAt`, through the
    `ScreeningEngineState` port in `assembly.ts`); the sweep also runs on each `engines.onChange`.
    The Mac only holds the existing engine link, and the CLIs and their login stay there. No new
    process, shell, socket or credential operation, no new table. Remote engine: works unchanged,
    since only the link state crosses the boundary. Signals and team messages already queue on
    `engine_offline` (`releaseForEngine`, `retryDeferredStarts`). Real Mac, sleep and network
    trials belong to PM-664.
    Integrator todo handoff (PM-782, `core/inbox/inbox.ts`, assembly maintenance) has no clock since
    PM-885 and PM-938: since PM-1003, machine work handed off by the Operator stays in the integrator inbox;
    only owner-reserved work is passed to the owners (`integrator_passed_on`). The sweep gives integrator
    work to the owners only when no Operator exists (`integrator_unavailable`); on leave or with AI off it
    waits for the Operator or super side. The hub alone persists and publishes the handoff;
    no engine operation or credential crosses the boundary. PM-801 puts the integrator's fix-limit
    decisions on the same sweep (`planIntegratorInboxEscalation`): hub-side only.
    Machine access (decision 66, PM-1073): `AiMemberConfig.machineAccess` (shown as "Külső teendő (MCP)") lets an
    AI member put machine todos in the owners' integrator queue. The rule is `machineAccessOf` /
    `machineTodoIssuerAllowed` in `packages/shared/src/config/machine-access.ts`: an absent value follows the
    role (the selected, non-temp project manager has it, nobody else; no migration), the system and the Operator
    member issue as before. Only an owner changes it (`ownerOnlyChanges` `machine_access`); a role change pins
    the effective value. `open_integrator_todo` is listed only to such members (`ToolAudience.capabilities`) and
    the handler decides (`machine_access_required`); screening refuses the integrator recipient with
    `no_machine_access`. Hub-side only: no engine operation, credential or process is added.
    PM-712 applies the same server-owned queue and receipt pattern to suspected loops:
    `runtime/watchers/loop-watch.ts` stores generation, assessment and the remaining ten-minute
    online budget in `task_loops.triage_json`; `services/coordination/loop-triage.ts` sends a
    report-only `loop_suspected` signal to the selected PM, even when it participates in the loop.
    The engine link state freezes the deadline while offline, and reconnect sweeps resume it.
    Queued delivery alone never creates an owner decision. No new engine operation or CLI mount.
    Before reporting, assessing or falling back to the existing human loop decision, the watcher
    re-reads the task, timeline work and branch head through `SessionOrchestrator.sourceHead`.
    The existing engine git read runs beside the repository; only commit/time facts cross the
    boundary. A null/offline head never proves progress. Queue, deduplication and assessment stay
    on the server and work unchanged with a remote engine.
    **Module:** `engine-link`

- **Engine process** — `engine-app.ts`, `engine-link/{engine-client,engine-handlers,engine-limit,engine-audit,engine-config,engine-status,engine-transfer}.ts`,
  `scripts/engine/{cli,commands,move-work-root}.ts`, `index.ts` (`engineMain`), `app.ts` (`parseMode`) (PM-314).
  `engine.json` has an optional `workRoot` (PM-846, see "Work volume (PM-846)"); engine mode does not read
  `PROJECTMAN_WORK_ROOT`.
  Entry points import the named exports of `engine-link/index.ts` (PM-649); the
  implementations above and their machine assumptions remain unchanged.
  `PROJECTMAN_MODE=engine` (`npm run engine -- start`) runs the machine-dependent parts on the Mac
  beside the CLIs and connects outward to the cloud's `/engine/link` with its machine key. There is
  no database, no `/api`, no web app and no control socket; only `index.ts` reads the environment.
  The engine guards the sandbox boundary itself (PM-1176): `engine-app.ts` hands the runner an `engineGuard`
  (absent in single mode), and `runner/session.ts` refuses, at PreToolUse, a Claude file-writing tool outside the
  session's write zone and a read under `deniedPaths`, a Gemini edit outside it, and an allow carrying
  `updatedInput`, whatever the cloud decided; the zone comes from the session's own policy on this machine
  (`runner/tool-decision.ts`, `engineWriteZone`). Each refusal is a `tool.guard` line (`refused`, the code
  `outside_writable_roots`, `denied_path` or `updated_input`) in `logs/engine-audit.jsonl` and a `refused` event
  with `by: engine_guard` to the cloud. The hub's strict frame schema needs the hub deployed before the engine.
  PM-1187: `engine.json` `allowedProviders` is the engine's own provider list (`engine-limit.ts` refuses a
  `session.start` for another provider with `provider_not_allowed`; absent: all), and the same rule refuses a
  Codex/NanoGPT writer in the `default` mode (`permission_mode_too_low`). The runner refuses every Codex/NanoGPT
  `PermissionRequest` but an MCP tool in the engine process (`escalation_refused`, capability
  `sandboxEscalation`), so the cloud cannot approve a run outside the Codex sandbox.
  Stopping (PM-1159): `pauseForShutdown` asks the cloud first (`engine.pause_for_shutdown`, engine → cloud), which
  records the pause and resumes it at the engine's next connection; the engine pauses its sessions itself only when the
  cloud cannot take the call (`link_down`, `unknown_method` from an older cloud, timeout), and then nothing is recorded.
  Files, all under the engine's home (`PROJECTMAN_HOME`, default `~/.projectman`): `engine.json`
  (cloud address, engine id, project workspaces, registered repos with their full-test command and the
  optional `mergeBranch` (the one branch the cloud may merge into and push; absent: every `merge.*` call
  is refused with `merge_not_allowed`), the highest permission mode, whether the cloud may type into a terminal), `engine.key` (the machine key,
  mode 0600; a looser mode, another owner or a link is refused at start-up), an optional link-headers
  file (0600; `authorization` is never taken from it), `engine-status.json` (what `status` shows: no
  secret; PM-1086 adds the optional `work` counts (sessions, merge checks, screenshot runs) and `keepAwake`
  (`mode`, `holding`, `since`, `unsupported`), and `engine.json` the optional `keepAwake` mode,
  `while_working` when absent; PM-1087 adds the optional `version` (as in the hello), `releaseTag` (the git tag
  of the checkout, read once at start-up with a 2 s limit) and, per running session, `member`, `provider`, `label`
  (the display name) and `startedAt`, which the engine remembers from `session.start` until the runner's exit;
  no prompt, token or path), `logs/engine-audit.jsonl` (one line per request: method, session id, outcome and refusal
  code, never a prompt, message, terminal input, file content, token or key; rotated at 10 MB, five
  files kept) and `attachments-cache/` (downloaded attachments, checked against size and sha256; a task
  session may read its card's folder there, which `engine-limit.ts` allows as a read-only sandbox root
  and never as a working directory, PM-667).
  The engine listens on `127.0.0.1:4801` only (`PROJECTMAN_ENGINE_PORT`): the CLIs' permission and
  other hooks, and `POST /mcp/<token>`, which it forwards to the cloud as `mcp.relay` and answers 503
  while the link is down. Every request is checked against a local limit (`engine-limit.ts`) before
  it runs, whatever the cloud asks: working directories, writable and readable roots, worktree and
  workspace paths, the repos and full-test commands in `engine.json`, the highest permission mode, no
  full-access sandbox, a closed set of environment variables, terminal input, and which processes
  `machine.signal` may stop (a process of a running session, never the engine itself or pid 1).
  The engine's own secrets are never reachable from a session: the machine key and the link-headers
  file are in every sandbox's `denyRead` and `denyWrite` and in a policy's `deniedPaths`, and
  `engine.json` and `engine-status.json` are in `denyWrite`. For that, `resolveEngineConfig` refuses a
  key file, a headers file or a home that lies inside a workspace, the temporary directory or the
  engine's own worktrees, after `realpath`, and the engine refuses to run (`home_in_use`) in a home that
  holds `db.sqlite*`: give it its own, for example `PROJECTMAN_HOME=~/.projectman-engine`. The one
  exception is a home whose `instance.json` says `engine` (PM-318, the Mac after the move to the hybrid
  mode, [HYBRID.md](HYBRID.md)): its stale single-machine database and secrets stay there for the way
  back, and the sandboxes' `sensitivePaths` already put `db.sqlite*`, `secret`, `secrets` and the other
  server data of the home in `denyRead`; `instanceMayWork('engine')` is false, so no server ever runs on it. Every
  `session.start` needs a policy (the denied paths and roots come from it), and each path in it (the
  placement, readable, writable and read-only roots, the session folders, a review copy's directories)
  must lie under the engine's roots; a task worktree's `gitDir` must be a registered repo's `.git` and its
  `worktreeGitDir` a folder under that `.git/worktrees`. `/tmp/claude-<uid>` is no root a sandbox may
  name. File transfers do
  not follow redirects, so the extra link headers (a service token) never leave the cloud's address.
  Only `hello` tells the cloud about the machine: version, host name, platform, the registered
  projects and repos (with whether a full-test command exists), providers, running sessions,
  `instanceTag`, `pid`, `uid` and `bootId`. The NanoGPT key is asked from the cloud for a starting
  NanoGPT session only and lives in memory for that start; the audit log records that request (method,
  session id, ok or error) but never the key. On SIGINT/SIGTERM the engine pauses its
  running sessions first, then stops them and closes the link. The link client reconnects with a back-off
  of 1 to 30 seconds after a lost connection, a failed handshake (Node 22–23 WebSockets emit only
  `error`, without `close`) or a handshake without a welcome within 30 seconds (PM-732). Each attempt
  ends only once, so delayed socket events cannot start concurrent connections. It replays
  unacknowledged events by sequence number, buffers at most 10,000 events or 50 MB (the oldest are
  dropped and counted), and sends terminal data only for sessions the cloud attached.
  **Assumptions:** the code (a git checkout), the CLIs, their logged-in accounts (Claude, Codex,
  Gemini), the browsers and the repos are on the engine's machine, and a person starts the engine as
  the user who owns them. The cloud sees nothing of the machine beyond `hello` and what requests
  return. **Does this work on a remote engine?** This entry is the remote engine: in the engine
  process run the Gemini CLI and its conversation directories; the NanoGPT Codex home; dependency clones; the
  heavy-run queue; session output folders; browser installation and screenshots; the machine display and
  orphan processes; instance identity (`instanceTag` from the real path of the engine's home) and session
  liveness and termination; conversation transcripts and resume; hooks and team MCP over loopback;
  task worktrees and shared git storage; the free-disk probe; the native sandbox and canonical paths;
  CLI token and plan usage; Claude workspace trust; the Codex project layer check; and the full test
  before review. The cloud keeps the registry, the secret store, the integrator credential, the
  permission decisions and the control socket. Transcripts, bundles and attachments cross as
  purpose-scoped uploads and downloads (`engine-transfer.ts`; the cloud's endpoints are PM-315).
  The link client uses the runtime's `WebSocket`, which cannot send the close codes 1001, 1002 and
  1011: it closes with 1000 and a reason text (`engine_shutdown`) instead.
  **Module:** `entry`

- **Cloud composition** — `engine-link/remote/{hub,transfers,runner,transcripts,host,attachments,machine,github,handlers,index}.ts`,
  `engine-link/index.ts` (`EngineLinks.authenticate`), `app.ts` (`parseMode`, `createCloudRemote`),
  `runtime/sessions` (`SessionOrchestrator`, `EngineRegistry`), `core/messages`, `runtime/watchers` (`MachineMonitor`),
  `services/full-tests/{full-tests,screenshot-runs}.ts` (PM-315, PM-601).
  PM-791 lets `host.ts` follow a full test across at most five engine link losses when the
  caller opts into a bounded wait. `full_test.attach` carries only the run id and result;
  execution, cancellation and checkout cleanup stay on the engine. The cloud retains start
  callbacks until following ends and uses the remaining test timeout plus its existing grace.
  Other RPC failures end as `spawn_failed`, so handler errors and refusals block the check
  once instead of being retried as engine link losses.
  `PROJECTMAN_MODE=cloud` runs the UI, the API and the database and no machine-dependent part: the
  runner, the transcripts, the plan usage, the machine probe, the engine directory (worktrees, workspaces,
  session folders, free disk), the GitHub CLI, the full test and the screenshots are the engine's, asked
  over its link. `createCloudRemote` builds them before the domain (which takes them as its own runner,
  engines, machine probe and GitHub service) and `bind` hands over the domain and the app afterwards (the
  team-tools relay and the reconciliation). The hub (`hub.ts`) keeps a mirror of each engine (running
  sessions, pending inputs, session folders) built from its `hello` and its events, so the synchronous
  questions (`isRunning`, `list`, `hasPendingInput`, `processExists`, `sessionFolders.of`) are answered
  without a call. A call waits up to 60 seconds for a dropped link while the engine counts as available
  (120 seconds); a request that was in flight when the link dropped fails with `link_down` and is not
  repeated; at shutdown nothing waits (`stopWaiting`). A connecting engine is reconciled before it counts
  as online: a session the database calls live that the engine does not report ends with `server_restart`
  (a cloud restart ends every running remote session, because the team-tools tokens are in memory), and
  what the engine runs that the database does not know is stopped. Messages for a session on an engine
  that is away are held (`SentMessageHold` `engine`) and delivered when it is back.
  The team tools reach the cloud as `mcp.relay`: the cloud runs the request through its own
  `/mcp/<token>` route (`app.inject`) only when the token's session runs on the requesting engine, and
  answers 404 otherwise. Transcripts, bundles, attachments and exported files cross as single-use,
  purpose-scoped transfers (`transfers.ts`: 5 minutes, size and sha256 checked, 404 for an expired,
  reused or another engine's token); the files an engine uploads wait in a spool folder that is emptied at
  start. The NanoGPT key is released to a starting NanoGPT session of the asking engine only (the PM-313
  condition, now answered by `handlers.ts`) and is never logged.
  PM-1061: every outbound call passes `engine-link/remote/guard.ts` (a project's call goes only to an engine bound
  to it, the machine calls only to `hostEngine()`), and `handlers.ts` answers a request about a
  session only when the session is recorded on the asking engine and its project is bound to it. The NanoGPT key
  goes only to an engine whose owner is the host owner; a NanoGPT start on another owner's engine is refused with
  `nanogpt_key_not_for_engine` (a member's start then waits with that reason), and the provider status of such an
  engine reads as a missing key. The host machine view (`machine.ts`, `host.ts`) and the diagnostics, test, build
  and release preparation of the Operator use `hostEngine()` and nothing else.
  **Assumptions:** the cloud has no CLI, git checkout, browser or session folder of its own; the one
  engine of a project (the default engine) is the machine the owner sees. `PROJECTMAN_MACHINE_FIXTURE`
  is ignored and no full-test or screenshot executor is built locally. The
  local worktree manager is still created because `DomainOptions.worktrees` is required, and is unused.
  Since PM-774, the native PTY and terminal packages (`runner/{session,terminal}.ts`), sandbox runtime
  (`full-test/{index,workspace-dependencies}.ts`), SES SDK (`services/email-login/ses-mailer.ts`) and
  image decoder (`core/attachments/{attachments/thumbnail,message-attachments/image}.ts`,
  `services/feedback/screenshots.ts`) load only on first use. Synchronous PTY and terminal APIs use
  `createRequire`; asynchronous operations memoize dynamic imports. The image decoder disables its
  operation cache when loaded. Cloud startup loads none of these packages, even with e-mail login
  configured; the SDK client is created on the first send. The entry point loads the full-test factories
  dynamically in single mode; the queue directory helper lives in `full-test/heavy-lock-dir.ts` and
  remains available through the existing facade. `test/architecture/lazy-packages.test.ts` guards
  against static value imports. The engine and single mode load each package where its work runs;
  the existing RPC boundary and host requirements do not change.
  The link keeps no request results (PM-1116): a request id is random, so no caller repeats one, and a
  kept `mcp.relay` body only held the 256 MB heap. The `usage` events replayed after a cloud restart
  can be counted twice, because the cloud's memory of handled events does not survive its restart.
  **Engine per project (PM-1059).** The business code no longer asks the hub for "the" default engine;
  it asks `EngineDirectory.projectEngine(projectKey)` (the project's base engine) or `hostEngine()` (the
  machine that is not about one project: project-creation folder check, machine view and orphan
  signal, host build, NanoGPT recovery, provider status without a project). `engineFor(projectKey, handle)`
  names a member's engine. `projectEngine` is the project's binding since PM-1060 (see below);
  `hostEngine` stays the hub's default engine. The remote runner starts a session on the
  spec's `engineId`, else the project's engine, and refuses (`engine_offline`) rather than falling back to
  another engine; attachments and materialized files go to the session's or the project's engine. Plan
  usage is measured and cached per `(engine, provider)`, shown on a board from the engine of the
  project's first AI member of that provider, and published (`plan_usage`) only to the projects that run
  on the measured engine; admission checks the starting member's engine. GitHub reads, release
  publishing and PR watches go through `GithubService` (project-aware) to the project's engine
  (`MachineGithubService` is the engine-side, project-less contract); the cloud keeps a watch per
  `(project, repo, PR)` on the engine it subscribed on, resends only that engine's watches on
  reconnect and drops a `github_changed` event from any other engine. Pull request snapshots, links,
  heads and authors are keyed by project too. No new machine operation or RPC exists.
  **The project's engine is a binding (PM-1060).** The `project_engines` table (migration 117:
  `project_key`, `engine_id`, `is_default`, `added_by`, `added_at`; one default per project by a partial
  unique index) says which engines run a project; the engine's owner (`engines.created_by`) and the
  project's owner bind (`PUT /api/projects/:key/engines/:engine`, `DELETE`, `GET`; own login only, no
  super command). `EngineRegistry.projectEngine` applies the pure rule `projectEngineOf` of
  `packages/shared`: the live default binding; none (`engine_offline`) when it is revoked, never a silent
  move to another machine; with no binding the global default engine, but only while its owner is among
  the project's owners and no other user created the project (`projects.created_by`, migration 119, PM-1062:
  null for a project the host owner registered, the creator's user id for one made in the app; no route
  changes it). The configuration names the owners and a project owner edits it freely, so an owner
  account's project reaches the host's machine only through an explicit binding of the host's own login.
  Revoking an owner account pauses the projects it created too. So a single-machine or `local` installation and a project nobody bound run as
  before. Each write is one transaction with an `engine` row of the project's change journal, then the
  wake, an `engine_changed` event with the `projectKey`, and `onProjectEngineChange`: the GitHub watches
  of that project move to the new base engine (`github.unwatch` on the old, `github.watch` on the new;
  an event from the old one is no longer heard). A binding cannot be removed while the project has an
  open session on the engine (`engine_in_use`) or, for the default, while another binding stays
  (`engine_is_default`). The engine-side `hello.projects[]` is only the local contribution (it fills
  `holdsProject` of the list); it never decides the binding. It also feeds the setup checklist's
  `engine_connected` condition (PM-1069, `EngineRegistry.projectEngineHolds`): the hub reads the engine's
  last hello without its online state, and the engine side does not change.
  **Does this work on a remote engine?** This entry is the cloud's side of the remote engine: nothing
  here starts a process on the cloud's host. Without a connected engine a project cannot be created
  (`isDirectory` answers `engine_offline`, HTTP 409; PM-1062: the engine is the one the creator chose, an
  owner account must name one of its own, `engine_not_owned` / `engine_offline` / `engine_revoked`), a full test is refused with `engine_offline`, and
  the machine view is `engine_offline`. Moving the cloud onto a host with no CLIs is the goal; the
  `hello` paths are the engine's own and are never opened by the cloud.
  **Boundary proof (PM-667):** `test/cloud-engine.test.ts` (fixture `test/helpers/cloud-engine.ts`) joins
  the real cloud `buildApp({ engineMode: 'cloud' })` and the real `buildEngineApp` over the machine-key
  link on one machine, with disposable homes, a disposable repository, a fake runner and no CLI, `gh` or
  account. It shows: login, cards, clients and attachments work with no engine; a start and a message
  held offline each run exactly once when the engine connects; the checkout, the worktrees and the
  machine view are the engine's and the cloud's home gains none; the team-tools relay refuses a token of
  another session; a card's attachments reach the engine's `attachments-cache/` and a message's
  attachments its session folder, byte for byte; a drop, an engine restart, a cloud restart, a revoked
  key, a hello of another protocol (close 4409) and an engine of another version (flagged, accepted) end as
  described above; a `session.start` the link dropped in the middle of is not repeated (the cloud marks the
  session failed, the engine finishes the start, the cloud then stops that session, and nothing runs
  unseen). **Cloud restart:** the runner's shutdown cannot reach the engine, because the websocket plugin
  closes the links before `app.ts`'s close hook runs; the session the engine keeps running is ended by
  the reconciliation when the engine reconnects (its team-tools token is gone with the cloud's memory),
  and interrupted card work resumes automatically through admission from its transcript (PM-1092);
  general conversations resume on their next message. No session survives a cloud restart
  seamlessly. A session may read its card's `attachments-cache/<project>/<task>` folder on the engine
  (a read-only sandbox root; never a working directory).
  **Module:** `engine-link`

- **Cloud deployment and backup** — `deploy/cloud/{Dockerfile,entrypoint.sh,backup.sh,litestream.yml,smoke.sh,memory-probe.mjs,memory-profile.mjs,heap-summary.mjs,history-semantic-profile.mjs,history-semantic-fixture.mjs,history-semantic-image-check.mjs}`,
  `.github/workflows/history-semantic-profile.yml` (the release measurement on a GitHub-hosted `ubuntu-24.04-arm` runner, PM-913),
  `.dockerignore`, `auth/setup-code.ts`, `auth/index.ts` (the first setup), `apps/server/test/deploy-cloud.test.ts` (PM-317).
  PM-1116: `backup.sh` runs `restic forget` on every backup and `restic prune` once a week (the marker file
  `.restic-last-prune` in the home; a lost marker only repeats one prune); the RSS composition
  (`smaps_rollup`, the `memory` log line) is described in HYBRID.md "What the RSS is made of".
  PM-718 adds `scripts/cloud/images.ts`: an admin builder with existing Docker/Buildx docker-container
  driver and native builders/emulation exports the single-platform linux/arm64 Docker archive (PM-1116:
  arm64 only; the manifest holds one image and a bundle with another platform is refused)
  at one clean HEAD SHA, using a tracked-source-only context and the existing .dockerignore. The
  revision LABEL and PROJECTMAN_VERSION retain that full SHA. A strict, atomically published bundle
  manifest pins archive hashes/sizes and config digests after import/inspect verification. Output
  stays outside the checkout; no registry, upload service, build-host provisioning or engine RPC.
  The builder must be separate from EC2; ARM never builds on EC2. Actual two-platform native binary
  and disposable cloud smoke evidence, 1 GiB RAM/20 GiB disk capacity and digest-specific cutover
  approval belong to PM-675. A manifest is integrity metadata, not a signature of origin.
  PM-1145: the bundle is normally built on GitHub and only fetched and verified on the admin machine (see
  "Compute jobs on GitHub Actions (PM-1144)"); the local `image-build` stays as the fallback.
  PM-723: `smoke.sh` probes the engine door with four anonymous requests (GET link, GET download,
  GET upload, POST upload with an empty binary body), sending only the Cloudflare Access headers;
  none may answer 2xx, and an unreachable probe fails. It needs bash and curl on the machine that
  runs it and calls the hub URL; the engine has nothing new to do. `http/errors.ts` answers unknown
  `/engine` paths with 404 instead of the web app's index.html (hub HTTP routing only).
  PM-674's [rollback runbook](CLOUD-CUTOVER.md) closes the public edge and stops the cloud
  before downloading final data for Mac single activation. Deployment and backup remain on EC2;
  the single-mode recovery service does not update either the cloud or the separate engine checkout.
  PM-1197 (part of PM-1193): `deploy/aws/host.sh` gains `prune-images` (after a healthy deploy only the current and the
  previous image stay on the host; the Mac `deploy` calls it too) and `env-check` (reports which required names are
  missing from `/etc/projectman/cloud.env`, never a value; a missing name stops the deploy as `env_missing` before
  anything starts). The deploy itself can run from GitHub Actions (`scripts/cloud/runner-deploy.ts`,
  `.github/workflows/projectman-deploy.yml`, docs/DEPLOY.md "Deploy from GitHub Actions"). **Machine assumption:** the
  host keeps `/etc/projectman/cloud.env` and the Docker images in its own storage; a failed health check still runs the
  existing rollback, then the job fails. **Remote engine:** nothing runs on an engine.
  On AWS EC2 the same image runs under systemd on one Ubuntu machine, installed and operated by
  `npm run cloud` (the entry "The cloud machine and its operation (PM-535)").
  PM-775 (part of PM-772) adds to the same entry: `apps/server/src/logging/memory-log.ts`
  (`PROJECTMAN_MEMORY_LOG_SECONDS`, read in `index.ts`: a `memory` log line every 60 to 86400 seconds, off
  at 0), `PROJECTMAN_HEAP_LIMIT_MB` (read only by `entrypoint.sh`, which gives the server node's
  `--max-old-space-size`; 128 to 4096, empty keeps node's default) and a `curl` `HEALTHCHECK` instead of
  a node process every 30 seconds. **Machine assumption:** the heap ceiling is sized to the cloud
  machine's memory (docs/HYBRID.md "Settings"); the docker `--memory` limit, the systemd unit and the
  host (`deploy/aws`) are unchanged. **Remote engine:** none; the engine process does not read either
  variable and nothing crosses the server/engine boundary.
  PM-1105 adds: with `PROJECTMAN_HEAP_SNAPSHOT=1` (opt-in, read only by `entrypoint.sh`) the entrypoint also
  starts the server with `--report-on-fatalerror` and `--heapsnapshot-near-heap-limit=1`, both writing into
  `<home>/diagnostics` (created at the start, mode 700, excluded from the restic backup because a heap
  snapshot holds board data and secrets); only the newest earlier heap snapshot is kept at each start.
  `heap-summary.mjs` reads such a snapshot on a laptop and names its biggest retainers (retained size from
  the dominator tree, with the shortest path from the GC roots); it prints no string values.
  `start.ts` defaults `PROJECTMAN_HISTORY_SEMANTIC` to `off` in cloud mode. **Machine assumption:** the persistent volume has room for two
  snapshots of about the heap limit each, and the machine has memory for writing one near the limit.
  **Remote engine:** none; it concerns only the cloud server process.
  The cloud runs in a container with `git` and without the `claude`, `codex` and `gh` CLIs, as an
  unprivileged user (the entrypoint starts as root only to hand the mounted volume over, then drops
  with `setpriv --no-new-privs`). Its processes: the server (`HOST=127.0.0.1`), Litestream
  (`replicate`), `cloudflared` (token-managed tunnel, outbound only) and a restic loop; each runs in
  a cleared environment with only its own variables, so the server's environment holds no tunnel
  token, storage key or restic password (an environment filter only: one uid, so `/proc/<pid>/environ`
  of the others stays readable to a compromised server). `PROJECTMAN_HOME` is the platform volume (`/data`): the
  database is replicated by Litestream (continuously, S3-compatible storage) and the rest of the
  home (`secret`, `secrets/`, `customization/` with `.git`, `attachments/`, `message-attachments/`,
  `feedback/`, `memory/`, `instance.json`)
  by restic into a separate encrypted repository (its password is not the storage key). A fresh
  volume restores both before the server starts and stops the start on any restore error other
  than "no replica / no repository yet". The first setup from a browser needs a one-time setup code
  from the server log (`auth/setup-code.ts`): `isLocalRequest` is false behind the tunnel, because
  the tunnel must not rewrite the Host header, and the code replaces "localhost" as the proof.
  **Assumptions:** one container and one volume at a time (two would replicate into one replica);
  the host knows the platform's volume semantics (a block volume attaches to one machine); the origin
  of the Cloudflare tunnel is `http://127.0.0.1:4700` with no Host override; the client address
  comes from `cf-connecting-ip` (`PROJECTMAN_CLIENT_IP_HEADER`), trusted from the loopback peer
  only; the Litestream replica is the SQLite database itself (not encrypted by Litestream), so the
  bucket's own encryption and a bucket-scoped key protect it. The Cloudflare Access service tokens
  of the engine (`linkHeadersFile`) and of the integrator are the only machine credentials that pass
  the edge.
  **Integrator isolation (PM-675):** `start.ts` reads optional `PROJECTMAN_INTEGRATOR_HOSTNAME` into
  `app.ts`; `http/integrator-host-guard.ts` runs on the hub before cookie/auth hooks, using the raw Host
  with case/port/root-dot normalization shared with the feedback guard. It blocks board bearer requests
  (403), board bare MCP (404), machine cookie-only requests (401) and machine non-API/MCP routes (404).
  Host preservation by the tunnel is required; forwarded-host headers and loopback source addresses
  confer no exception. The guard applies in private staging too; public mode without a hostname never
  restores bearer access on the board. This is a hub-only boundary; the remote engine needs no change.
  **Does this work on a remote engine?** This is the cloud's side only; the container runs no
  engine, no session and no machine-dependent part. What must run on the engine: everything in the
  "Cloud composition" entry. What crosses the boundary: the engine's `cloudUrl`, machine key and
  `linkHeadersFile` (`docs/HYBRID.md`, "Connecting the engine"); the restic repository holds the
  cloud's home, never an engine's worktrees or transcripts. The restore rehearsal
  (`entrypoint.sh rehearse`) starts a standby copy on the loopback with no tunnel and no
  replication, so it cannot disturb the production replica.
  PM-668 excludes provider homes, engine credentials, machine workspaces, logs and transient
  caches/spools from restic; the cloud-volume marker is rebuilt only after successful restore.
  Rehearsal requires an empty separate directory; temporary restore staging uses `TMPDIR`
  (default `/tmp`) passed through the cleared environment. The DB (1s sync) and files (21600s
  interval, first delay 300s) are separate recovery points: files may lag by 6 hours or longer
  after backup failures. A smoke pass is not complete recovery; the HYBRID/AWS runbook requires
  file/hash/reference checks and an earlier DB point when necessary. The fake-tool SQLite fixture
  proves coverage/error paths, while real S3/Docker acceptance belongs to PM-675. Storage secrets
  and backup execution stay on the cloud, never in engine payloads.
  PM-773 adds the memory tools `deploy/cloud/{memory-probe,memory-profile,heap-summary}.mjs` (the
  Dockerfile does not copy them since PM-1116: they come from the repository as a read-only volume;
  `docs/HYBRID.md`, "Memory profile"). They are run
  by hand, on a disposable copy of a home (marker `<home>/.memory-profile-copy`), on the loopback
  with no network: the profile starts the server as a child process in a cleared environment, sends
  it SIGUSR2 for heap snapshots, reads `/proc/<pid>/status` (Linux; `ps` on macOS), and loads it with
  the web app's read requests over `127.0.0.1`. No tunnel, Litestream, restic or engine starts, no new
  RPC and nothing crosses the server/engine boundary, so a remote engine is not affected. Heap
  snapshots hold real data and stay on the machine that ran the tool; only `report.md` and the
  summaries (types, constructor names, numbers) may leave it.
  **Module:** `deploy`

- **Integrator credential** — `auth/auth-service.ts`, `auth/index.ts`,
  `db/integrator-keys.ts`, `db/integrator-key-audit.ts`, `runtime/sessions` (`session policy`),
  `runner/env.ts`, `services/super-operator`, `kernel/integrator-execution.ts` (PM-251, PM-758, PM-759).
  The host owner creates a separately attributed bearer key; the server stores only its hash.
  Authentication accepts it only on a local connection or HTTPS, using the existing loopback
  proxy protocol rules in `kernel` (`clientAddress`, `requestProtocol`).
  The host owner's own login manages explicit `super`/`read` keys with 1/7/30/365-day expiry
  or no expiry (`expiresInDays: null`, PM-825; default 7 days). The hub already stores a null
  `expires_at` and authenticates it until revocation; no migration or engine operation is needed.
  PM-1045: `AuthService.hasActiveSuperKey(ownerEmail)` (repository `hasActiveSuper`) tells whether an owner has
  a live (not revoked, not expired) super key; `integratorSideAvailable` reads it to decide where a machine todo
  waits. It reads only the hub database; no machine assumption is added.
  PM-1074 (decision 66): a step made with the key is the connected Claude's: it is recorded under the key holder's
  name (or the queue item issuer's), with `through` naming the holder and the key; the project needs no Operator for
  a key to bind. The key still carries no authority beyond the authenticated scope and the holder's rights.
  PM-1063: a further owner (an active owner account, PM-1062) with a password holds `super`/`read` keys of
  their own beside the host owner; the pure rule is `canHoldIntegratorKey` (`packages/shared/src/config/integrator.ts`),
  applied by `AuthService.keyHolderAllowed` at issuing, authentication, `assertActive` and `hasActiveSuperKey`.
  A key's scope is its holder's own projects (the existing owner-membership checks); revoking the owner account
  makes the key `integrator_key_invalid` (401). The team of a project is editable by its owners, so the reach
  also rests on a fact the team cannot write (`integratorKeyCoversProject`, `AuthService.keyCoversProject`):
  in a project an owner account created (`projects.created_by`, PM-1062) only the creator's key counts, even if
  the team lists the host owner; a project the host registered stays with its owner members' keys. The check
  sits in the scope's access check, `executeOwned`/`executeInstance`, `hasActiveSuperKey(email, projectKey)` (the queue). Instance-level REST routes are not `host_only` (PM-1058).
  Legacy keys are revoked with a lifecycle audit by migration 114 (PM-1037); the singular API is removed.
  Authentication rejects legacy rows, which remain readable in key lists and audit history. Before release,
  the owner must replace any active legacy credential on the integrator's machine with a super or read key.
  Replacement revokes only
  the same mode, with a database uniqueness constraint and transactional lifecycle audit.
  An instance-level call (`executeInstance`, `instanceUser`) is the host owner's through the key: it runs once, the
  key's policy and the super audit bind only the projects its holder owns, and the instance Operator actor comes
  from the first such project, never from another owner's project (PM-1058). The hub decides; nothing crosses to an engine.
  The shared credential resolver returns the stored mode and key id; `assertActive` rechecks
  that row and its owner without updating usage. Authentication records `mcp`, `cli` or `rest`
  alongside the last-use timestamp on first use, channel change or after five minutes.
  The exact external `/mcp` path takes precedence over the self-reported CLI header, which
  grants no authority. REST binds explicit modes through the Super Operator facade. The auth service
  registers immutable resolved principals in a private WeakSet; a copied principal or actor JSON grants
  no authority. The hub's request-local scope expires with its callback, and domain mutations recheck
  the active key and current project-owner membership after waiting for locks. Read credentials cannot
  write. Super credentials administer existing services but cannot decide human approvals, manage keys,
  or bypass fixed Operator invariants. The shared structured mutation projection (`ownerReservedEffect`,
  `packages/shared/src/config/super-mutation.ts`) reserves three effect classes for the owner (PM-870, the
  owner's decision of 2026-10-20): `deletion` (a member, repository, project or key removed), `security` (an
  access level or a new owner member, a human member's login e-mail or kind, an AI member's permission mode, approver and outbound network, the boundary delegation, the Operator approval waiver and the keys) and
  `cost` (the consumption-billed NanoGPT runtime); until PM-762 supplies an exact owner grant, these fail
  closed. Everything else (deploy and publishing, repository and workspace paths, the other
  deletions, approval labels the key owner holds, decisions) the Operator does in its own name with the
  super key: `labelRefusal` opens the approval and human-only labels to a super actor when the key owner
  holds the label (self-review stays refused), and `superAccessVerdict` allows `approval` for the super mode. The repository merge queue's revision and complete permutation
  use one hub SQLite transaction (`merge_queue_revisions` and `task_merges.queue_rank`, migration 82,
  after PM-771's migration 80 and PM-761's migration 81); the running merge remains behind the existing
  BranchMerger facade.
  The external bearer MCP endpoint (PM-760, "The external MCP endpoint" in [services/super-operator](modules/services-super-operator.md)) uses this resolver on
  every HTTP request.
  Integrator todos (PM-782, `core/inbox`, `services/super-operator/todo.ts`) have a dedicated
  super-only resolution path for the integrator's own work, with authenticated actor/answer markers
  instead of an owner relay. `app.ts` supplies `IntegratorTodoAccess` through assembly: it checks
  current project owners, their existing users and active explicit super keys against shared access
  policy on every screening release. Only a boolean reaches the domain; no key id, prefix or secret
  enters question payloads or screening notices. Resolution and the durable 24-hour maintenance
  handoff run on the hub, even when the engine is offline. Remote engines need no new operation.
  The integrator stores its copy in `~/.config/projectman/integrator-key` on its own machine.
  Member file tools and local CLI sandboxes deny `.config/projectman`; the runner strips
  `PROJECTMAN_INTEGRATOR_KEY` before launching members.
  **Remote engine:** key authentication and audit stay on the server; the credential is never
  sent to an engine or member session. Engines must deny the same directory in their worker
  homes and strip the environment variable before spawning a CLI.
  **External MCP endpoint (PM-760):** `mcp/super-operator/*`, `mcp/http.ts`, `services/super-operator/relay.ts`,
  `scripts/cloud/cloudflare.ts` (`ingressRules`). `POST /mcp` takes the bearer key per request, with no session or
  engine. Machine assumptions: a local or HTTPS connection (`requestProtocol` trusts `X-Forwarded-Proto` only from a
  loopback peer, so the proxy or tunnel must run on the server's machine and keep Host and the protocol header) and a
  tunnel/proxy that refuses `/mcp/` and `/hooks` but passes `/mcp`. Remote engine: not affected; nothing of the endpoint
  runs on or crosses to an engine. Since PM-1045 this endpoint is the Operator's only door: the app starts no
  session for it. **The connected Claude as an actor (PM-1074, decision 66):** a super-key step is recorded as the
  key holder in person (`kind: human`, `via: integrator`, `through: {holder, credential}`), or, with
  `queue_item_id` on `super_operate`, as the member who put that open integrator queue
  item there (the screening member of a screened question, otherwise its source; `kind: ai`, the same `through`; `queue_item_not_yours` / `issuer_without_machine_access` refuse it). After the
  owner's own yes on a K3 question the step also carries `approvedBy`, set by the server only. The old
  `operatorMode: super` events stay readable; `coordinatorSuperActorOf` serves only the selected coordinator's
  in-app session (PM-1076: `superActorOf` and the Operator member are gone). The actor is created and stored on the hub (`actor_meta`); no machine-dependent part is added.
  **Two kinds of key holder (PM-1063):** a tool with `hostOnly: true` (`mcp/kit.ts`: the two instance-knowledge tools; the host-request tools of
  PM-1064 take the same flag) is absent from `tools/list` of a further owner's key and answers `host_only` if called
  (`ExternalMcpBackend.isHost`). The server's `instructions` come in two kinds: the host's (the global Operator,
  unchanged) and a short one for a further owner (own projects, own machine with their approval, no secrets).
  Remote engine: not affected; the filter reads the hub's user and owner-account rows.
  **The global Operator on the endpoint (PM-1046, PM-1023 K7):** in the super mode `get_operator_instance_knowledge`
  and `update_operator_instance_knowledge` (`expected_revision`, `agreement?`, `principles?`) read and write the
  Operator's own knowledge with no `project_key` (`services/super-operator/instance-knowledge.ts`); the write is
  direct, with no app approval, and the super audit records it in every project the key's holder owns
  (`SuperOperator.executeOwned`). `list_integrator_inbox` takes an optional `project_key`: without it the items of every
  project of the key come in one list, each with its `projectKey`, and the access is checked per project. The
  server's `instructions` describe the Operator's role (decision 65). Remote engine: not affected; the Operator
  reaches the hub over HTTPS with the key and the knowledge stays in the hub's home.
  **Operator tools on the endpoint (PM-784):** `read_project_doc`, `write_project_docs`, `get_project_doc_write`,
  `get_role_configuration`, `request_structural_review`, `ask_human`, `get_super_question`,
  `withdraw_question` and `read_attachment` (`mcp/*/tools.ts` `external` bindings, `mcp/super-operator/handler.ts`,
  `core/inbox/human-questions.ts`, `services/project-docs/doc-writes.ts`). They run on the hub with no session or
  engine. The only engine traffic is the one a member's call already has: a document write's git work
  (`merge.read_file`, `merge.commit_files`, `merge.push`, see [services/merges](modules/services-merges.md)) and a review request's usual member start. A
  queued write goes on under a fresh scope of its key (`auth.reactivate`, assembly's `DocWriteExternalRunner`) and
  checks the key, the owner and the Operator again before it starts and before the push; the origin (`ownerUserId`,
  key id and prefix, request id) is stored in `doc_writes.external_origin`, never taken from input. An attachment
  chunk is read from the hub's own attachment storage (at most 1 MiB per call, 25 MiB per file); on a remote engine
  nothing changes, since the hub already holds the stored files.
  **Cloud (PM-317):** in front of the cloud the integrator also passes Cloudflare Access with a
  service token of its own, kept beside the key in `~/.config/projectman/` (DEPLOY.md,
  "Integrator access"); the key still works only over HTTPS, which the container sees as
  `x-forwarded-proto: https` from the tunnel's loopback connection. The service token is a second
  secret with the same rules: never in a message, task, commit, prompt or engine payload.
  **PM-675:** when the explicit machine hostname is configured, the existing integrator client's
  origin changes to it; REST `/api` and MCP `/mcp`, key scopes and audit stay the same. Its Access
  token opens only that application's audience. Human key management, super audit and approval remain
  on the board's own cookie API. The app-principal's direct domain calls are not HTTP entrances.
  **Integrator client (PM-765):** `scripts/projectman/**` (the `projectman` bin: REST, `events follow` and the
  stdio `mcp-proxy`), `packages/shared/src/api/client-config.ts` (`ClientConfig`, exit codes, the channel
  header). Project writes use the common super-operation endpoint (PM-889), with the same request id in
  the body and header: task creation, fields, labels and starting; inbox decisions; configuration and
  member edits; credential revocation; project pause/resume and merge ordering. K3 operations return
  `waiting_owner` successfully. Legacy inbox answer and
  fix-limit commands, instance pause/resume and merge prioritization retain their dedicated REST routes
  (no corresponding super command). `queue` reads the Operator's `MemberQueueView`, including closed items.
  `runner/env.ts` (`ACCESS_ENV_PREFIXES`) strips its credentials. It runs on the integrator's own machine, not on the
  server's or an engine's, and reads `~/.config/projectman/client.json` (paths and an origin only) with the key
  file and the optional Access service-token file it names. Machine assumptions: a home directory with
  `~/.config/projectman` (mode 700, files of the user with mode 600, no links; checked before any request), Node
  with the `tsx` loader, an HTTPS origin or a loopback one, a standard input/output pair for the proxy, and for
  `events follow --cursor-file` a writable local file (the cursor is not a secret). The client has no `--token`
  and no secret environment variable; it follows no redirect, redacts every error and debug line, and sends the
  non-secret `X-Projectman-Client: cli` label on REST and event requests (the server decides the channel by the
  path, so `/mcp` stays the `mcp` channel). Rights, expiry, audit and idempotency (the operations' request id)
  stay on the server. The runner strips the environment names of the Access service token
  (`CF_ACCESS_*`, `CLOUDFLARE_ACCESS_*`) next to `PROJECTMAN_INTEGRATOR_KEY`, and the live supervisor's
  allowlist keeps them out of the server. **Remote engine:** not affected; nothing of the client runs on or
  crosses to an engine, and neither the key nor the Access token is ever sent there.
  **Module:** `auth`

- **Codex project layer check** — `runner/ambient-config.ts` (`inspectProjectCodex`,
  `assertCodexMemberWorkspace`), `runner/runner.ts` (`assertWorkspaceConfig`),
  `runner/providers/codex/index.ts` (`launch`), `runtime/sessions` (`SessionLauncher` in `launch.ts`) (PM-357).
  The server reads the CLI's canonical working directory and each `.codex` layer from the
  nearest ancestor with a `.git` entry. Member starts and resumes allow only `config.toml`
  with model and project-document roots; confined reads reject links and nonregular files.
  Preflight runs before session rows/folders, and the adapter checks again before launch.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.assert_workspace_config` (PM-313) and run both inspections beside the CLI on the engine. The domain preflight
  becomes a server/engine call; return relative file names and key names only, never values.
  Today the server and CLI share the filesystem. NanoGPT retains its separate `any` rule.
  **Cloud mode (PM-315):** `RemoteRunner.assertWorkspaceConfig` calls `session.assert_workspace_config` on the
  session's engine; the engine refuses with its relative file names and key names only, never values.
  **Module:** `runner`

- **NanoGPT Codex home and key delivery** — `runner/providers/nanogpt/index.ts`, `runner/providers/codex/args.ts`,
  `runner/env.ts`, `app.ts`, `index.ts`
  (PM-329). The engine runs Codex >= 0.159.1 with a dedicated 0700 home under
  `PROJECTMAN_HOME/providers/nanogpt/codex-home`; any `auth.json` refuses startup. Only this
  adapter supplies the secret as trusted child environment and excludes it from CLI shell
  commands. Transcripts remain in that home; ChatGPT plan usage reads only the ordinary
  Codex home. **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.start`,
  `provider.status` and `secret.nanogpt_key` (PM-313); PM-1061: only an engine the host owner owns gets the hub's key
  (`nanogpt_key_not_for_engine` for the others). **Own key on the engine (PM-1068):** any engine may hold its
  own key file (`nanogptKeyFile` in `engine.json`, set with `npm run engine -- nanogpt-key set|clear`, 0600, outside every
  session root and on the engine's sandbox deny list). An engine with a key file always uses it, the host's engine
  too: it re-reads the file at every start (`ownNanogptKey` in `engine-app.ts`), passes it as `nanogptKey` with
  `nanogptKeyInCloud: false`, registers no `nanogptStart` handler and says `nanogptKey: 'engine'` in its hello.
  The hub remembers that from `engines.last_hello` (`EngineRegistry.ownNanogptKey`), sets no key grant for such an
  engine and does not override its provider status with the hub's key fact. An engine without a key file keeps the old
  way (host's engine: hub key; another owner's engine: `nanogpt_key_missing`, the start waits). The CLI,
  home and transcripts belong on the engine; secret delivery requires an authenticated
  launch/resume boundary, never configuration, public status or logs. The current server and
  CLI share a machine and filesystem. A remote engine performs local version and auth-file
  checks and returns readiness status; it never asks for the key outside a start
  (`nanogptKeyInCloud`). The cloud adds whether it holds the key to the status it returns
  (`withNanogptKeyFact` in `engine-link/remote/runner.ts`, from its own key store, PM-736); only
  that fact is derived, never the key, and no engine method changes. The key goes out only to a
  starting session. A remote engine never persists or returns the delivered key,
  including in its spool; a replaced key affects only subsequent launches and resumes.
  Codex rollout `task_complete` (including an empty failed response) and `turn_aborted`
  events end the runner's turn even without a Stop hook; a later `task_started` supersedes
  that end (PM-377, `runner/providers/codex/transcript.ts`). The engine must parse these
  events beside the CLI and forward the resulting session state to the server.
  **Session folder and own TMPDIR (PM-522):** a NanoGPT session gets a session folder like a Codex
  one (`sessionFolderAccess`): with a writing sandbox (`workspace-write`, short tmp root present) the
  folder is writable, it gets its own `TMPDIR`, the browsers and the screenshot scope, and the shared
  `/tmp` is closed for its commands as for Codex; with a read-only sandbox the folder is read-only
  and only the server writes it. Without a safe tmp root a writing NanoGPT sandbox gets no folder
  and keeps the shared `/tmp` open as before.
  NanoGPT-only quota detection emits `rate_limited` over the existing RunnerEvent boundary;
  `runtime/usage` (`ProviderQuotaHolds`) keeps a provider-wide, in-memory hold on the server,
  blocking starts and message wakeups until the measured weekly reset. The adapter's
  `planUsage.get()` reads `GET https://api.nano-gpt.com/api/subscription/v1/usage` with the
  managed key, without logging credentials or response bodies (10-second timeout, no
  redirects). Unknown usage holds inference while only usage probes retry; initially
  known lower usage gives a fifteen-minute rate hold. Owners receive one alert per hold.
  `runtime/admission` (`MessageStarts`) persists the affected task's deferred continuation.
  Server restart loses the hold, but stored quota deferrals restore an unknown hold
  without an alert and require a usage probe before inference. **Remote engine:** usage HTTP runs on the server where the managed key
  is stored, as the key check already does, using the existing `api.nano-gpt.com` host;
  transcript parsing stays on the engine and sends `rate_limited` across RunnerEvent.
  No new machine-dependent boundary is required (PM-377).
  Startup checks `/etc/codex`, the dedicated home and workspace Codex configuration through
  `runner/ambient-config.ts`'s `inspectAmbientConfig`, refusing overrides with names only.
  NanoGPT also refuses nonempty workspace `.codex` directories and dedicated-home
  `hooks.json` files; escaped quoted TOML roots fail closed in the shared inspector.
  The shared inspector checks separate project and home hook files for every Codex caller;
  NanoGPT selects `projectFolder: 'any'`, also refusing symlinked or non-directory project folders.
  On a remote engine this inspection must run beside the CLI, before secret delivery.
  The engine also applies NanoGPT-only feature overrides disabling plugins, apps and
  skill-triggered MCP installation, an ephemeral authentication store, and disabled analytics
  and feedback. All child environments strip `CODEX_ACCESS_TOKEN`. Codex 0.159.1's public,
  unauthenticated GitHub announcement request remains a CLI network assumption.
  The environment filter also removes AuthManager's OAuth client-id and token-endpoint
  overrides, so a host environment cannot redirect child subscription authentication.
  **Cloud mode (PM-315):** the key stays in the cloud's secret store. The `secret.nanogpt_key` handler
  (`engine-link/remote/handlers.ts`) releases it only to the engine of a NanoGPT session that is starting
  (`RemoteRunner.takeKeyGrant`: a grant held only until the start call returns), never caches or logs it, and a key change asks each engine for its login state again
  (`provider.status`).
  **Module:** `runner`

- **Gemini (agy) CLI, conversation directories and keychain login** —
  `runner/providers/gemini/*` (PM-326; PM-319). The interactive PTY runs `AGY_BIN`/`agy`,
  authenticated with the executing account's Google consumer login in its keychain. Each
  conversation has a private directory under `PROJECTMAN_HOME/providers/gemini`; it stays
  for resume, holds hook/MCP configuration and local transcripts, and confines transcript
  reads (`Launch.conversationRoot`). POSIX sh plus curl (Node fallback) forwards hooks to
  loopback HTTP. Updates are disabled in launches and login probes; maintenance is manual.
  Commands currently run without a sandbox under owner decision T4: role shell rules allow
  listed developer commands, other calls use the inbox, and a missing hook answer denies the call.
  A command's actual working directory must stay in the session placement/writable roots;
  denied relative paths are resolved there. Read-only placements cannot use the unsandboxed
  shell-rule exception: commands pass through the inbox's existing read-only rules instead.
  The pre-tool hook uses the session policy's placement when newer agy versions omit `Cwd`
  (PM-874). It maps `read_file`, `write_file` and `edit_file` with `Path` as well as the
  older file tool names to the same permission checks (`runner/providers/gemini/hooks.ts`).
  This normalization runs on the engine using its session policy; no new boundary data is needed.
  **Quota exhaustion (PM-954):** `screen.ts` recognizes the agy terminal's
  `RESOURCE_EXHAUSTED (code 429): Individual quota reached` and `Resets in …` duration.
  `runner/session.ts` stops the failed process and sends `rate_limited` with an optional
  absolute `resetsAt` through `engine-link/protocol.ts`. The server's
  `runtime/sessions/provider-limits.ts` holds every Gemini member until that reset (30 minutes
  when no usable duration is available), records an owner alert and restores the hold from the
  latest Gemini quota alert on startup, including acknowledged alerts. Automatic developer
  selection skips the held provider; explicit starts wait with `provider_rate_limited`.
  An interrupted implementer's card is released through the existing handoff and work-start
  paths (`provider_quota`), so another provider can take it and an unassigned card waits if
  nobody is available. Expiry releases admission automatically, without changing leave settings.
  The hold is server-wide, matching the shared keychain login assumption; separate accounts
  on multiple engines would require a future `(provider, engine)` scope.
  On a remote engine terminal recognition and relative-to-absolute time conversion run on
  the engine; only the existing runner event and its additive `resetsAt` field cross to the
  server. Persistence, selection and expiry stay on the server; engine clocks must be synchronized.
  This does not contain code executed by allowed tests/builds; PM-361 investigates isolation.
  **Remote engine (engine mode, PM-314: runs in the engine process):** the binary, login/keychain, private directories, PTY, forwarder and
  transcript reader must run on the engine. Hook/MCP requests cross authenticated URLs;
  transcript access must stay confined to the provider's conversation root on the engine,
  rather than opening engine paths on the server.
  **Session folder (PM-522):** a Gemini session gets the per-process session folder (see **Session
  output folders**), named in `PROJECTMAN_SESSION_DIR` through the environment `launch` returns
  (`runner.ts` merges `launch.env`). Gemini has no OS sandbox, so the folder is written by its file
  tools under the pre-tool-use hook's gate (its own folder is allowed outside plan mode, another
  member's is asked about, reading is allowed), not by a sandboxed command; no tmp directory, browsers
  or screenshot scope. On a remote engine the environment is built on the engine side; an older
  engine without this launch environment leaves the variable unset (the folder is then not named, the
  path in a tool answer still works).
  **Module:** `runner`

- **NanoGPT secret store** — `runtime/usage` (`ProviderKeys`, `createNanogptKeyCheck`) (PM-328).
  See **NanoGPT Codex home and key delivery** (PM-329) for session-only secret delivery.
  PM-1061: the installation key is the host owner's; the hub delivers it only to an engine the host owner owns
  (`EngineRegistry.ownedByHost`), never to another owner's engine, and says so with `nanogpt_key_not_for_engine`.
  The server stores the installation key under `PROJECTMAN_HOME/secrets/nanogpt.json`,
  with POSIX directory/file modes 0700/0600 and an atomic same-directory rename. Only an
  host owner may change it (`canManageProviderKeys`, PM-1068; an owner of every project is not enough). It is the
  host engine's fallback only: an engine's own key file (see above) takes precedence, and each owner pays for their
  own engine. Save-time checking needs outbound HTTPS to NanoGPT.
  **Remote engine (engine mode, PM-314: runs in the engine process):** delivery uses `secret.nanogpt_key` (PM-313), with the starting-session guard in PM-315;
  storage and validation remain on the server; this card does not send
  the key to an engine. PM-329 must deliver it only to NanoGPT sessions over the authenticated
  server/engine boundary, without configuration, database or logging persistence on either side.
  **Module:** `runtime/usage`

This is a living inventory of assumptions that tie execution to a machine, account or OS.
The current local mode usually places the server and agent CLIs on the same host. The remote
actions below are requirements for planning, not implemented remote support or new contracts.
Keep entries current under the rule in `CLAUDE.md`.

Unless stated otherwise, server paths below are relative to `apps/server/src/`.

Core attachment and permission entries name their final implementation locations behind the
stable module facades (PM-645). This refactor changes no filesystem operation, machine
assumption or remote-engine RPC.

- **Session process liveness** — `runner/session.ts` (PM-376). Every 30 s the runner
  probes the attached CLI PID with signal 0, recovering a missing PTY exit event through
  the normal failed-session cleanup. Only `ESRCH` proves disappearance; permission errors
  leave the session running. An unreaped zombie also passes the probe.
  Since PM-621, `runner/session-clock.ts` schedules the probe with a ref'd Effect sleep: a running session keeps the process alive until shutdown stops it.
  The PID belongs to this host.
  **Remote engine (engine mode, PM-314: runs in the engine process):** run this probe beside the CLI on the engine and transport the exit event;
  a remote PID must never be checked against the server's process table.
  Since PM-311 the domain asks the workspace's engine (`EngineHost.processExists`, `contracts/engine.ts`).
  The local probe runs on the engine in `engine-host/local-engine.ts` (PM-611).
  **Module:** `runner`

- **Fake CLI pause test gates** — `runner/runner.integration.test.ts` and
  `apps/server/test/fixtures/fake-claude.mjs` (PM-344). Tests hold the fake's work/tool
  phase until a release file exists in the disposable session workspace; PTY readiness
  markers confirm the phase before a pause is requested. The test and fake must share
  that temporary filesystem. Interrupting a turn abandons its gate without a release.
  **Remote engine:** run this integration harness and its fake together on the engine;
  these test-only paths never cross the production server/engine boundary.
  **Module:** `runner`
- **Dependency clones and refreshes** — `worktree/{dependencies,dependency-copy}.ts`, `cloneDependencies`,
  `worktree/worktree-manager.ts`, `ensureForTask` (PM-334, PM-412).
  Copies installed `node_modules` from another checkout with the same lockfile using
  `cp -c -R`; only Darwin and checkouts on the same APFS volume pass the probe. Since PM-846 the
  probe also chooses the reference: a candidate on another volume (the repository, when the worktrees
  are on a work volume) is skipped for the next one, and the result is `unsupported` only when every
  candidate with the same lockfile is on another volume. The first worktree on a new volume is a full install. Missing or
  stale installations are cloned before a task session starts or resumes and before each tool
  via `runner/session.ts`, `RunnerModuleOptions.refreshDependencies`; staleness uses the
  local lockfile and hidden npm lockfile modification times.
  The merge check uses the same reference-selection rule via `findDependencyReference` on the engine
  (`engine-host/merge-check.ts`, PM-580), selecting against the merged lockfile. When no installed
  source matches, the card merge's `allowDependencyInstall` (PM-711) turns this into a
  `dependencyInstallRequired` answer for the executor's sandboxed preparation instead of copying old
  packages or asking the owner; without the switch it still blocks with `check_error` before the checks.
  The merge source copy and full-test dependency store use `copyDependencyTrees` through the worktree
  facade (PM-710): root plus two workspace levels, relative links preserved, Darwin clone with plain-copy
  fallback, existing targets and linked parents skipped, local `.vite`, `.vite-temp` and `.cache` removed.
  Its shared deadline and abort stop and await the copying child. Store skeletons create only the
  real workspace parents identified from the merged lockfile. Task-session cloning keeps its existing path.
  Per-worktree serialization and directory backups protect replacements; a server-start lifetime registry
  restricts targets, failed lookups retry in 60 seconds and copying is bounded to 90 seconds. Provider hooks allow
  time for preparation (`runner/hook-forwarder.ts`, 120 seconds for Claude and Codex).
  PM-1115: `no_lockfile` and `not_ignored` share that 60-second retry cache. Before the freshness check,
  worktree status and removal, `dependencies.ts` removes clone temporary/backup directories matching
  `.node_modules.pm-<8 hex digits>[-old]` older than five minutes, at the root and declared npm workspaces.
  It shares the clone lock, preserves recent copies and never traverses linked workspace parents.
  This is engine-local filesystem housekeeping; no paths or files cross the remote-engine boundary.
  No npm install runs outside a sandbox.
  Member clones install by default (PM-1203, owner decision): an engine-local `repos[].workspaceSetup`
  that is absent resolves to `{kind: 'npm_ci', timeoutMs: 600000, implicit: true}` in
  `engine-link/engine-config.ts`; `{kind: 'none'}` opts out, and an explicit `{kind: 'npm_ci', timeoutMs?}`
  (PM-741) is `implicit: false`. The default installs only where the clone has a root `package-lock.json`
  and never blocks a start: with no sandbox (not macOS, no srt, node/npm inside the user home) the result
  is `skipped` / `unavailable` instead of `sandbox_unavailable`, while an explicit setting still fails
  as before. `full-test/workspace-dependencies.ts` runs fixed `npm ci` outside the
  member session, in srt on macOS only: package trees and a private run home/tmp/cache are writable;
  only registry.npmjs.org and nodejs.org are reachable, with no local binding. The entire user home,
  app home, engine secrets and shared session temporary roots (Claude roots and the parents of
  session tmp/folder roots) are denied reads, following the merge installer's home-wide boundary.
  Node or npm installed inside the user home (for example through nvm or Volta) makes the sandbox
  runtime probe fail with `sandbox_unavailable`, as on the merge installer path.
  Only the target clone, the run's own sandbox and its empty npm configuration files are allowed
  within those denials; other repositories, attachments, session files and dependency markers stay closed.
  Local install hooks, npm overrides, binding.gyp and linked inputs/targets are refused using the
  merge installer's checks. The environment is the full-test allowlist without PROJECTMAN variables.
  A per-clone single flight survives caller/link timeouts; shutdown aborts and awaits its process group.
  The engine atomically records `{version:1,key,nodeModules,preparedAt}` under
  `<home>/workspace-deps/<sha256(JSON [project,member,repo])>/ready.json`, outside member write access.
  The byte-based npm dependency key includes manifests and runtime versions; listed trees must still
  exist as real directories. Persistent input/install/timeout/sandbox failures retry after ten minutes
  (a changed key retries immediately); queue and abort errors are not memoized.
  `workspace.prepareDependencies` runs after checkout and before binding/launch for work and review,
  including resumes. Pending/failed preparations release the session reservation and defer its start;
  checkout refuses while preparation is busy. Single mode, repositories with `{kind: 'none'}` and
  older engines skip it; an explicitly configured non-macOS engine fails with `sandbox_unavailable`. All files, copies, subprocesses
  and queue operations stay on the execution engine; only the key-bound request and result cross RPC.
  A running session is gated too (PM-743): before a command tool (`needsDependencies` in `runner/tools.ts`;
  not file, search, web or team tools) the PreToolUse path of `runner/session.ts` calls
  `refreshDependencies`, which in `engine-app.ts` finds the session's clone in the engine-local
  `worktree/member-workspace-registry.ts` (filled by `onEnsured` after each `ensure`; no RPC, the
  `MemberWorkspaceManager` contract is unchanged) and runs `worktree/dependency-gate.ts` over
  `prepareDependencies` with an 80 s wait (`DEPENDENCY_GATE_WAIT_S`). A pending preparation turns every
  command away through the adapter's `refuseToolOutput` (Claude, Gemini); a failed one once per clone,
  key and reason, then the command runs with the dependencies as they are. Codex and NanoGPT cannot
  refuse: the command waits at most 80 s and then runs (warn). Gemini's PreToolUse hook timeout grows by
  80 s. A command already running when an install starts is not stopped. A clone the registry does not
  know takes the worktree path above.
  An explicit `workspaceSetup` (not the default) also keeps the engine's own checkout of the repository
  (`repos[].path`, possibly a person's own working directory) installed (PM-1083, replacing the operator's polling `deps-watch.sh`): `refreshCheckout` in
  `full-test/workspace-dependencies.ts` runs for each configured repository at engine start
  (`engine-app.ts`) and after a merge `advance` that fast-forwarded a checked-out default branch
  (`onCheckoutAdvanced` in `engine-host/branch-merger.ts`, passed through `local-engine.ts`); it
  acts only when that checkout's real path equals the bound repository path. A fresh checkout (hidden npm
  lockfile not older than `package-lock.json`, `worktree/dependencies.ts` `dependencyState`) runs nothing;
  otherwise the same sandboxed preparation as a member clone runs in the background (copy from the
  `_merge-deps` store on an identical key, else sandboxed `npm ci`), with marker
  `<home>/workspace-deps/<sha256(JSON [project,repo])>/ready.json`, heavy-lock label
  `workspace-deps <project>/<repo> (checkout)` and a per-path single flight. It never throws or delays the
  merge: a failure is a log line and the next advance or start retries (10-minute memo). A newer advance
  during the install changes the key, so the run publishes nothing and starts over. Machine assumption:
  macOS/srt, npm and the repository checkout on the engine's own disk; a remote engine does the same
  locally, behind the same explicit `workspaceSetup`. Other worktrees are never touched.
  Target workspace ancestors must be real directories: component-wise `lstat` checks run
  during selection and immediately before every copy, rename and removal, including rollback
  and cleanup. Symlinked workspace paths skip the clone as unsupported. Node has no `openat`,
  so a small check-to-operation race remains; checks never deliberately traverse a replaced parent.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `worktree.refreshDependencies` (PM-313), find reference checkouts and probe the filesystem on the engine;
  retain the existing skip/install fallback on other platforms. When the engine installs nothing for a
  member workspace (`skipped`), `workspace.prepareDependencies` adds the optional
  `dependencies: 'missing' | 'stale'` (PM-1203; set only when the clone has a root `package-lock.json`
  and `dependencyState` is not fresh). The hub passes it to the context input, and the member prompt then
  asks a writer (not Codex) to run `npm ci` and a reader or Codex to `ask_human` without trying (PM-1112
  asked every writer unconditionally). The result is additive on the strict wire schema: install the
  hub first, then the engine. Member workspaces have no automatic clone. The server's installation
  cannot be cloned across machines, and native dependencies must match the engine. Keep the
  runner, registry, freshness checks and copies together on the engine; the callback is local
  there and adds no server/engine request.
  **Module:** `worktree`
- **Heavy-run queue and worker limits** — `full-test/{heavy-lock,heavy-lock-core,heavy-lock-dir}.ts`,
  `scripts/heavy/{cli,run}.ts`, `packages/shared/src/config/test-workers.ts` and the workspace
  `vitest.config.ts` files (PM-332, PM-336). Prompt descriptions of commands, unavailable exit status
  and PTY skips are opt-in repository `heavyChecks` settings (`context/system-prompt.ts`,
  `runtime/permissions/unattended-commands.ts`, PM-1112); engine environment variables and queue
  execution are unchanged. These descriptions are rendered on the server for local and remote engines.
  A per-user lock directory under
  `/tmp/projectman-<uid>/heavy` uses local atomic directory operations, PID liveness and
  heartbeats; worker limits use the executing host's CPU and memory. Same-host runs must
  use the same lock directory; different users are not automatically one queue. An unusable
  folder stops a member's heavy command (exit 78); the server's full test runs without the queue
  and warns (PM-346), except a merge check (`FullTestSpec.requireHeavyLock`, PM-658), which ends as
  `error` / `heavy_lock_unavailable` before anything starts.
  Optional merge dependency preparation (PM-710, connected to the card merge in PM-711) shares that
  mandatory reservation with the test (one acquisition, one `full_test_started`) and
  publishes at most one current and one temporary dependency generation per repository on this host.
  Member dependency preparation (PM-741) also requires this lock, labelled
  `workspace-deps <project>/<member>/<repo>`, waiting at most 30 minutes. Queue time is separate from
  the configured install timeout; an unavailable queue refuses preparation before installation.
  **Remote engine:** queue competing runs on each execution host and size workers there;
  `requireHeavyLock` and the `heavy_lock_unavailable` result cross the `full_test.run` boundary and the
  lock directory, PIDs and queue stay on the engine's machine. An older engine's strict spec schema
  refuses the field before running anything; the cloud then blocks the merge check with an
  "update the engine" message and does not repeat the request without the flag (PM-658).
  do not use the server's PID namespace, lock or hardware measurements for another engine. The
  engine supplies `SandboxPaths.heavyLockDir` from its own `defaultHeavyLockDir()` or setting,
  and with it the `StartSessionSpec.sandbox.portable` paths; its runner renders the Codex
  arguments and makes the folder (PM-311, PM-312).
  The FIFO test (`full-test/heavy-lock.test.ts`, PM-408) starts local child processes and waits
  for each named ticket to be readable through `readHeavyQueue` before starting the next;
  temporary files from atomic writes do not count as queued waiters. Run it on the execution
  host, using its own temporary directory and PID namespace.
  Since PM-311 the folder is `EnginePaths.heavyLockDir` of the session's engine (`contracts/engine.ts`).
  Idle closure asks that engine through `EngineHost.heavyRunSessions` / `host.heavy_run_sessions`
  (PM-569). PID and heartbeat checks run on the engine; only its own running session ids cross
  to the server. An unavailable or older engine returns no sessions, retaining normal idle closure.
  The queue does not apply in GitHub mode (`FullTestSpec.githubActions`, PM-900): the machine does not run the tests.
  **Module:** `full-test`
- **Server and engine log files** — `logging/{rotating-file,server-log}.ts`, `index.ts` (`loggerOptions`)
  (PM-444), exposed through `logging/index.ts` to `index.ts` and
  `engine-link/engine-audit.ts` (PM-649). Every process logs pino's JSON lines to the terminal and, since PM-444, to
  `<PROJECTMAN_HOME>/logs/server.log` (single mode and the cloud) or `logs/engine.log` (engine
  mode); the terminal's scrollback alone lost the older lines. The file is appended across starts,
  rotated at 10 MB (`server.log` → `.1` → … `.4`, five files, so about 50 MB at most), mode 0600 in
  a 0700 folder. It holds exactly the lines the terminal gets, with the same serializers (request URLs
  have invitation, hook and MCP tokens redacted; no headers, bodies or keys). A failing file write is
  reported once on the terminal and never stops logging there. The engine's per-request audit
  (`logs/engine-audit.jsonl`) uses the same rotation helper but is a separate file. Assumes a
  writable local home on the host that runs the process and one process per home.
  **Remote engine:** each process writes its own log on its own host: the cloud's under the cloud's
  home, the engine's under the engine's home. Logs are not shipped across the link; to read the
  engine's log, read it on the engine's machine.
  **Module:** `logging`
- **Session output folders** — `index.ts`, `engine-host/session-folders.ts` (`SessionFolders`),
  `engine-host/sandbox-dirs.ts` (`prepareMemberSandboxDir`, `preparePortablePaths`),
  `engine-host/session-roots.ts` (`defaultSessionTmpRoot`, `sharedClaudeTmpRoots`, the roots'
  preparation), `engine-host/local-host.ts` (opening the folders, the overlap check with the queue's
  folder), `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`, `session policy`) (PM-268, PM-333, PM-339, PM-312).
  `runtime/sessions/permission-broker.ts` uses the existing readable-root calculation directly
  (PM-960); policy rendering and folder operations remain in runtime and on the engine. Legacy Claude
  sessions, and Codex sessions whose sandbox writes (`workspace-write`), receive a per-process
  writable folder below the server's real `tmpdir`; the server makes, sweeps and removes it. Since
  PM-522 Gemini, NanoGPT and read-only Codex sessions get one too (`sessionFolderAccess`):

  | Session                                                        | Folder                                                     | Own TMPDIR, browsers, screenshots |
  | -------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
  | Claude; Codex or NanoGPT with `workspace-write` and a tmp root | write                                                      | yes                               |
  | Codex or NanoGPT read-only (`default`, `plan`, reader)         | read; only the server writes it                            | no                                |
  | Gemini                                                         | write by file tools under the hook gate (not in plan mode) | no                                |
  | `workspace-write` without a tmp root, `danger-full-access`     | none                                                       | –                                 |

  A read-only Codex or NanoGPT sandbox names the folder in `PROJECTMAN_SESSION_DIR`, reads it and
  opens its images with `view_image`, but does not write it. **Remote engine:** `folders.make` and
  `files.materialize_into_session` do not depend on the provider; an older engine's Codex adapter
  lacks the read-only `view_image` and the Gemini environment. The server removes the folder on the
  engine the session ran on (`Session.engineId`), not on every engine; a row without an engine asks
  all of them (PM-1128). A Codex session also gets its
  own short temporary directory, `<realpath('/tmp')>/projectman-<uid>-tmp/<home hash>/<12 random hex>`
  (`defaultSessionTmpRoot`, `SessionFolders.allocateTmp`/`make`), its `TMPDIR` and a writable root,
  removed and swept with the folder; without a safe tmp root Codex gets no folder. The root is 0700
  and a sibling of the heavy-run queue's parent `projectman-<uid>`, never below or above it (that
  parent is writable for every member's commands, so a path there could be pre-empted or read by a
  member; an overlap, compared as written and by canonical path through links, leaves Codex without a folder); a directory is new at every start and made
  without `recursive`, so a link put there beforehand stops the start. The path is short because a Unix
  socket's is limited to 104 bytes. The Codex adapter then closes the shared `/tmp` and the CLI's
  `$TMPDIR` for its commands.
  A legacy Claude session gets the same kind of directory (PM-353) and the Claude adapter's
  `launch` hands it to the CLI as `CLAUDE_CODE_TMPDIR`, so Claude Code's temporary root
  (`<CLAUDE_CODE_TMPDIR>/claude-<uid>`: the scratchpad, background command output, subagent
  output, `bash-edit-diff`) is the session's own instead of the machine's shared
  `/tmp/claude-<uid>`. The name is 12 hex digits (no session id) because Claude Code falls back to
  the shared root when the path is too long. The shared roots (`sharedClaudeTmpRoots`: `/tmp/claude-<uid>`,
  `<CLAUDE_CODE_TMPDIR of the server>/claude-<uid>`, `/tmp/claude`, each as written and by
  canonical path) are denied: to the file tools (`deniedPaths`), and to the commands of a
  developer's and a reader's sandbox (`denyRead`, `denyWrite`, with the own tmp re-opened). The
  tmp root's parent is closed to Claude sessions as well. A Codex session always gets the roots
  in `deniedPaths`. A Claude session without a safe tmp root (no folders, or an unusable root) runs
  as before and the shared roots are not denied for it (fail-open: the CLI still needs them).
  A session that is already running keeps its old rules until its next start.
  Fake app tests use `claudeTmpRoots: []` in `test/helpers/app-harness.ts` and
  `test/auth-restart.test.ts` instead of discovering the executing machine's shared Claude
  directories (PM-633). Tests that inspect these roots can supply explicit fixtures through
  the harness's `app` options. This test isolation leaves production root discovery and the
  server/engine boundary unchanged.
  Engine-host fixtures in `test/engines.test.ts` also supply explicit `claudeTmpRoots`
  (PM-635), so the remote/offline and engine-disk tests do not discover the user's directories.
  The tmp root is another machine-dependent assumption: a shared host-local `/tmp`.
  Every Claude session reads all the folders below the instance's root
  (`realpath(tmpdir)/projectman-sessions/<home hash>`), through the file-tool rules the policy
  renders (`filesystem.sessionFolder`, `sessionFoldersRoot`; `claudeToolRules`) and a developer's
  sandbox `allowRead`; it writes only its own folder. A resumed session gets a new folder, and its
  system prompt says that the old paths are gone and the card's attachments stay. Another
  instance's root (another home hash) gets no rule.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `folders.*`, `files.export` and `files.materialize` (PM-313), allocate and clean up on the executing host, generate its sandbox paths
  there, and transfer output through an authenticated attachment path rather than reading a
  remote absolute path on the server. The root is a property of the engine (the PM-312 host's
  file system), not of the server; the policy carries the two paths to the host that runs the
  CLI. A member reads only the folders of sessions on its own engine; images move between
  machines through `attach_file` → `read_attachment`. The Claude Code roots (`/tmp/claude-<uid>`,
  the server's `CLAUDE_CODE_TMPDIR`) are those of the engine's host too: compute `sharedClaudeTmpRoots`
  and allocate the session's tmp there, and pass `CLAUDE_CODE_TMPDIR` to the CLI on the engine.
  Since PM-311 the registry is `EngineHost.sessionFolders` (`EngineSessionFolders`) and the roots are
  `EnginePaths.sessionFoldersRoot`, `sessionTmpRoot` and `claudeTmpRoots` (`contracts/engine.ts`);
  `createLocalEngine` (`engine-host/local-engine.ts`) prepares them, with the same checks as before.
  Since PM-312 the disk work is the engine's too: `make`, `remove`, `sweep` and `releaseTmpRoot`
  are asynchronous (the domain awaits a session's pending removal before it makes the new folder at
  a restart, `Sessions.folderRemovals`), and the member's sandbox directory (0700) with its git
  settings (0600) is made by `EngineHost.prepareMemberSandboxDir`; a failure is the start's
  `session_start_failed` with `details.stage = 'member_sandbox_dir'`. The domain computes the paths.
  **Cloud mode (PM-315):** `RemoteEngineDirectory` (`engine-link/remote/host.ts`) makes, removes and releases
  the folders on the engine (`folders.*`, `host.*`) and keeps the paths in the hub's mirror, so
  `sessionFolders.of` answers without a call; a `link_down` while releasing the temporary root at stop is
  ignored (the engine cleans up when it is back).
  **Module:** `engine-host`

- **Card attachments (PM-644)** — `core/attachments/attachments/{service,storage,thumbnail}.ts`
  (through `core/attachments/index.ts`) and `contracts/attachments.ts`. Records and the private
  `<PROJECTMAN_HOME>/attachments` store belong to the server; local storage uses 0700 directories,
  0600 files and no-follow opens, and `sharp`/libvips generates thumbnails there.
  **Remote engine:** keep storage and image processing beside the server. Engine callers use
  the existing authenticated attachment/transfer boundary; their local paths are not server
  storage paths. No new RPC or payload is introduced by moving these files.
  PM-1059: the engine's cache folder of a card is on `projectEngine(projectKey)` and a file is given to
  the engine of the session that reads it (`runner.engineOf`, else the project's), never to another
  engine when that one is away; the stored files stay beside the server.
  **Module:** `core/attachments`
- **Message attachments (PM-516, PM-644)** — `core/attachments/message-attachments/` (through `core/attachments/index.ts`), `api/message-attachments.ts`, `mcp/attachments/tools.ts`
  (`read_message_attachment`), `mcp/server.ts` (`runTool`). The files of team messages live under
  `<PROJECTMAN_HOME>/message-attachments/<projectKey>/<id>` (0700 directories, 0600 files, `.thumb`,
  `.part`), written and read by the server process on its own disk (`O_EXCL`, `O_NOFOLLOW`), and
  reached only through the protected REST routes and the team tool. A session never gets a path into
  that store: `read_message_attachment` returns the content itself (an image, a small text), and for
  what the content cannot show (PM-518) a copy in the caller's own session folder (below).
  `contracts/sandbox.ts` includes the entire store in `sensitivePaths` (PM-524), denying
  direct file-tool and sandboxed shell access on the machine that hosts a session; authorized
  copies in its session folder remain readable. Remote engines use the same policy for their
  local app home and receive authorized files through the existing transfer boundary below.
  The unsent uploads older than 24 hours are removed by an hourly sweep and at startup.
  PM-1059 changes nothing here: the files stay on the server and the copy into a session folder goes
  to the session's own engine ("Message file in the session folder").
  **Remote engine:** the server (cloud) keeps the files and the database. The tool call reaches the
  server as `mcp.relay`, and an image travels back in the MCP result
  as base64 inside that frame. A frame is at most `ENGINE_MAX_FRAME_BYTES` (4 MiB), hence the
  downscale: the image is a WebP of at most 1568 px a side and 1 500 000 bytes (about 2 MB as
  base64), made on each request (`MessageImageRenderer`, `sharp`, the server's libvips). A text is
  at most 100 000 bytes. The home directory itself must be on one machine with the server, as for the
  card attachments. The hybrid move (PM-666) carries the store to the cloud's home as the entry
  `message-attachments` and brings it back with `hybrid back`, byte for byte.
  **Module:** `core/attachments`
- **Message file in the session folder (PM-518)** — `mcp/attachments/handler.ts` (`readMessageAttachment`,
  `sessionFileTarget`), `core/attachments/message-attachments/` (`source`, `locate`,
  `sessionFileName`), `engine-host/session-folders.ts` (`SessionFolders.materializeFile`),
  `engine-link/{methods,engine-handlers,engine-limit}.ts` (`files.materialize_into_session`),
  `engine-link/remote/host.ts`, `contracts/runner.ts` (`PROVIDER_MCP_IMAGE_RESULTS`). When the
  content of a message file is `none` (a PDF, a binary, a text too big), or an image for a provider
  whose CLI shows no image in an MCP tool result, the server has the caller's engine put a copy at
  `<session folder>/<id>-<name>` (0600, straight in the folder with no subdirectory since PM-523, see
  SECURITY.md; the same path for the same bytes) and the tool answers with that path. The caller is the session the MCP token names; the
  target is its own folder only, and a guest conversation of the Operator or of the project manager (no folder, `teamToolsOnly`)
  gets none. PM-1061: the copy goes only to the engine the session runs on, and the engine must be bound to the
  session's project (`files.materialize_into_session` is session-scoped, a project call is checked by the hub guard).
  A failure (engine offline or older, no folder, a disk error) is logged and the tool
  answers as before, without a path. `mcpImageResults` per provider: claude and codex true (Claude Code
  and Codex render an MCP `image` result), gemini and nanogpt false (the Gemini CLI has no place for
  one yet; NanoGPT is Codex over a custom provider, so it depends on the model): the first reading of
  an image gives them the file. Since PM-522 every provider has a session folder where the sandbox
  allows one (`sessionFolderAccess` in `runtime/sessions/session-policy.ts`: Gemini; Codex and NanoGPT with a
  writing sandbox or a read-only one), so a Gemini or NanoGPT session gets the path too. **Open:** that
  Gemini's `view_file` shows a PDF or an image to the model, and that a NanoGPT model uses
  `view_image`, are unproven; the path is returned either way.
  PM-1059: with several engines the copy goes to the engine whose folder the session has
  (`sessionFolders` of that engine), tested with two engines; no new RPC.
  **Remote engine:** the local engine copies from the server's disk (`O_NOFOLLOW`, a regular file,
  size and SHA-256 checked, staged in the folders root and linked into place). A remote engine gets
  the file with a single-use download token (`transfers.issueDownload`, the same way as
  `files.materialize`), `files.materialize_into_session` fetches it into a scratch directory of its
  own, checks size and checksum, and `SessionFolders.materializeFile` puts it in. The engine's limit
  allows the call only for a session whose folder `folders.make` created on it, with a plain name and a
  valid token. An engine without the method answers `unknown_method`, which counts as a failure above.
  **Module:** `mcp`
- **Browser installation and screenshots** — `index.ts`, `runtime/sessions` (`session policy`),
  `engine-host/screenshots.ts` (`resolveScenario`, `listImages`),
  `scripts/{browsers,shots}.mjs`, `scripts/lib/browser.mjs` (PM-268, PM-270, PM-312).
  Playwright loads local Chromium binaries from the configured browser directory (default
  `<PROJECTMAN_HOME>/browsers` in the server; the scripts also accept
  `PLAYWRIGHT_BROWSERS_PATH`). `shots` launches a disposable local instance and browser,
  and writes images to local output storage. For a Codex member, whose sandbox cannot start
  Chromium, the server runs `npm run shots` itself (`take_screenshots`, `get_screenshot_run`,
  PM-351): `services/full-tests/{screenshot-runs,screenshot-core}.ts`, `full-test/{screenshots,run-sandboxed,run-sandboxed-core}.ts` start it in the
  member's worktree inside the macOS `srt` sandbox, with the session's own read/write limits and
  the session folder as the output; it queues in the machine's heavy-run queue and is off outside macOS. Since PM-312 the scenario file is resolved and the images are
  listed by the session's engine (`EngineHost.resolveScenario`, `listImages`); a refusal reaches the
  member as the same `TeamToolError('invalid', …)` texts as before.
  **Which sessions get a screenshot scope (PM-1202):** a Claude or Codex CLI (Codex, NanoGPT) session in a
  checkout of the card (`screenshotPlacement`: `task_worktree` or `review_copy`) that has a session
  folder; `read_only` placement and Gemini get none. Where the session's own sandbox writes the folder,
  the run has its limits; for a reading Codex or NanoGPT sandbox the run writes only the session folder
  (`denyWrite` includes the checkout), and the browser directory comes from `EnginePaths.browsersDir` with a read exception.
  Scenario resolution sends only `{ cwd, sessionDir }` as roots, without the browser directory
  or sandbox settings, matching the strict `files.resolve_scenario` contract in hybrid mode
  (PM-785). This adds no machine-dependent operation and leaves the engine boundary unchanged.
  **Cloud mode (PM-315):** `screenshots.run/cancel` run on the session's engine
  (`services/full-tests/screenshot-runs.ts` takes a remote executor, announced by the engine's `screenshot_started`
  event); a run with no connected engine is refused as `engine_offline`. The scenario and the image list come from the engine (`files.*`).
  `index.ts` builds no local screenshot executor in cloud mode.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `screenshots.run/cancel`, `files.resolve_scenario` and `files.list_images` (PM-313), provision a compatible browser on the engine, preserve the disposable
  instance's network fence and read-only browser access, and return images as artifacts. The
  screenshot run belongs on the engine that owns the member's worktree and session folder (the
  server cannot run it against a remote path); the server keeps only the tool and the run record.
  Since PM-311 the browser directory is `EnginePaths.browsersDir` and the run is the
  `EngineHost.screenshotExecutor` of the requesting session's engine (`contracts/engine.ts`).
  **Module:** `engine-host`
- **Machine display and orphan processes** — `machine/{probe,parse}.ts`,
  `runtime/watchers` (`MachineMonitor.stopOrphans`), `api/machine.ts` (PM-320, PM-300).
  Demand-driven rounds and bounded request waits run on the server in
  `runtime/watchers/machine-rounds.ts` (Effect, PM-617); measurement and signalling stay
  behind the existing machine probe boundary.
  OS probes (`ps`, macOS `vm_stat`/`sysctl`, Linux `/proc`) measure the local host; trees,
  ownership checks and signals use its UID and PID namespace, with process start times
  checked against PID reuse. **Remote engine (engine mode, PM-314: runs in the engine process):** use `machine.snapshot/processes/env_values/signal` (PM-313), measure and stop on the owning engine,
  identify the engine with every process identity, and preserve fresh ownership/orphan
  checks and owner access (the host owner's, not every project's owner, PM-1058). A remote PID must never be signalled on the server.
  **Cloud mode (PM-315):** `RemoteMachineProbe` (`engine-link/remote/machine.ts`) asks the default engine
  (`machine.snapshot/processes/env_values/signal`; `MachineProbe.signal` is asynchronous for it); with no
  engine the machine view answers `engine_offline` (409). Since PM-1059 "the default engine" is
  `EngineDirectory.hostEngine()`, asked at every call: the view, the identity and the signals of the
  orphan round always target the same host machine and never a project's engine.
  **Filtered diagnostics (PM-697):** `services/coordination/project-state.ts` projects only
  CPU percentage, memory, sample time and free disk space through the assembly adapter.
  The latest card session selects the stored engine id; no session, offline or a different
  engine than the monitor's gives `machine: null`. Disk space comes from that same
  `EngineHost`. In v1 cloud mode always returns `machine: null`: the monitor's snapshot
  and CPU reference carry no engine identity or measurement generation, so a fresh
  timestamp alone cannot prove their origin. A future cloud metrics source must bind
  both to the owning engine and measurement generation. Server task, delivery
  and check records remain readable offline. No process details or transcripts are exposed,
  and no new probe or RPC is introduced.
  **Module:** `machine`
- **Instance identity for process attribution** — `app.ts` derives the first 16 hex characters of
  `sha256(realpath(home))`; `runner/env.ts` supplies `PROJECTMAN_INSTANCE` alongside
  `PROJECTMAN_SESSION_ID` (PM-320). This identifies a local installation by its home path,
  not a host-independent engine identity. PM-698 adds
  `PROJECTMAN_SCOPE_ID=scp_<16 random hex digits>` for each process start.
  A resumed conversation gets a new scope generation. Engine recovery requires the engine's own
  instance tag and uid; nested installations cannot adopt one another's marked scopes.
  **Remote engine:** plan instance/engine attribution
  explicitly, including reconnects and moves; equal paths on different hosts must not imply
  equal ownership.
  **Module:** `entry`
- **Session process termination** — `runner/session.ts` (`stop`, `kill`),
  `runner/runner.ts`, `runner/process-scope/{types,process-group,index}.ts` (PM-698).
  Each engine owns the scope of every session, including marked detached children. Pipe sessions
  start as process-group leaders; PTY sessions use forkpty/setsid. Closing sends TERM, polls for
  up to 5 s, then KILL and polls for up to 2 s. Individual signals recheck uid, pid/start time
  and generation; group signals require verified current members. Natural exit, stop, forced stop,
  startup failure and shutdown all close; idle turns do not. Startup recovery adopts this instance's
  marked scopes. `db/session-cleanups.ts` and `runtime/sessions/cleanup-failures.ts` retain every
  unresolved scope in `session_cleanups` (including chat, Operator and legacy worktree sessions),
  atomically with any member-workspace failure flag. The server retries at startup and every
  minute through `session.close_scopes` on the owning engine.
  The optional `sinceAgeMs` lower bound is an age derived from stored server-side start/failure
  times. The engine computes `clock.now() - sinceAgeMs - SCOPE_SINCE_MARGIN_MS` on its own clock;
  differing server/engine wall clocks therefore do not affect attribution. The 60 s margin covers
  transport delay and process-list time precision. PM-933 restricts unreadable candidates to those
  potentially related to the scope: they share the known leader's or an identified member's process
  group, or their parent chain reaches an identified member before a different scope marker or an
  ancestor older than the bound. Readable ancestors without markers are traversed. Parent chains
  use the same process snapshot, with cycle detection and a 256-ancestor limit; unresolved cycles
  or depth limits remain unverified. Unrelated orphans (launchd/XPC helpers on macOS included) and
  missing parents outside the scope's groups do not block best-effort cleanup. Without an age
  (an older server), ancestry has no time bound. Explicit marker matches are checked regardless of
  age. Failed and unverified closes retain known identities and the leader group for later retries;
  only clean closes discard them. Entire process/environment probe failures remain unverified.
  Dismissing an Operator notification cannot clear this fact. Session folders and task worktrees
  stay while cleanup is unresolved.
  Resume is refused while cleanup failed; only a matching clean generation releases the holder.
  The `process_group` driver is `best_effort`: a child that escapes the group and clears its marker
  cannot be attributed. Without a process list cleanup is `unverified`, never `clean`; PM-701 adds
  contained Linux cgroups. **Remote engine:** inspection, signals and recovery run on the engine.
  Exit carries `SessionCleanup` only after closure; failed cleanup holds the workspace and raises an
  owner-facing Operator signal, later `scope_recovered` releases it. Old engines without cleanup
  retain the process-probe fallback. A remote pid is never signalled on the server.
  **Audited release (PM-935):** when a cleanup cannot be proven clean, the owner, or the
  Operator on the owner's explicit request, runs the `workspace_release` super command
  (`scopeId`, mandatory `reason` without hidden or control characters; a routine mutation with no
  owner-reserved effect, reachable only through the integrator/owner super path, never by members).
  The Operator's `execute_operation` enforces the owner's request on the server: it runs only when
  the open request is the owner's own message or answer, never a queue item (`operator_owner_only`). `SessionOrchestrator.releaseCleanupScope`
  calls `CleanupFailures.release`, which in one transaction frees the member workspaces held under
  that scope and deletes the `session_cleanups` row, then appends the append-only
  `workspace_released` timeline event (scope, session, workspaces, reason, actor) and emits
  `session_cleanup_released`, which resolves the Operator signal. The minute retry skips a
  `closeScopes` result for a scope whose row is gone, so a late failed result cannot re-insert it;
  startup recovery is not guarded. **Remote engine:** only server-side SQLite state changes. No
  engine call is made, and the retry stops because `closeScopes` is sent only server rows, so any
  surviving process on the engine is left running and unmanaged.
  Lifecycle tests use `runner/test-helpers.ts` (`fixtureScopeProcesses`) and identity records from
  `test/fixtures/fake-tui.mjs`, with null-signal liveness checks limited to disposable fixture pids.
  This keeps pipe and PTY tests independent of host-wide `ps` permissions; production inspection
  and the remote-engine boundary remain unchanged (PM-698). The fake-CLI app harness
  (`test/helpers/app-harness.ts`) uses the same fixture process source for its runner, so
  conversation/resume tests do not depend on inspecting unrelated host processes (PM-928).
  **Module:** `runner`
- **Conversation transcripts and resume** — `runner/transcript/{reader,tailer,confined}.ts`,
  `runner/session.ts`, `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`), `runner/providers/{claude,codex}/transcript.ts`
  (PM-340). NanoGPT uses the separate home in **NanoGPT Codex home and key delivery** (PM-329).
  The reader selects the shared Codex transcript format with `usesCodexCli` from
  `packages/shared/src/domain/provider-model.ts` (PM-330); this changes no path or engine assumption.
  Claude conversations live under `~/.claude/projects`; Codex rollouts under
  `CODEX_HOME/sessions`. The server reads and tails hook-reported files, and resume eligibility
  checks transcript content. A task session's cwd is the member's workspace, whose path uses the
  member's storage handle (PM-1024), so a rename of the member leaves the cwd, and with it the
  conversation's place under `~/.claude/projects`, unchanged.
  PM-342 adds `TranscriptReader.summary` (`runner/transcript/summary.ts`): when a member's new
  conversation replaces one that could not go on (provider changed, lost, moved) or a card is
  handed over without a note, the server reads the old transcript for the CLI's compaction
  summary plus the last replies (at most `HANDOFF_SUMMARY_MAX` = 8000 characters) and puts it in
  the new conversation's first message.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `transcript.has_content/read/summary` and runner events (PM-313), keep CLI conversation state and resume checks on its engine/account,
  stream conversation events to the server, and preserve confinement. A conversation ID
  without its engine's saved state is insufficient for resume. `summary()` runs on the engine,
  next to the conversation; only the `HandoffSummary` (at most 8000 characters) crosses the
  server/engine boundary.
  PM-766 carries the public super-mode `Actor` (id/prefix, never the bearer secret) from
  `core/messages/messaging.ts` and `runtime/delivery/delivery.ts` in a separate injected metadata
  line. The shared chat formatter/parser and `runner/transcript/chat-items.ts` preserve it in
  `ChatItem.actor` for single, information and batched messages. On a remote engine the same
  injected text travels to the engine; live chat and `transcript.read` return this display
  provenance to the hub. Missing or invalid metadata keeps historical rendering and grants no rights.
  Since PM-311 a session records its engine (`sessions.engine_id`, `Session.engineId`), the transcript
  reader calls carry the optional `engineId`, and a conversation resumes only on the same engine (a
  different one counts as `relocated`).
  **Cloud mode (PM-315):** `createRemoteTranscripts` (`engine-link/remote/transcripts.ts`) asks the session's
  engine (`transcript.has_content/read/summary`); the transcript text crosses as a single-use transfer.
  **Module:** `runner`
- **Hooks and team MCP over loopback** — `index.ts` (`loopbackBaseUrl`),
  `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`, `LiveSessions`), `runner/runner.ts`, `runner/hook-forwarder.ts`,
  `kernel` (`nonLocalReason`), `runner/providers/{claude,codex}/args.ts` (PM-341; PM-286, PM-310,
  PM-311). CLI hooks and MCP target the server's loopback URL (`127.0.0.1:4800` for the live
  instance; the port is configurable). The internal guard also checks the peer, Host and
  forwarding/origin headers; merely changing the URL to a public server cannot work.
  **Codex team server stays optional (PM-1070):** `runner/providers/codex/args.ts` passes
  `mcp_servers.team` with only its stdio bridge (`command`/`args`, PM-1170; the `url` until then)
  and tool approvals. PM-1055 had set
  `required = true`, a 20-second startup timeout and `mcp_optional_startup_grace_ms = 0`;
  from that deploy every Codex session exited at start ("agent CLI exited before it was
  ready"), so it was reverted. A failing team MCP must cost the tools, not the session.
  The root cause of the team MCP start failure is investigated separately.
  **Remote engine:** unchanged; the token-bound loopback relay supplies the catalog. PM-1061: the relay (`mcp.relay`)
  serves a token only when its session runs on the requesting engine and the session's project is bound to that
  engine; another owner's engine cannot reach a project it is not bound to through a stolen or guessed token.
  **Team MCP relay log (PM-1072):** the engine logs each `initialize` and `tools/list` relay
  (method, status, elapsed time) at info, and every refused (non-2xx), failed or badly
  answered relay at warn; the cloud logs why it refused a relayed token. Neither logs the
  token or the body. A Codex session without team tools therefore shows in the engine log
  where its handshake stopped (no call, a slow one, a refusal); the cause of the intermittent
  missing tools was not yet reproduced with a real Codex run.
  Submission timeouts (PM-442) log retry count, elapsed time, command/idle state and bounded
  CLI diagnostics from `runner/input-queue.ts` and `runner/session.ts`: prompt/resume flags,
  the last hook name/time, blocking-screen detection and at most 500 characters from the last
  15 terminal rows. Message bodies are not logged separately. This assumes the runner owns
  the terminal and receives the CLI hooks.
  **Idempotent delivery (PM-1205):** the wait for the submit report builds on the timing of these
  loopback hooks. A typed message the CLI did not report within `submitTimeoutMs` is taken as
  unconfirmed when the main agent's turn hooks (or a busy CLI) show it worked, and is otherwise
  awaited `lateSubmitMs` longer (`runner/input-queue.ts`, `runner/session.ts`, `runner/providers/*`).
  The hub keys each delivery (`deliveryId`, `runtime/delivery/delivery.ts`), `session.send` carries it
  across the server/engine boundary (`engine-link/{methods,protocol,engine-handlers}.ts`,
  `engine-link/remote/{hub,runner}.ts`; the engine advertises `deliveryIds` in its hello, an older
  engine gets none), and the engine's runner does not type a taken id again, per process.
  On a remote engine these diagnostics run and are logged on that engine; the only new
  thing that crosses the server/engine boundary is the `deliveryId` of a message.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `permission.decide/cancel/forward_question`, `refused` events and `mcp.relay` (PM-313), plan an authenticated engine transport/local relay for hooks, decisions
  and MCP while preserving token isolation and the internal endpoint guard.
  `runtime/sessions/permission-broker.ts` owns the broker and uses the command policy
  directly (PM-960); no hook payload or transport changes.
  **Cloud mode (PM-315):** the cloud registers no hook routes (`registerHookRoutes` is empty) and listens
  on no loopback for the CLIs. `permission.*` and `mcp.relay` are handled by `engine-link/remote/handlers.ts`;
  the relay runs the request through the cloud's own `/mcp/<token>` route and answers 404 for a token whose
  session runs on another engine.
  **Module:** `runner`
- **Private session launch configuration (PM-156)** — `runner/session-config.ts`, `runner/runner.ts`,
  `runner/hook-forwarder.ts`, `runner/session.ts`, `runner/providers/{claude,codex,nanogpt,gemini}`,
  `contracts/sandbox.ts` (`SESSION_CONFIG_DIR`), `app.ts`, `engine-app.ts`. The MCP and hook tokens are
  not on a command line: the runner writes them to `<app home>/run/<session id>.<random>/` (the folder
  0700, files 0600, one folder per start, removed when the session's process has exited, orphans swept
  at start-up) and gives the CLI the file paths (`--settings`, `--mcp-config`) or the forwarder the
  path of its target file. Codex and NanoGPT get `codex-mcp.json` (PM-1170): the team MCP server is a
  Node stdio bridge (`runner/mcp-bridge.ts`, the runner's own Node binary) that Codex starts as a child
  and that reads the URL from that file. **Machine assumption:** POSIX file modes and ownership on the disk of the
  machine that runs the CLI, and the machine's process list (`ScopeProcessSource`) for the sweep; the
  sandbox rules keep the session's own commands and file tools out of the root.
  **Remote engine (engine mode):** the folder, the files and the sweep live on the engine that spawns
  the CLI: `engine-app.ts` passes `<engine home>/run` as `sessionConfigRoot`, and the sandbox rules name
  the engine's own paths, so nothing crosses the server/engine boundary and the cloud never sees a file.
  The Codex bridge runs on the engine too and reaches the same engine-built `mcpUrl` Codex used to reach.
  The cloud's runner (`engine-link/remote`) creates no real runner and needs no root.
  **Cloud mode (PM-315):** unchanged; the token still arrives with the start command and is written on the
  engine. Related: "Session output folders", "Hooks and team MCP over loopback", "Native sandbox and
  canonical paths" (the root is in `sensitivePaths`).
  **Module:** `runner`
- **Work volume (PM-846)** — `engine-host/work-roots.ts` (`resolveWorkRoots`, `WORK_ROOT_MARKER`,
  `WorkRootError`), `engine-link/engine-config.ts` (`workRoot`), `engine-app.ts`, `app.ts`,
  `index.ts` (`PROJECTMAN_WORK_ROOT`, single mode only), `scripts/engine/{commands,move-work-root}.ts`
  (`npm run engine -- move-work-root`). An optional work root puts `worktrees/`, and `workspaces/` below one
  directory, so that a separate APFS volume with `.fseventsd/no_log` takes the file churn that made
  `fseventsd` grow to 17 GB. The full test's `pmft-*` run directories stay in `os.tmpdir()` (PM-848): the full
  test sandbox denies the home for reading and allows only the run's own directory, so a run directory
  inside the home leaves its parents unreadable. Absent: the
  paths below `PROJECTMAN_HOME`, as before. The start fails closed (`work_root_invalid`): an absolute
  path, an existing directory, a regular `.projectman-work-root` file in it (an unmounted volume is an empty
  directory on the system volume) and a real path strictly inside the real home. Inside the home, because the
  session sandboxes keep the other members' work unreadable by denying the home. The code uses only the real
  path (Seatbelt compares real paths). Machine assumption: an APFS volume mounted at a path inside the
  home (fstab/`vifs`), steps in `docs/DEPLOY.md` "Separate work volume on a Mac". The sessions' `$TMPDIR`,
  the Claude temp directory and `member-caches` stay where they are (Unix socket path limit, PM-339).
  `move-work-root` runs with the engine stopped: it copies, repairs the git links, checks them, renames
  the old directories to `*.pre-PM-846` and then writes `engine.json`; no database migration, because the
  sessions' relocation and the workspace generation start a new conversation with a summary.
  **Remote engine:** yes. The setting is in that machine's `engine.json` and the volume step runs on the
  engine's machine; `EnginePaths.worktreesRoot/workspacesRoot` already describe the engine's own paths, so
  nothing new crosses the server/engine boundary. On Linux there is no `fseventsd`; the marker check is
  platform independent and a separate disk works the same way.
- **Task worktrees and shared git storage** — `worktree/worktree-manager.ts`,
  `worktree/member-workspace-manager.ts`, `worktree/paths.ts`, `runtime/watchers` (`WorktreeSweep`),
  `index.ts` (PM-243; PM-311, PM-312; PM-770). With a work root (PM-846) the worktree and workspace
  roots are `<workRoot>/worktrees` and `<workRoot>/workspaces`. Since PM-1115 the sweep lists existing
  task worktrees once per repository on every connected engine holding the project (`listTaskWorktrees`),
  then checks only those cards in the server database. Status and removal run on the same engine that listed them.
  Task worktrees default to
  `~/.projectman/worktrees/<project>/<task>-<repo>`; git links them to the main repository's
  common git directory. Canonical paths, branch ownership and cleanup are local filesystem
  operations. A member's workspace (`<workRoot>/workspaces/<project>/<member>/<repo>/repo`), its
  `.home`, its sandbox directory (`member-caches/<project>/<member>`) and its `member_workspaces`
  row use the member's storage handle (PM-1024), so a rename does not move them; the
  `MemberWorkspaceKey.member` the server sends to the engine is that storage handle, and the engine
  RPC schema is unchanged. PM-368's `core/messages` and `runtime/delivery/delivery.ts` also use
  `SessionOrchestrator.sourceHead` to snapshot the local branch for sent messages and input batches;
  PM-342's `runtime/admission` (`HandoffService`) uses it for the branch, last commit and uncommitted state of a handoff note or fallback.
  PM-712 uses the existing engine-local `sourceHead` read again before loop triage and human
  fallback, so a review fix committed since detection closes the loop. Only commit/time facts
  reach the server; unavailable heads never count as progress. No new git or shell capability.
  PM-818: `runtime/sessions/sessions.ts` resolves an unassigned card's source engine from its latest
  branch-bearing `work` binding's member placement, in the same order as `MemberWorkspaces.workOf`.
  With no such binding it uses the latest task session with a branch or reviewed commit (including legacy
  remote task worktrees), read by the bounded `SessionRepository.latestSourceOfTask` query.
  If the card has no assignee, no work binding and no source session, and LOCAL is not registered, there is no engine source to read:
  `sourceHead` returns null without RPC. Single-machine assembly always registers LOCAL; a registered
  but disconnected engine and a recorded developer workspace retain strict read failures (a stage
  hand-over for review reads strictly since PM-1110: `engine_offline` refuses the move). Remote git
  still runs on the selected engine; no engine path is read by the hub and no RPC contract changes.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `worktree.*` and `workspace.*`, run this git query beside the worktrees and return the attributed branch head
  to the server for its version and input formatting; maintain repositories/worktrees and git metadata there;
  plan branch/commit transfer and remote status/cleanup rather than treating server paths
  as shared storage.
  **Handing a commit over (PM-739):** a member workspace is an independent clone without a remote, so
  the repository, the reviewers and the merger do not know a developer's commit.
  `MemberWorkspaceManager.publishTaskBranch(key, taskKey, branch, commit)` (RPC
  `workspace.publishTaskBranch`, params `[key, taskKey, branch, commit]`, result strict `{path, ref}`)
  runs on the engine that holds both the developer's workspace and the repository: it checks that the
  commit is on the developer's task branch, takes the branch tip through `WorkspaceAccess.transfer`
  (the same keyed lock and isolated git as every other workspace operation) into a temporary
  `refs/projectman/incoming/<member>/<TASK-KEY>/<random>` ref, proves the commit is in the fetched
  history and creates `refs/projectman/workspaces/<member>/<TASK-KEY>/<commit>` in the repository only
  if it is missing (`update-ref` with a null old value; an identical object id is accepted, another
  one is refused). Nothing else of the repository moves: no push, no remote, no branch write, and
  snapshots are retained while the card is open and for three days after closing (PM-1115).
  The cloud sends no path or ref; `engine-limit.ts` binds the repository
  and checks the full object id. A review round pins `sourcePath/sourceRef/sourceCommit` to the
  snapshot; rounds pinned before keep their direct workspace path. A task branch can also be found
  through its snapshots (`findTaskBranch`); several distinct commits are chosen only by the exact
  one named. An engine that does not know the RPC makes the hand-over fail with
  `workspace_source_missing` (`details.reason: engine_update_required`). **Does this work on a remote
  engine?** Yes: the workspace, the repository and the transfer are all on the engine; only the
  request and the `{path, ref}` answer cross the link.
  PM-1115: both managers share `withRepoLock` (`worktree/paths.ts`), keyed by the canonical repository path.
  A workspace lock is always taken before that repository lock. `fetchBase` holds it for the origin fetch
  and base selection, `publishTaskBranch` for receiving and writing refs, and `removeTaskSnapshots` for deletion.
  `MemberWorkspaceManager.listSnapshotTasks` lists task keys from snapshot and incoming refs; the server filters
  them by closing time, sessions and active merges, then sends batches of at most 100 keys to `removeTaskSnapshots`.
  One `update-ref --no-deref --stdin` transaction deletes only the selected refs with their expected object ids;
  branches stay intact. Reopening a task can publish its snapshot again from its durable member clone.
  All git commands and locks live on the owning engine. The three additive RPCs
  (`worktree.listTaskWorktrees`, `workspace.listSnapshotTasks`, `workspace.removeTaskSnapshots`) carry
  project/repository identifiers, task keys and the listed worktree paths; the hub never reads engine paths.
  **Design review before stage hand-over (PM-828):** a member with `ux_design` and without
  `implementation` duties, who is not the assignee, uses a review copy whenever another member
  has a branch-bearing work binding on the card, in any stage. Planning without such a binding
  keeps its writable workspace. A developer's action message starts a new round on the current
  developer tip through the same immutable snapshot transfer, including after a rebase. A manual
  design-review resume also starts a new round when the developer tip changed. A running
  planning session is marked for restart too; its current turn finishes before the review starts.
  Its local branches remain intact. `REVIEW_DUTIES`, stage hand-over pins and the RPC contracts
  stay unchanged. The design review runs on the engine beside the other member workspaces;
  no path is read on the hub and no new machine assumption is introduced.
  **A fresh base at every start (PM-740):** a member workspace has no remote, so its default
  branch goes stale unless the server fetches it. `MemberWorkspaces.prepare` calls
  `MemberWorkspaceManager.fetchBase` (RPC `workspace.fetchBase`, unchanged) once per session
  preparation, after the reservation and `ensure` and before any checkout: for new and continued
  developer sessions and for new and continued reviews. A failed fetch is `workspace_fetch_failed`
  and the session does not start (the reservation is released). The fetch moves only
  `refs/remotes/upstream/<default>` (forced, so it shows the fetch result) and fast-forwards the
  member's own default branch when it is not checked out and does not diverge (a divergence is
  logged, never overwritten); the task branch, its files and the binding's `baseCommit` or review
  pins of a continued round stay as they are, and a new task or review round pins the commit
  fetched for that start. A reviewer's valid action message to the assignee's running session is
  preceded by `SessionOrchestrator.refreshWorkspaceBase(config, task, member)` (from
  `runtime/delivery`), the same fetch without a start or checkout; when it fails the message stays
  waiting and is retried. **Does this work on a remote engine?** Yes: the fetch runs on the engine
  that holds the workspace and the repository; only the existing RPC crosses the link.
  Since PM-311 the worktrees are `EngineHost.worktrees` (and `memberWorkspaces`) of the session's or
  card's engine, and the project's directory is `EngineHost.workspacePath` (`contracts/engine.ts`).
  PM-741 adds a read-only consumer of the engine's `_merge-deps/<sha256(JSON [project,repo])>/current`
  store: member dependency preparation copies a complete matching generation under the same heavy
  lock, replacing only validated package trees. Member installations never publish into this store.
  PM-797: the close of a collecting card with no code of its own reads no worktree or source commit; it decides on
  the hub's data (`TaskRepository.sourceEvidence`), so a missing or offline engine does not hold it back.
  **Cloud mode (PM-315):** the worktrees are the engine's (`worktree.*`, `workspace.*`). The local worktree manager object still exists, unused, because `DomainOptions.worktrees`
  is required.
  **Module:** `worktree`
- **Free-disk admission guard** — `runtime/watchers` (`DiskGuard`, engine `freeDiskBytes`),
  `runtime/admission` (`Admission`) (PM-243). `statfs(PROJECTMAN_HOME)` supplies the local free-space
  value for `minFreeDiskGb`; a low value defers new sessions. With a work root (PM-846) the engine
  reports the smaller of the home's and the worktrees volume's free space. It does not measure other
  hosts or even every local worktree volume. **Remote engine (engine mode, PM-314: runs in the engine process):** use `host.free_disk` (PM-313), report capacity for the
  engine's execution/storage volumes and plan admission against those as well as server
  storage; keep unavailable measurements distinct from low capacity.
  Since PM-311 `DiskGuard` asks the target engine's `EngineHost.freeDiskBytes` (`contracts/engine.ts`);
  since PM-312 the `statfs` itself is `freeBytesOf` in `engine-host/disk.ts`, not in `domain/`.
  **Cloud mode (PM-315):** the engine directory answers with `host.free_disk` of the target engine.
  PM-1059 keeps the target: the member's (or the session's) engine that admission already resolved, with
  no host fallback; no new machine operation.
  PM-1133 shares concurrent admission measurements per engine. After the one-minute freshness period,
  a measurement younger than five minutes answers while `host.free_disk` refreshes in the background;
  older or missing measurements wait for the engine. The disk watcher still measures afresh.
  **Module:** `runtime/watchers`
- **Control socket, pause and deployment** — `control/socket.ts`, `runtime/sessions` (`PauseService`),
  `scripts/control/{client,cli}.ts`, `scripts/migrate/instance.ts` (PM-219, PM-143).
  `PROJECTMAN_HOME/control.sock` is a local Unix socket (0600), authorised by filesystem
  access. Pause and shutdown act through the local runner; activation checks local instance
  markers and database use. Deployment scripts using the control client need access to that
  host's socket (see [DEPLOY.md](DEPLOY.md)); the client is not a remote engine API. The socket's system-wide
  pause right is unchanged; the app's instance pause (`POST /api/pause`) is the host owner's (PM-1058).
  An engine's own shutdown pause (PM-1159) is a third scope, `engine` (`pauses.engine_id`; kind `shutdown`, source
  `system`, one open per engine), kept in the hub's database and invisible to the team's views and gates; the
  engine runs only the session-level calls for it, so it works the same on a remote engine. A hub restart hands the
  sessions of an engine that has not connected yet to that pause (nothing starts on an unreachable engine), and the
  engine's next connection resumes it.
  `publish_release` (PM-968, `services/releases/publications.ts`; the durable row is `release_publications`):
  the tag is made and pushed on the engine that holds the repository (`merge.remote_tags` lists the tags of the base's
  upstream, `merge.push_tag` makes an annotated tag on a commit and pushes it, never forced, `--no-verify`; checked in
  `engine-limit.ts` like `merge.push`), and the GitHub release on the `github.*` engine (`github.publish_release`:
  `gh release view`, then `gh release create --verify-tag`, the owner's gh login; `engine-limit.ts` binds no
  repository for it, like the other `github.*` calls). Only the commit, the tag name, the notes and the URL cross the
  boundary; an engine from before PM-968 answers `unknown_method`, which the publication reports as
  `release_publish_failed`. The engine of the call is `engines.engineFor(projectKey, member)`, local when there is none.
  PM-1059: the GitHub release goes through the project-aware `GithubService.publishRelease(projectKey, ...)`,
  which the cloud sends to `projectEngine(projectKey)`; the `github.*` RPC and its parameters are unchanged.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.pause/force_pause/release/stop` (PM-313), keep the administrative socket local, propagate pause/stop to engines
  with acknowledgements and reconnect handling, and require the existing human deployment
  decision before activation; local process exit is not proof that remote work stopped.
  **Cloud container (PM-317):** the control socket stays local; there is no admin relay (PM-1113).
  the platform stops it with SIGTERM, which the entrypoint forwards to the server (its own
  shutdown pause and stop) before Litestream ships the last writes and the process ends. A
  deployment is replacing the container; the restored or rehearsed copy is a `standby` home
  (`instance.json`) that starts no session, and only one container may replicate into a replica.
  (PM-318: `instance activate` from the `engine` role, the way back to the single-machine mode, also
  needs the person's statement that the cloud is retired, no running engine and a database that
  holds the cloud's `engines` row, so that a stale pre-hybrid database never replaces the cloud's work;
  `--discard-cloud-data` states the opposite on purpose.)
  **Module:** `control`
- **Native sandbox and canonical paths** — `runtime/sessions` (`session policy`),
  `engine-host/{disk,within,work-roots}.ts`, `runner/providers/claude/args.ts`, `worktree/paths.ts`, `index.ts`
  (PM-846: a work root is used by its real path and lies inside the real home, so the `denyRead` of the
  home keeps the other members' worktrees unreadable; the engine limit's session roots name
  `<workRoot>/worktrees` and `<workRoot>/workspaces`)
  (PM-87, PM-333, PM-355, PM-312, PM-425; the canonical-path and directory checks of the domain are the
  engine's `realpath`, `isDirectory`, `isRealDirectory`). `runtime/sessions/permission-broker.ts` (PM-960)
  uses `EngineHost.realpath` to validate the tool's working directory and uses the runtime's
  policy functions directly; path validation still
  runs on the session's engine and requires no new RPC.
  PM-691 fixes the Operator's effective approver to `human` on the server through
  `packages/shared/src/config/permission-level.ts`, including historical session overrides.
  `runtime/sessions/{sessions,launch}.ts` checks updates and carries the effective member into
  the existing start/context path; `runtime/sessions/permission-broker.ts` uses it for human routing. Local and remote
  engines consume the same start intent. This changes no OS assumption or RPC and never
  turns a CLI escalation into boundary authorization.
  Legacy Claude execution uses the CLI's native sandbox (macOS Seatbelt); allow/deny paths
  are local and canonicalised, including `/var` → `/private/var` and real temporary paths.
  The member's "Outbound network" setting (PM-355) becomes `SessionPolicy.network.outbound`; a
  Claude member with it on gets the sandbox network allowlist `*` minus the blocked hosts, with it
  off only the npm registry.
  Codex has its own permission mapping in `runner/providers/codex/args.ts`: local sessions
  receive an inline `projectman` profile extending `:read-only`, with `sensitivePaths` and
  the adapter's Codex home denied (PM-356).
  PM-1172: with the outbound network on, a macOS engine and not a NanoGPT member, the profile also
  carries Codex's `network` part and `features.network_proxy=true`. Codex's network proxy runs on
  the engine, on its own loopback port per session; the denied hosts are the engine's own loopback,
  private and link-local addresses (the hook and MCP listeners among them) and the Unix sockets
  (the `control.sock` among them) stay closed. Verified on macOS 14.6 arm64 with codex-cli 0.159.1
  only; on a Linux engine (bubblewrap, seccomp) the runner leaves the network closed, because no
  probe covers it. `SessionPolicy` crosses to the engine as data in `session.start`; the platform
  guard decides on the engine.
  PM-360 adds the shared `SessionReadBoundary` schema and optional
  `AgentSandbox.portable.readBoundary` to the strict `session.start` contract. Under the owner's
  2026-10-26 scope decision, developer runtime paths do not automatically populate it:
  absent on a writing placement means the existing broad non-sensitive home reads and session/tmp
  behavior; reading placements require a boundary (PM-1175). Explicit boundaries
  contain reopenable roots and typed file/directory exceptions, separate from unconditional
  policy/adapter denials. Local adapters resolve lexical/physical paths and reject invalid
  explicit inputs using the shared `runner/tool-decision.ts` matcher (exported through
  `runner/index.ts` for the engine): glob component boundaries, case handling and macOS
  `/System/Volumes/Data` firmlink aliases have one implementation. The engine
  (`engine-link/engine-limit.ts`) adds its own homes/temp roots and checks
  exceptions and required private directories when a boundary is supplied. PM-1175 refuses reading
  sessions without a portable read boundary and builds Claude's `denyRead`/`allowRead` from the
  engine's canonical boundary, including realpath aliases for allowed paths. The checks run on
  the remote engine with the existing boundary data; no new data crosses the link. Existing
  engine-root, permission-mode, environment and sensitive-path checks always apply.
  PM-425 populates it for every reading session (`placementReadsOnly`: a `read_only` placement,
  a review copy without the test permission, a taskless chat, the non-super Operator) and for
  every provider: `sessionSandbox` (`runtime/sessions/session-policy.ts`, `readerReadBoundary`)
  builds one list; `launch.ts` copies it into `policy.filesystem.readBoundary` (new optional
  field, `SessionPolicy.version` stays 1) and `withReaderDenials` adds `~/.claude/projects` to the
  reader's `deniedPaths`. Rendered from it: Claude's `denyRead`/`allowRead` and file-tool rules
  (`claudeToolRules` drops the blanket `Read`/`Grep`/`Glob` allow), the PreToolUse refusal and
  `permissionRequest()` in `runner/session.ts` (`readBoundaryVerdict` in `runner/tool-decision.ts`),
  Gemini's `decideToolCall` and the Codex/NanoGPT profile. `engine-limit` validates and
  canonicalises the boundary for all providers and replaces the policy's copy with its own.
  **Remote engine:** `paths()` supplies the executing engine's roots; only the optional,
  validated portable contract crosses the boundary, never authentication files. This uses
  the same policy locally and remotely and introduces no new mode or switch. A cloud hub
  does not isolate an engine's disk; OS-user/VM/container and tenant isolation are separate
  requirements. Explicit boundaries need their own OS/provider native probe when enabled
  (`docs/SANDBOX-PROBE.md`); prior PM-356 evidence does not certify them. Approved host commands
  and the parent CLI remain outside this boundary. PM-425 owns the reader's policy and rollout.
  Writing sessions retain workspace protections
  and the roots of `AgentSandbox.portable` (the member's npm cache and development data,
  the queue's parent, the session folder and
  the own tmp, PM-339). With an own tmp, no shared `/tmp` or CLI `$TMPDIR` write is inherited.
  Task worktrees also grant the shared git `objects`, `refs`, `logs` and their own admin
  directory (PM-399), plus only `packed-refs.lock` (PM-411), so Codex
  can finish rebase pseudo-ref deletion and loose branch deletion. The common git directory as a whole, other
  worktrees' metadata, configuration, hooks, alternates and admin links remain read-only.
  PM-1171 (`contracts/session-policy.ts`, `runtime/sessions/session-policy.ts`,
  `worktree/worktree-manager.ts`, `worktree/member-workspace-manager.ts`) shares the git metadata
  protection lists between Claude and Codex. Claude also denies the worktree `.git` file.
  Host worktree reads validate the `.git`, `commondir` and `gitdir` links against the configured
  repository before git, then use safe settings; independent clones reject a common directory.
  All filesystem validation runs on the engine owning these paths; no new remote boundary is
  needed. Native denial of creating nonexistent metadata paths requires an OS/provider probe,
  on Linux as well as macOS. A session cannot rely on writing `objects/info` for gc or commit graphs.
  PM-731 (engine limit, `engine-link/engine-limit.ts`): the engine's read candidates are its
  write candidates plus the user's own files from `SANDBOX_HOME_READS` (`.gitconfig`,
  `.config/git`, `.claude/shell-snapshots`, `contracts/engine.ts`) and the existing regular
  `core.excludesfile` of its own `userHome`; they are never write candidates, and one whose real
  path is, or holds, a sensitive place is dropped. The `db.sqlite*` pattern of the denials, the
  cloud's and the engine's own, becomes the four file names (a file tool's rule is a path, not a
  pattern); other wildcard entries stay as sent. A member workspace (an independent clone: a
  `task_worktree` with `placement.workspace` and no shared `gitDir`) lets a writing Codex session
  write its own `.git`, with `config`, `config.lock`, `config.worktree`, `commondir`, `gitdir`,
  `hooks`, `modules` and `objects/info` read-only (the links and submodule directories would
  redirect the host's git to a path the session wrote); a read-only sandbox or a placement without that marker gets nothing.
  The Codex adapter lifts only the lock entry from `sharedGitDenials`; `packed-refs` itself
  stays read-only, as do packed default-branch and replacement refs. Claude's denials remain.
  A packed branch deletion that needs a packed-refs rewrite is not granted. Residual risks:
  a leftover lock can block host ref deletions, and lock replacement during a host packed-refs
  rewrite can inject content into that rewrite. The owner accepted these two risks on PM-411
  on 2026-10-08, conditional on the mitigation follow-up PM-413; see SECURITY.md for the separate, still
  unverified hard-link probe required before release.
  This file-path exception relies on macOS Seatbelt enforcement. A Linux engine may keep a
  nonexistent lock path closed; verify provider grants on that engine before claiming rebase
  support. The hard-link probe must fail at link creation, without writing through the link.
  PM-356 adds local startup checks in `runner/runner.ts` and `runner/ambient-config.ts`:
  a numeric CLI minimum and refusal of loaded sandbox/profile configuration, reporting only
  setting names through `codex_setup_incomplete`. User MCP names are resolved beside the CLI;
  ambiguous names refuse startup. `runner/providers/codex/args.ts` disables each user server
  and the eight plugin/app/computer/browser features for every Codex provider. The native
  Codex 0.159.1 probe on macOS 14.6 arm64 is recorded on PM-356 (2026-10-06): glob and
  symlink denials work, `:workspace` and shell-snapshot overrides are unnecessary.
  `runner/cli.ts` resolves the real executable on the session PATH; the profile reopens
  only its `packages/standalone` installation ancestor read-only beneath a denied path,
  provided that ancestor contains no denied path. Unknown layouts stay closed.
  PM-1169 adds presence checks (lstat only, content never read; an unreadable file refuses too):
  `$CODEX_HOME/hooks.json`, `/etc/codex/hooks.json` and, on darwin only, the two
  `com.openai.codex.plist` files below `/Library/Managed Preferences` (`AmbientConfigLocations.codexPresenceRefused`);
  `hooks` and `project_root_markers` in the user and project `config.toml` refuse as well. The check runs
  in the runner, which is the engine process in engine mode, so it inspects the engine machine's hooks and
  MDM; a Linux engine has no MDM path but `/etc/codex/hooks.json` counts there too.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.start`, `session.assert_workspace_config` and `host.*` (PM-313), build the policy from its filesystem and supported OS/provider
  enforcement, preserve protected paths and fail closed where required; do not copy Mac
  path grants or infer Codex permissions from Claude syntax. The outbound network intent
  (`SessionPolicy.network.outbound`) is abstract: the remote engine enforces it with its own
  tools (sandbox, firewall, proxy) and keeps the blocked hosts closed.
  For PM-399/PM-411, resolve the common git directory and the task's own admin directory
  on the engine hosting the worktree, and render these narrow grants there. The existing
  placement paths must describe that engine's filesystem; no new server/engine contract
  is introduced by PM-411.
  Version/config inspection must run on the engine hosting the CLI, against that engine's
  filesystem, PATH, user home and administrator/workspace configuration, including executable
  symlink resolution and installation grants. Only sanitized setting names and
  structured setup errors cross back to the server; host-side inspection is not a substitute.
  Since PM-311 the paths the policy is built from are the session's engine's `EnginePaths`
  (`userHome`, `home`, `worktreesRoot`, `workspacesRoot`, `installDir`, `gitExcludesFile`;
  `contracts/engine.ts`).
  **Module:** `runtime/sessions`
- **CLI token and plan usage** — `runner/providers/claude/{usage,plan-usage}.ts`,
  `runner/providers/codex/{transcript,plan-usage}.ts` (`CodexTranscriptParser`),
  `runner/session.ts`, `runtime/usage` (`PlanUsageMonitor`) (PM-341; PM-286, PM-310).
  See **NanoGPT Codex home and key delivery** (PM-329): token usage is parsed as Codex,
  but NanoGPT rollouts never feed the ChatGPT plan gauge. PM-1068: NanoGPT usage is billed to the key the
  session was started with, i.e. the engine owner's own key when the engine has one.
  Token counts come from the running CLI's transcript/hook data. Claude plan usage probes
  the locally logged-in CLI without a conversation; Codex reads local rollout rate-limit
  events. These observe the local account, not an arbitrary remote sponsor.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `usage.plan` and `provider.status` (PM-313), obtain usage where that sponsor's CLI is logged in and send attributed,
  timestamped measurements; leave credentials there and retain subscription-only execution.
  **Cloud mode (PM-315):** `createRemotePlanUsage` (`engine-link/remote/transcripts.ts`) asks the engine
  (`usage.plan`, `provider.status`); the cloud keeps only the measurements, with the engine that sent them.
  PM-1059: `usage.plan` is asked of one named engine; the monitor and the cache key a value by
  `(engine, provider)` and a board reads the project's representative engine (see "Cloud composition").
  PM-1133 reuses recent measurements while refreshing them: plan usage for up to five cache TTLs,
  and a positive provider login status for up to five minutes. Cold or older reads still wait for the
  engine; explicit login refreshes wait for its answer. Concurrent reads share the refresh. A usage
  measurement that lifts the project's pause wakes queued members on that engine and provider,
  including items without a wait code; threshold changes recheck the project's queued members.
  These caches and wake decisions run on the server, with the existing `usage.plan` and
  `provider.status` RPCs; credentials and CLI probes stay on the remote engine.
  `Admission.warm` preloads login, usage and disk readings outside the admission lock for a known
  member. It makes no start decision: the locked check still enforces admission, and session startup
  remains serialized because capacity and workspace availability count running processes, not reservations.
  Slow lock rounds report their full duration and phase timings with the holder and member; slow queue
  sweeps report their five slowest members. No new server/engine message is introduced.
  PM-1091: the NanoGPT quota and rate hold (`ProviderQuotaHolds`, in memory on the hub) is per key: the
  cloud's key is `'host'`, an engine with its own key file is held under its engine id
  (`EngineDirectory.nanogptKeyHolder`). Only a `usage.plan` measurement on the engine that owns the key
  lifts or moves its hold, so a friend's limit does not stop the host's members and the reverse.
  **Module:** `runtime/usage`
- **Claude workspace trust** — `runner/providers/claude/trust.ts` (PM-341).
  The runner updates workspace trust in `~/.claude.json` (or the configured Claude config directory).
  **Remote engine (engine mode, PM-314: runs in the engine process):** trust is part of `session.start` (PM-313); prepare trust on the engine as the executing account, for the actual
  canonical checkout path; changing the server account's trust cannot unblock a remote CLI.
  **Module:** `runner`
- **Server full test before review** — PM-909: with `reviewTest.beforeReview: github_actions` the run is not
  local: no sandbox, `srt` or local checkout; see "GitHub Actions runs (merge check, compute jobs)" for its machine assumptions and
  for the remote engine (the run needs only an engine with a full test executor and `gh`). `services/full-tests/full-tests.ts`, `engine-host/disk.ts`
  (`resolveGitDir`: the checkout's real `.git`, asked of the engine), PM-846: with a work root the
  executor gets only `worktreesRoot`; the `pmft-*` run directories stay in `os.tmpdir()`, outside the home (PM-848),
  `full-test/{index,sandbox,run-sandboxed,run-sandboxed-core}.ts` (PM-217, PM-336, PM-312; PM-351 shares the spawn with the
  screenshot runs). The executor runs the pinned checkout on the server host, using local
  git metadata, a short temporary run directory, process-group signals and macOS `srt`;
  it is unavailable without macOS/`srt`. PM-847: the run directory is a byte-measured, canonical path
  (`canonicalRoot`, `runDirOf`: at least 40 bytes below its `tmp` and `home` within 100; else
  `/private/tmp/pmft-*`; else `sandbox_unavailable`), and the sandbox may bind and connect Unix sockets
  below the run's own `sandbox/tmp` only (`allowUnixSockets`, `allowAllUnixSockets: false`); the installer
  and screenshot profiles have none. The engine that creates the sandbox is the installed one, so this
  takes effect there only after a separately approved engine update. Remote engine: all of it is the
  engine's own private run root; the cloud receives only the existing full-test result.
  Timeout and cancellation retain the detached process group's cleanup scope through the TERM
  grace period, then send SIGKILL to the negative group id even if the launcher has already
  closed its output pipes (PM-829, `full-test/run-sandboxed-core.ts`). The engine owns these
  POSIX signals and waits for escalation before returning the result or releasing the heavy lock;
  remote engines use the same engine-local cleanup, with no new data crossing `full_test.run/cancel`.
  The group leader is an inline plain-Node watchdog (`full-test/process-group-guard.ts`), outside
  the sandbox. It starts `nice srt ...` without detaching again. An engine-owned stdin pipe stays
  open for the run; EOF on engine death (including SIGKILL or restart) triggers group SIGTERM
  and then SIGKILL after the grace period, independently of engine finalizers. The watchdog
  ignores SIGTERM itself so it can kill TERM-resistant workers even after the launcher exits.
  Normal command exit codes and signals are relayed to the engine. This assumes POSIX groups
  and pipe EOF on process death; all watchdog and sandbox processes stay on the executing engine.
  PM-754: with that permission the control socket integration tests (`control-relay` and `control-socket`,
  `*.integration.test.ts`, test paths checked in bytes by `test/helpers/socket-path.ts`) run in the merge check and
  prove the real socket boundary; Linux has no equivalent guarantee and no fallback. `npm run merge-test` exits 2
  for any scope that runs the server's tests when `PROJECTMAN_SKIP_PTY_TESTS=1` is set (the members' sandbox signal,
  which `fullTestEnv` never passes), and its cloud scope names the two integration files.
  Its sandbox (`fullTestSandbox`, `closedTmpRoots`; PM-353) denies reading Claude Code's shared temporary roots
  and the session tmp root's parent: other sessions' and projects' command outputs lie there.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `full_test.run/cancel` (PM-313), plan where the pinned commit and dependencies are tested, equivalent
  isolation and resource queuing there, and transport of the attributed verdict/cancellation.
  An unavailable executor must not become a passing verdict.
  Since PM-311 the executor is the `EngineHost.fullTestExecutor` of the card's engine, with that
  engine's `EnginePaths` (`userHome`, `home`, `claudeTmpRoots` and the `sessionTmpRoot` parent as `closedTmpRoots`).
  **Cloud mode (PM-315):** the executor of an engine is a remote one (`full_test.run/cancel`) that is
  available only while the engine is; without it a run is refused with `engine_offline`
  (`FullTestErrorReason`), never a passing verdict. `index.ts` builds no local executor in cloud mode.
  **Dependency preparation (PM-709, PM-710):** optional `FullTestSpec.npmCi` prepares dependencies under
  the required heavy lock before the test. `full-test/npm-ci.ts` and `assertNpmCiCheckout` bind it to a real,
  canonical `<worktreesRoot>/_merge/<mergeId>` checkout. The engine limit additionally checks the registered,
  merge-enabled repository and its exact full-test command. Both app factories receive their engine-local
  `<home>/worktrees`; an absent root refuses preparation. The card merge (`services/merges/steps.ts`,
  PM-711) is the only caller: it sends `npmCi` when the check checkout answered
  `dependencyInstallRequired`. Review, other full-test and screenshot callers never send it. Over the link
  an older engine's strict schema refuses `merge.checkout_for_check`'s switch (the merge blocks with
  `check_error` and an "update the engine" message, without a retry) or the spec's `npmCi` (the result is
  `dependency_install_failed` with the same message). When `full_test.run` times out, the cloud
  sends `full_test.cancel` with the run id and ends the run as `error` / `timeout` (`killed` when the merge
  was cancelled); a lost link stays `engine_offline`. No installation is left running unattended.
  A separate installer settings file allows only root/local workspace `node_modules` writes and the run's
  own home/tmp/npm cache; source, lock/manifests and git metadata remain read-only. Linked input files,
  workspace parents, package targets and tracked package paths are refused. The fixed `npm ci` command
  refuses any root `.npmrc` or `npm-shrinkwrap.json` entry, including links or directories, at every input
  read: neither may override the lock/configuration identified by the shared dependency key.
  Every input read also refuses local `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`,
  `prepare`, `postprepare` or `dependencies` scripts and any `binding.gyp` entry in the root or a lock-listed
  workspace, preventing unkeyed source from affecting the shared installation; external dependency scripts still run.
  Its tracked-path probe emits fixed NUL-terminated records so diagnostics cannot masquerade as paths. It
  includes dev/optional packages and lifecycle scripts, uses two distinct empty npm config files and an
  environment allowlist, and permits only registry.npmjs.org and nodejs.org, without local binding.
  The test retains its original settings and no outward network. Private registries, other lifecycle
  download hosts, source-writing scripts and missing toolchains fail preparation without expanding access.
  `full-test/npm-dependency-key.ts` hashes complete lock/root/workspace manifest bytes and engine OS/arch/Node/npm.
  The supervisor stores the latest installation at
  `<worktreesRoot>/_merge-deps/<sha256(JSON.stringify([projectKey,repo]))>/current/`, outside git worktrees.
  A strict version-1 `ready.json` contains the key and copied relative package paths; every listed directory
  and the root hidden npm lock must be real. Invalid or missing metadata is a miss; linked store roots
  are refused. The installer cannot write the store. After a successful install, unchanged inputs and a
  complete staging copy, the supervisor writes a 0600 marker in a 0700 generation and publishes it by rename,
  removing the old generation under the same lock. A hit copies into the new checkout without `npm ci`.
  Filesystem, changed-input and npm errors return `error/dependency_install_failed`, no failed files and
  the npm exit code (null for filesystem errors); sandbox/spawn/timeout/killed/queue errors keep their reasons.
  Probes, installation, copies and test share the post-wait time budget. Cancellation settles the child
  before cleanup and lock release. These operations all run on the macOS/srt engine; only the existing
  `full_test.run/cancel` request/result crosses the boundary, with no new config/env/RPC/database shape.
  `engine-link/remote/host.ts` maps older-engine `invalid_params` to the preparation error without retrying
  a weakened request. No Linux sandbox support is added.
  In GitHub mode (`FullTestSpec.githubActions`, PM-900) the sandbox does not run: the engine's
  `withGithubActions` executor takes the request (see "GitHub Actions runs (merge check, compute jobs)").
  **Module:** `services/full-tests`
- **Merge-test file watchdog (PM-1054)** — `scripts/merge-test/{npm,reporter}.ts`.
  Every test invocation, including reruns, uses the default and hanging-process reporters plus
  controller-side start/end events for each file (from collection through teardown). The npm
  supervisor gives each active file 180 seconds, with 20-second test and hook defaults. On a
  file deadline it prints all active file names as `FAIL` lines and stops the command through
  the existing `scripts/lib/child-guard.mjs`; exit 1 and an unhandled-error diagnostic prevent
  the flaky-file rerun rule from hiding the timeout. **Machine assumption:** POSIX process
  groups, already required by the child guard, stop even synchronously blocked workers and
  clean up descendants when the supervisor dies. **Remote engine:** the supervisor and guard
  run where the tests execute (GitHub Actions or the engine); only existing output and verdict
  data cross the boundary. No new server/engine contract.
- **Child-guard cleanup permissions (PM-1132)** — `scripts/lib/child-guard.mjs` ignores
  `ESRCH` and `EPERM` when signaling the child process group, preserving the child's exit
  status when macOS denies cleanup after the group leader exits. Other signal errors still
  fail the guard. **Machine assumption:** POSIX process groups; permission denial can leave
  members beyond the guard's control. **Remote engine:** the guard runs beside its child on
  the executing engine or CI runner; no new data crosses the server/engine boundary.
- **Merge-test step cache (PM-845, PM-841)** — `scripts/merge-test/{steps,run}.ts`,
  `full-test/{index,sandbox,step-cache}.ts`, `app.ts`, `engine-app.ts` and `index.ts`.
  The executor stores passed command keys in the engine-local
  `<app home>/cache/merge-test-steps.json`, outside the sandbox, and exposes only a disposable key list
  in the run's sandbox directory. It assumes a writable app home on the executing machine;
  an unavailable or invalid cache only disables reuse. The cache stays in app home even with a
  separate work root. **Remote engine:** the remote engine uses its own home and performs the same
  reads, expiry, bounded merge and atomic writes; no cache data crosses the server/engine boundary.
  `FullTestSpec`, `FullTestResult` and engine-link schemas are unchanged.
  **Module:** `full-test`
- **Merge check measurements (PM-876)** — `scripts/merge-test/{steps,run}.ts`, `full-test/index.ts`,
  `engine-link/{methods,engine-handlers}.ts`, `engine-link/remote/host.ts`,
  `services/merges/check-runs.ts`, `db/merge-check-runs.ts` (migration 92), `mcp/merges`.
  The merge-test script, running in the executing machine's sandbox, prints one timing line per step
  and the worker count it saw (`VITEST_MAX_FORKS`); the executor on that same machine parses its own
  output into a bounded `MergeTestReport` (scope kind, workers, step timings; at most 64 steps). The hub
  records every merge check (a card's merge, a train's group check, a member's diagnosis) in
  `merge_check_runs` with the `maxWorkers` it passed, the queue wait and the report. **Machine
  assumption:** none new; the clock is the executing machine's `Date.now()`. **Remote engine:** yes, it works:
  the measurement stays on the engine, the full output never leaves it, and only the bounded report
  crosses, in the separate `full_test.report` call (the `run`/`attach` schemas are unchanged). An older
  engine answers `unknown_method`, so its checks show unknown steps. Related task: PM-876.
  **Module:** `full-test`, `engine-link`, `services/merges`
- **GitHub Actions runs (merge check, compute jobs) (PM-900, PM-907, PM-1147)** — `full-test/{github-actions,github-verdict,github-job}.ts`
  (`withGithubActions`, `withGithubJob`, composed as `withGithubRuns` in `full-test/index.ts`), `engine-host/check-branch.ts` (`createCheckBranchGit`),
  `services/github/actions.ts` (`createGithubActionsClient`), wired in `assembly.ts` (single machine) and
  `engine-app.ts` (engine process), and the repository's `.github/workflows/merge-check.yml`. For a
  `full_test.run` that carries `githubActions`, the engine pushes the merge commit to a check branch
  `pm-check/<time36>/<runId>` of the base's upstream remote (never forced), dispatches the workflow with
  the inputs `check_id` and `files` (PM-909: or `all`, for the review test, with a four-shard scope check), follows the run (`gh api`), and builds the `FullTestResult` from the
  jobs' conclusions and logs (the `merge-test` marker lines and timing report the local run prints).
  A timeout or an abort cancels the run; the check branch is deleted at every end, and a run sweeps a few
  check branches older than two hours. **Machine assumptions:** `gh` installed and logged in on the executing
  machine with the right to run workflows of the repository (`repos[].github`); the base's upstream remote
  is that repository on github.com and `git push` works to it unprompted; outbound HTTPS to GitHub. The
  tests do not run on the machine: no macOS, no `srt`, no heavy-run queue, no step cache.
  The `macos-15` workflow installs Homebrew Bash and puts its `bin` on `GITHUB_PATH` before the
  tests: cloud scripts require Bash 5 (`local -n` is unavailable in the runner's `/bin/bash` 3.2).
  CI stays on Node 22, also used by the cloud image; migration copies restore directory permissions
  explicitly to handle its `cpSync` regression (nodejs/node#65488, PM-923). **Remote engine:**
  the same on the engine's machine with its own `gh` login and remote; the server sends only the existing
  `full_test.run` request and receives the result (the run page in `externalUrl`); nothing else crosses.
  PM-1059 does not touch this check: it keeps running on the engine the card's merge already uses, and the
  engine-side `gh` client keeps its project-less `MachineGithubService` contract.
  **Compute jobs (PM-1147):** a `full_test.run` that carries `githubJob` (`FullTestSpec.githubJob`, exclusive
  with `githubActions`) runs one job of the general `projectman-job.yml` workflow (PM-1144) instead: no check
  branch is pushed; the workflow is dispatched on the owner's merge branch (`base`) with the inputs `job`,
  `run_id` (the spec's `runId`), `commit`, `command`, `runs_on`, `outputs`, `node` and `timeout_minutes`, and
  the run is found by its title `projectman-job <job> <commit> <run_id>` (a run id that already has a run is
  refused). Dispatch, waiting for the run, following it, cancelling it on abort or timeout, and reading the
  jobs and logs are one shared loop (`followWorkflowRun` in `full-test/github-actions.ts`) used by both
  executors. The result carries the declared outputs (the `projectman-job output` lines: path, SHA-256,
  size), the artifact (`projectman-job-<run_id>`, its expiry) and the cost (queue wait, billable time from the
  run timing). The local executor refuses `githubJob` as `github_unavailable`. **Machine assumptions:** the
  same as the merge check (`gh` login with workflow rights, the base's upstream remote is the repository,
  outbound HTTPS); nothing is checked out or pushed. **Remote engine:** the engine that has the repository and
  `gh` orchestrates the run; the existing `full_test.run` request carries the descriptor and returns the
  result, with the engine-limit check (`engine-link/engine-limit.ts`: base is the configured merge branch,
  fixed workflow, no checkout, installation or lock) and the project guard (`githubJob.ref.projectKey`)
  applying as for the merge check. An engine older than PM-1147 refuses the field with `invalid_params`,
  shown as `github_unavailable`. A job runs only when it is registered in the engine's own `engine.json`
  (`repos[].computeJobs`, set by the owner by hand: id, command, runner, outputs, Node, timeout) and the request
  matches it value for value; otherwise it is refused as `command_not_allowed` (see `docs/SECURITY.md`
  "Compute jobs on GitHub Actions"). PM-1148: the hub's `services/compute-jobs` (`ComputeJobService`) starts a
  job on the project's engine through `engines.projectEngine` (the `merger` asks whether the commit is on the
  remote default branch, the `fullTestExecutor` runs `full_test.run` with `githubJob`) from the repository's
  `computeJobs` setting and records the run in `compute_job_runs`. The hub part is machine-independent: no
  path, process or `gh` call of its own; the engine alone holds the GitHub access.
  PM-1197: the cloud deploy is a dedicated workflow, `.github/workflows/projectman-deploy.yml` (listed in
  `DEDICATED_COMPUTE_JOB_WORKFLOWS`, PM-1196), registered as the compute job `cloud-deploy` (command `cloud-deploy`,
  runner `ubuntu-24.04`, output `deploy/report.json`). It runs on a GitHub-hosted runner, in the `cloud-production`
  environment (limited to the default branch), and exchanges the run's OIDC token for the AWS role
  `projectman-cloud-deploy`; no AWS key and no GitHub secret exist. **Machine assumption:** none on the engine's
  machine beyond the existing `gh` login that dispatches the run; the AWS access is the runner's. **Remote engine:**
  the same as any compute job; the descriptor and the result cross the existing `full_test.run` request, nothing new.
  PM-909: the review test before review uses the same path (`all: true`, `engine-link/methods.ts` accepts the
  optional field; an engine older than PM-909 refuses it with `invalid_params`, shown as `github_unavailable`).
  The server side (`FullTestRuns`) needs only an engine with a full test executor, not a sandbox.
  Real dependency-clone integration tests (`worktree/{worktree-manager,dependencies}.test.ts`)
  use `test/helpers/apfs.ts` to check that the test temp volume is APFS, rather than assuming
  every macOS temp volume supports cloning (PM-928). The injected dependency-clone unit tests
  still run on other filesystems; clone failures on APFS remain failures. The process-group
  timeout tests leave 5 s for the Node guard and shell to start on slower CI hosts; the
  TERM-resistant case checks its readiness output and retains the grace-period KILL assertion
  (PM-947). The background-grandchild cleanup test in `full-test/run-sandboxed-core.test.ts`
  polls for POSIX `ESRCH` every 50 ms for up to 5 s, allowing asynchronous reaping on loaded
  hosts (PM-948). After run completion the executor re-reads empty or nonterminal shard job states
  for up to 120 s, bounded by the original check deadline, before reporting a missing verdict;
  cancellation still stops the wait. This uses the existing engine-local GitHub client without
  a new dispatch or server/engine contract. The `runner/cli.test.ts` output-preservation timeout test gives Node startup
  and initial pipe writes 5 s; `test/permission-delegation.integration.test.ts` polls each fake-CLI
  phase for up to 30 s within a 150 s test budget (PM-936). These are test-host assumptions only;
  remote engines need no new capability or server/engine messages.
  Related tasks: PM-900, PM-906, PM-907, PM-909, PM-923, PM-928, PM-936, PM-947, PM-948.
  **Module:** `full-test`, `engine-host`, `services/github`
- **Merge conflict fix worktrees** — `services/merges/`, `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`), `runtime/watchers` (`WorktreeSweep`),
  `worktree/worktree-manager.ts`, `runtime/sessions` (`session policy`), `engine-link` (PM-471).
  The nominated merger receives a separate writable `merge-fix/<KEY>` checkout, even without
  a file-changing duty, only while the card is `fixing`. Placement changes when its session
  restarts after the turn. The checkout starts at the approved commit; the merger merges the
  recorded conflict base, resolves mechanical conflicts, commits, and submits a resolution note.
  Git cleanliness and ancestry are checked on the card's engine before queuing the fix head.
  Human mergers use the same checkout (PM-481), editing directly on the card's engine machine.
  `fix.path` is an absolute path on that engine; remote use requires the human to have filesystem
  access to its machine, which projectman does not provide. The existing checkout metadata
  carries this path across the server/engine boundary.
  Assumptions: git and writable worktree storage on that engine, shared git metadata there.
  **Remote engine:** checkout creation, head/status/ancestry reads and cleanup run on the card's
  engine through the worktree and merge contracts; only checkout metadata, commit ids and the
  resolution note cross the boundary. A merger assigned to another engine is refused. The
  server stores the fix state and resolution attribution; it never edits conflict files.
  Both task worktree and member workspace modes use this checkout (PM-794). In member workspace
  mode the approved commit is first published as a snapshot from the developer's clone into the
  engine's project repository; the submitted fix head already lives there and is not published
  from the developer's clone, including when a newer base causes another conflict-fix round.
  Placement remains `task_worktree` with `mergeFix.branch`, without
  reserving the merger's member workspace. `MemberWorkspaces.check` bypasses clone admission for
  the nominated fixer, and `roundDue` ignores sessions outside member workspaces, so a pending
  review refresh cannot restart a fix session. On restart the old process scope's cleanup releases
  its clone reservation. Shared git protections also deny session writes to `refs/projectman`,
  including the server-managed workspace snapshot refs, in both Claude and Codex sandboxes.
  The server's shared
  `kernel` (`MergeCardLock`) lock serializes fix creation, session placement and cleanup;
  cleanup rechecks open merge rows and live fix sessions immediately before the engine call.
  Orphaned fix branches and registered checkouts (including dirty or detached ones) are swept
  at startup and periodically. The engine revalidates the canonical fix path under its
  repository mutex, refuses symlinks and leaves unregistered directories in place.
  **Module:** `services/merges`

- **Member initiated merge (`merge.*`)** — `contracts/engine.ts` (`BranchMerger`, `EngineHost.merger`),
  `engine-host/{branch-merger,merge-check,doc-files,merge-repo,git-output,merge-git,merge-input}.ts`,
  `engine-link/{methods,engine-handlers,engine-limit,engine-config}.ts`,
  `engine-link/remote/host.ts`, `engine-host/local-engine.ts` (`repoPath`), `services/merges/`
  (PM-451 and PM-452, parts 1/5 and 3/5 of PM-448). The gate queries the card's engine too;
  the server keeps the queue and member authorization, and never receives git credentials.
  PM-1175: `merge.commit_files` accepts only Markdown project document paths, excluding hidden
  segments and agent instruction files (`engine-host/merge-input.ts`), on local and remote engines.
  PM-797: a collecting card with no code of its own, whose subtasks are all closed, skips the gate on the hub's
  own data (`TaskRepository.sourceEvidence`, "Collecting card closes with its parts"), so its close makes no
  engine call and adds no machine assumption; a card with a trace of a source keeps the gate.
  PM-818 keeps that evidence rule. The normal gate can find no engine source for an unassigned card
  without a work binding or a source session when the hub has no registered LOCAL engine; it then needs no source RPC.
  Recorded handovers and review pins retain precedence, and a previous developer workspace is read
  on its member's engine, with offline reads still refused.
  PM-1059: the merge queue's pull-request reads (`services/merges/{steps,train}.ts`) name the card's project
  and go to that project's engine; git and the checks stay on the engine the merge already used, no new RPC.
  PM-791 adds `services/merges/engine-wait.ts` and reconnect loops in `steps.ts` and `train.ts`:
  the cloud holds the repository slot for up to 15 minutes per lost link and resumes through
  prepare/publication recovery. Persistent or repeated loss becomes `engine_offline`. Remote
  git and checks remain engine-local; only calls, run ids, results and link readiness cross the boundary.
  The member-workspace source handover (`runtime/sessions/workspaces.ts` `prepareMergeSource`)
  preserves link-loss errors for these loops; ordinary session preparation keeps its domain error mapping.
  Structure map reads (PM-682, PM-683) reuse this boundary: `services/structure/index.ts`
  invokes `listPaths`, `readFile` and `changedPaths`. Git and repository registration stay
  on the selected engine; remote engines return bounded file names and descriptor text.
  Merging a card's approved commit into the repository's default branch and sending it up is git work on
  the repository and uses this machine's git login (the owner's). It runs as nine calls — `merge.prepare`
  (fetch of the upstream and the state of the base), `merge.is_ancestor`, `merge.build` (a merge commit made
  with `merge-tree`/`commit-tree`, the branch not moved), `merge.checkout_conflicts`,
  `merge.checkout_for_check` and `merge.release_check` (a detached check checkout under
  `<worktreesRoot>/_merge/<mergeId>`, its `node_modules` copied from an installed checkout with a byte-identical
  merged lockfile, an APFS clone `cp -c` on macOS; PM-580). PM-790 centralizes the checkout path in
  `contracts/engine.ts` (`MERGE_CHECK_DIR`, `mergeCheckPath`). Before recreating or releasing a check
  checkout, `engine-link/engine-handlers.ts` aborts all active full tests whose resolved working
  directories are that checkout or its descendants and awaits executor cleanup, including dependency
  preparation and the heavy-run lock. It then forgets those runs and logs their run/merge ids at info
  level; other merge ids are unaffected. The comparison uses the same engine-local
  `realpath(worktreesRoot)` as checkout creation alongside the configured root, so a symlinked engine
  home matches either test working directory form; relative paths exclude parent traversal at directory
  boundaries. It requires no cloud filesystem access or new machine assumption. The engine tries the bounded preferred source,
  its repository checkout, then repository worktrees under its root outside `_merge`; it rechecks the
  source after copying. Callers that do not request dependency preparation block with `check_error`
  before checks if none matches. Since PM-681
  `checkoutForCheck` takes an optional `allowDependencyInstall` (default false) and may answer
  `dependencyInstallRequired` (missing: false) in the strict `merge.checkout_for_check` schemas (PM-709).
  Standalone merges, train checks and lone-member diagnoses pass `true` through
  `services/merges/check-preparation.ts` (PM-711, PM-897); the engine then answers `dependencyInstallRequired: true`, without
  copying old packages, when the root has a regular non-symlink lockfile and no installed source matches,
  and the shared helper hands the preparation to the executor under the required heavy-run lock
  (see "Server full test before review"). Checkout creation and sandboxed installation run on the
  selected engine through the existing contracts; no new server/engine boundary field is needed. `merge.push`
  (never forced, `--no-verify`), `merge.remote_tags` and `merge.push_tag` (PM-968, the release tag: listed with
  `ls-remote --tags`, made with `tag -a --no-sign` and pushed without force, so a tag the remote has is never moved)
  and `merge.advance` (a
  fast-forward of the local branch, or an `update-ref` with the old value when it is checked out nowhere).
  Every git call is an argument array with no shell, with hooks, signing and the filesystem monitor switched
  off, no terminal prompt and the billing variables removed; the output is scrubbed of credentials. The
  repository is found from the engine's own binding (`engine.json` `repos[].path`, in single-machine mode the
  project's config), never from the call; branch, commit and merge ids are checked in `engine-limit.ts` and
  again in the merger. The pure commit/merge-id and branch syntax rules live in
  `packages/shared/src/domain/merge-input.ts` (PM-659), also used by the server's train storage;
  `engine-host/merge-input.ts` still runs `git check-ref-format --branch` after the shared branch
  syntax check. No git or process crosses into server-side DB validation.
  Which suites cover the remote path (PM-1110): the cloud half of the merge over a fake peer is
  `core/tasks/tests/merges.test.ts` (`createCloudRemote`) and `engine-link/remote/remote.test.ts`; the engine half
  (schemas, limits, check checkout protection, a link lost during a full test) is
  `engine-link/engine-handlers.test.ts`, `engine-limit.test.ts` and `rpc.test.ts`; the real link, both real ends,
  is `test/cloud-engine.test.ts` and `test/engine-link.test.ts`. `test/cloud-engine.test.ts` also drives a merge
  check over the real link (PM-1130): the cloud's engine host (`app.projectman.engineDirectory`) calls
  `merge.checkout_for_check`, the full test (`full_test.run`) and `merge.release_check`, the checkout and the
  run are the engine's, and a checkout stays across a link drop until the call that releases it gets through.
  The engine's `mergeBranch` and `fullTestCommand` come from the fixture (`mergeBranch` option); its executor
  is a stand-in that records the spec and passes. The train, the push and the real full test command are
  not covered over the real link.
  For a train (PM-660), the server calls the same build operation for every approved source
  and a final first-parent commit, then uses one `_merge/<trainId>` checkout and one strict
  full_test.run. The manifest, ordered locks and attribution stay on the server; all members
  must share an engine and no new RPC or command allowlist entry is required.
  Diagnostic bisection (PM-661), its transactional requeue and parent/size limits stay on the
  server; smaller attempts reuse these same engine operations and the required heavy lock.
  Conflicting train sources use that same server-side requeue with a one-card limit (PM-778);
  individual attempts read current main and retain the full check and review gates. Git and checks
  still run on the selected engine through the existing RPCs, with no new machine assumption.
  Generated files (PM-1050): when `reviewTest.regenerate` names path patterns and command, a standalone
  merge whose conflict is only in files matching them calls `merge.build` again with `regenerate`; the
  engine answers the conflict with a `provisional` merge commit (parents `onto` and the commit) made
  without those files, in a temporary index file in the engine's `os.tmpdir()` (the checkout's index is
  never used). The server runs the configured command in the full test sandbox (`full_test.run`, not
  recorded as a merge check) on a `_merge/<id>` checkout of it that has an id of its own (not the
  merge's), so a process the run leaves behind never reaches the merge check's checkout. Only that run
  may write: its spec carries `regenerate: { ref, mergeId, patterns }` (like `npmCi`), and the engine
  derives the writable directories itself (`regeneratedWriteDirs`: the literal directories before the
  last segment of each pattern; real directories of that canonical checkout, never links; the rest of
  the checkout, its `.git` and `node_modules` stay read-only). A remote engine accepts that spec only
  with the command of the repo's `regenerateCommand` in its `engine.json` (the owner sets it;
  `fullTestCommand` may not run with the descriptor) and only for that repo's `_merge` checkout; without
  `regenerateCommand` the merge falls back to the old `conflict` failure with that detail. A local
  engine uses the server's `reviewTest.regenerate.command`. Then `merge.commit_regenerated` has the
  engine commit the written files: it first `rename`s the writable directories below a fresh
  `.pm-regenerated-*` directory of the checkout (no longer writable there) and reads only from that
  copy: an `lstat` walk, each file through one `O_NOFOLLOW` descriptor and `fstat` (regular, one link,
  at most 1 MB), hashed from the bytes read with `hash-object --no-filters`, never `git add`. Only
  files that are new, changed or deleted against the provisional commit and match the patterns are
  taken (never a `.git*` name, `.husky` or `node_modules`); a change in the directory outside the
  patterns, a link, a flood of files (`too_many`) or a missing conflicting file refuses it. Git does
  not discover the checkout: the worktree git directory is found from the repository and named in
  `GIT_DIR`, and the indexes are temporary files outside the checkout. The merge check checks that
  commit as always. Any other conflict, any refusal and any failure keeps the old `conflict` failure;
  an engine from before the field refuses `regenerate` (`invalid_params`) and the merge fails as
  before. The call count above is nine with `merge.commit_regenerated`.
  Machine-dependent parts: the regeneration run and the commit step run on the card's engine in its
  `_merge` checkouts, with the same sandbox assumptions as the full test (srt/Seatbelt write
  allow-list, `rename` within the checkout filesystem); a remote engine additionally needs
  `regenerateCommand` in its `engine.json`.
  Member workspaces (PM-739): a developer's commit lives only in their remote-less clone, so before the
  first `merge.prepare`, `merge.is_ancestor` or `merge.build` of a standalone merge, a train (also its
  recovery and its candidate selection) and the merge gate, the server calls
  `MergeSessions.prepareMergeSource(config, task, commit)` for every commit involved. It reaches
  `workspace.publishTaskBranch` on the card's engine (see "Task worktrees and shared git storage"),
  which makes the commit readable in the engine's repository as a snapshot ref; a refusal blocks the
  attempt through the usual `merge_error` path, a train candidate that cannot be handed over stays
  out of the train. A task without a developer workspace binding changes nothing.
  No new local machine assumption or server/engine boundary field is introduced.
  **Does this work on a remote engine?** Yes, it is built for it: the git work, the
  check checkouts and the push run on the engine beside the repository and the git login; only ids, paths
  of the changed files and short results cross the link, and a merge to a repo or branch not named by
  `mergeBranch` is refused there whatever the cloud asks. Machine assumptions: `git` on the `PATH`, the
  engine's user's git credentials for the push, and macOS APFS for the cheap dependency copy (a plain copy
  elsewhere). Two more calls serve the Operator's project documents (PM-494, PM-388): `merge.read_file`
  (`cat-file` of one file at a commit, or at the head of the base after the fetch of its upstream; a path
  that fails `isRepoFilePath`, a file over 1 MiB or one that is not UTF-8 text is refused) and
  `merge.commit_files` (a commit on `onto` with one or two files set, built in a temporary index file
  with `hash-object`, `update-index`, `write-tree` and `commit-tree`: no ref, index or working tree is
  touched). The engine limit bounds both like the other `merge.*` calls (the repository must be
  registered with a `mergeBranch`, a `base` must be that branch, 1–2 different paths, 1 MiB of text each
  without NUL, a message that `isMergeMessage` accepts); they run on the engine, so no new
  machine-dependent part is added. The temporary index is a directory under the engine's temp directory.
  PM-1004 uses the same calls for autonomous lessons writes. The hub owns the lessons-only permission,
  session/queue binding, configuration and durable provenance; reads, commits, push and advance stay on the
  Operator's selected engine, including remote engines. Only existing path/text/commit data crosses the link.
  The service rejects a third document path before queueing; no RPC or engine limit changes.
  Two read-only calls serve the structure map (PM-595, PM-682): `merge.list_paths` (`ls-tree -r` of the
  local base head: the tracked file names, sorted, at most 20 000) and `merge.changed_paths` (per item,
  at most 25: a branch tip, a commit or a merge commit, its changed file names against the merge base
  with the local base head, or against the merge's first parent, `diff-tree --no-renames`, at most 1 000
  each; `{ ok: false, reason: 'unknown' }` for what is not known). They do not fetch and only file names
  cross the link, so the largest reply stays near 2 MB, under the 4 MiB frame. The engine limit checks
  the repository and the base like the other `merge.*` calls, each branch with `isBranchName`, and each
  commit or merge id as a commit id. No new machine-dependent part is added (`engine-host/path-reads.ts`).
  **Module:** `services/merges`
- **Disposable instances and migration tools** — `scripts/lib/{instance,ports,processes}.mjs`,
  `scripts/migrate/{inventory,database,git,instance,copy,package}.ts` (PM-270, PM-318, PM-923, PM-1033).
  Disposable instances reserve loopback ports, spawn local server/web process groups and
  use local temp homes; migration inventories local repositories, paths and database use,
  packages only hybrid cloud entries; repositories and their paths stay on the engine host.
  Home copies restore source directory modes after `cpSync`
  (Node 22 can otherwise widen 0700 to 0755); the permission walk uses `lstat` and never follows
  symlinks. This requires POSIX modes on both source and destination. Cross-machine activation already requires a person's
  confirmation that the source is retired. **Remote engine:** execute local probes and
  process management on the target host, inventory engine state separately, and preserve
  explicit source retirement and rollback checks rather than inferring remote liveness.
  **Hybrid move (PM-318, `scripts/migrate/{hybrid,hybrid-entries}.ts`, [HYBRID.md](HYBRID.md)):**
  PM-674's [rollback sheet](CLOUD-CUTOVER.md) uses protected return
  directories outside the source and repositories and brings final stopped-cloud data back
  before activation. No second writer or
  automatic clearing of used targets is allowed; data transport is the owner's administration path.
  PM-1116 retired the one-off CLI commands `inventory`, `hybrid plan` and `hybrid package` (and the cloud
  `seed`; the last commit that has them is `358bb7c7` on `main`, tagged `retired-migrate-dns`); `hybrid back`, `instance` and
  `verify` stay. Their library functions (`buildHybridPlan`, `createHybridPackage`, `buildInventory`) remain only because the
  test fixtures build a cloud's data with them. The cloud package was made on the Mac from a stopped source and held a closed list
  (`db.sqlite`, `secret`, `secrets`, `customization`, `attachments`, `message-attachments` (PM-666: the files of team messages, which the
  database and `core/attachments` reference), `feedback`, `memory`, `HYBRID_CLOUD_ENTRIES`; a package made before
  PM-666 has no `message-attachments`, which is accepted, and `REPLACED_ENTRIES` of the way back lists it too);
  it never holds a CLI home, provider logins, worktrees, workspaces, repositories, `github-publish`,
  `spool`, `logs`, the instance marker, `engine.json` or `engine.key`
  (`HYBRID_NEVER_CARRIED`, checked again by `verify --hybrid-cloud` as `forbidden_entry`). The machine
  key is made on the Mac (`newMachineKey`), written to `engine.key` (0600, `wx`) last, and only its
  hash enters the package's database; `engine.json` is made with it. After a way back the revoked engine
  row stays as an audit record (PM-728): only a non-revoked engine makes `hybrid package` refuse, and the
  package makes its new engine the default explicitly (`setDefault`; `create` marks only the first engine
  ever as the default). **Does this work on a remote
  engine?** The tool is the one place that reads the Mac's home and repositories to build the
  engine's configuration (`engineProjects`), so it runs on the engine's machine by definition; the
  package is the only thing that crosses to the cloud, by a person's copy, and the key never does.
  The way back verifies the cloud's data directory as downloaded: it tolerates, and does not carry,
  what a running cloud writes itself (`logs/`, `engine-spool/`, Litestream's `.db.sqlite-litestream`,
  a restored copy's `instance.json`), refuses while the engine runs or its LaunchAgent is installed,
  and moves the Mac's former entries (old database, cookie key, secrets, machine key) to
  `pre-hybrid/<date>/`. That folder and the staging folder `.hybrid-back/` are in `sensitivePaths`
  (fixed names, so one path denies the tree); the package (`--out`) and the downloaded copy (`--from`)
  are the person's folders outside the home, which the sandboxes' deny-only reads do not cover, so the
  guide tells the person to delete them after use.
  **Module:** `scripts`

- **Engine service (launchd)** — `scripts/engine/{service,snapshot,logs,commands,cli}.ts`,
  `scripts/engine/{service-switch,switch-state}.ts` (PM-1124). A plist whose `WorkingDirectory`
  contains `engine-package.json` is app-managed; otherwise it is checkout-managed.
  PM-1175: service installation and switching keep only absolute, nonempty PATH entries; switching
  preserves deliberate absolute local entries. This filtering runs on the engine host.
  Package installation uses the embedded `bin/node` and package root in the same template.
  `AssociatedBundleIdentifiers` names `com.projectman.engine-app`; `service install --path`
  accepts the app's login shell PATH. `service switch [--to <package-root>]` is for app-managed
  engines only: the CLI owns `<home>/engine-switch.lock` (exclusive creation, dead-pid recovery),
  `engine-switch.json` (`EngineSwitchState`) and `engine-switch.previous.plist` (exact bytes).
  It stops gracefully, installs with the saved PATH and verifies the new process, target version
  and prior connection requirement within 120 s. A failed switch restores and bootstraps the saved
  plist, then verifies the previous version; the durable result is `rolled_back` or
  `recovery_required`. An interrupted `switching` is recovered first on the next switch.
  Other service mutations refuse during `switching`; `switch --clear` clears terminal results.
  A `recovery_required` result blocks a new switch until explicitly cleared, preserving its
  backup. Preparation writes the backup before publishing `switching`; even an unknown
  previous version permits byte restoration but cannot yield a verified rollback.
  Corrupt state is exposed as a reporting-only `recovery_required`/`switch_state_invalid`
  snapshot with unknown target, while the CLI's mutation reader remains strict.
  The additive snapshot fields are `service.manager`, `package` and `switch` (schema version 1).
  PM-1125: the downloaded app calls `service install --path <PATH>` on first launch and
  `service uninstall` when the owner removes the engine; it decides "app-managed" from
  `service.manager == 'app'`, so a checkout-managed engine is never installed over or removed by the
  app. All of it runs on the engine's Mac; no new cloud request.
  PM-1113 runs the compiled `apps/server/dist/index.js` under Node, without a TypeScript loader;
  build the engine checkout before installing or updating the service. The build and launchd
  operations run on the engine machine; no compiled source crosses engine RPC.
  PM-674's [rollback runbook](CLOUD-CUTOVER.md) uninstalls KeepAlive before hybrid back.
  Updates are manual owner-approved steps in
  the engine's own checkout; neither credentials nor launchd operations cross engine RPC.
  `deploy/mac/com.projectman.engine.plist` (PM-318). `npm run engine -- service install|uninstall|status`
  renders the plist template with this machine's absolute paths (node, the checkout, the home, the
  `PATH` of the installing shell, without the `node_modules/.bin` folders `npm run` puts in front) and loads it as a LaunchAgent in the user's `gui/<uid>` domain, so the
  engine starts at login and is restarted after an exit (`KeepAlive`, 30 s throttle). It is an agent,
  not a daemon, because the CLIs of the sessions need the login keychain and the user's files. The job
  gets only the variables the plist names (`PATH`, `PROJECTMAN_MODE=engine`, `PROJECTMAN_HOME`): no
  API key and no integrator key. `install` runs the same preflight as `start` and refuses another
  home's installed agent; `uninstall` leaves the logs (`<home>/logs/engine-service.{out,err}.log`).
  PM-1087 adds `service start|stop|restart` and the machine-readable state, the one contract of the menu bar
  app and any other shell: `start` loads the file (`bootstrap`, with the busy retry) or `kickstart`s a loaded
  idle job (no file: `service_not_installed`); `stop` is `bootout` (the file stays, `RunAtLoad` starts it at
  the next login) and waits up to 100 s for the process to leave; `restart` is `kickstart -k` (an unknown job
  is started); none touches another home's agent (`service_other_home`). The plist has `ExitTimeOut` 100:
  the engine's shutdown pause is 60 s (`APP_DEFAULTS.shutdownPauseMs`) plus a 20 s cap, while launchd sends
  SIGKILL after about 20 s by default; an existing machine needs `service install` again for it to apply.
  `status --json` prints one line (`EngineLocalSnapshot`, `scripts/engine/snapshot.ts`, exit 0 in every
  state, 1 only when it cannot be built) from `engine.json`, `engine-status.json`, one `launchctl print` (none
  off macOS: `service.supported` false) and the disk and memory of the machine; `overall` has one rule,
  `overallState`. `logs [--lines N] [--json]` prints the last lines (50, at most 200, from the last 256 KiB)
  of the two service logs.
  **Assumptions:** macOS, `launchctl`, a logged-in user, and a persistent checkout or extracted engine
  package (including the previous package during a switch) named by the plist. **Does this work on a remote engine?**
  This is the engine's own start-up: it must run on the engine's machine, as the user who owns the
  CLIs; nothing of it crosses to the cloud. On Linux the equivalent is a systemd user unit (not built).
  **Module:** `scripts`

- **Compute jobs on GitHub Actions (PM-1144, PM-1145)** — `.github/workflows/projectman-job.yml`,
  `packages/shared/src/domain/compute-job.ts`, `scripts/cloud/{compute-job-run,image-fetch,images,github,commands}.ts`,
  `scripts/engine-app/{job,fetch}.ts`,
  `apps/server/test/{cloud-image-fetch,engine-app-fetch,projectman-job-workflow}.test.ts`, `docs/AWS.md` "Prebuilt ARM images".
  The run finder (`compute-job-run.ts`) is job-independent since PM-1156; the second job is `engine-app`
  (`macos-15`, see "Engine app release build"): the runner has Xcode, `hdiutil` and `codesign`, and its Node and
  Python come from a toolcache under the user's home, which the package sandbox closes (the pinned Node's npm and a
  filtered PATH answer that).
  Heavy machine work (the first one is the cloud image build) runs on a GitHub-hosted runner through one general
  workflow, started by hand with `gh workflow run`, so the owner's Mac needs no Docker Desktop (its 8 GB VM).
  **Dedicated workflows (PM-1196):** a registered job may carry `workflow`, one of
  `DEDICATED_COMPUTE_JOB_WORKFLOWS` (`projectman-deploy.yml`, `projectman-engine-release.yml`), and then runs that
  workflow (own environment and rights) instead of the general one; the engine's `full_test.run` guard requires the
  registration's workflow to equal the request's. The dispatch still runs on the engine with its own `gh` login, so
  nothing new is tied to a machine and it works on a remote engine.
  **What runs where:** the runner is one of `ubuntu-24.04`, `ubuntu-24.04-arm` or `macos-15` (the cloud image
  uses `ubuntu-24.04-arm`); it checks out one commit, runs the declared shell command, attests the declared
  output files (`actions/attest-build-provenance`) and uploads them as the artifact `projectman-job-<run_id>`
  (7 days). On the admin machine `npm run cloud -- image-fetch` needs `gh` logged in with read access to the
  repository's Actions and `gh attestation` (gh 2.49 or newer); it needs no Docker and no cloud configuration.
  It finds or follows the run (never starts one), checks that the run is `projectman-job.yml` dispatched on the
  default branch, verifies the attestation of both files against the workflow's exact identity and this run,
  and then checks the bundle with `tar` alone. Owner setup, once: Settings → Actions → General → Workflow
  permissions → "Read repository contents". The local `image-build` (Docker and Buildx) remains the fallback.
  **Does this work on a remote engine?** Yes, and the engine is not affected: nothing of it runs on, or crosses
  to, an engine, and there is no new RPC. The hub and the engine start no job in this step; PM-1147 adds the
  engine's runner (see "GitHub Actions runs (merge check, compute jobs)") and PM-1148 the callers.
  **Module:** `scripts`

- **The cloud machine downloads the image artifact (PM-1154)** — `scripts/cloud/{image-github,image-fetch,images,machine,host,config}.ts`,
  `deploy/aws/host.sh` (`stage-image`, `receive-image … <stage>`),
  `apps/server/test/{cloud-image-host,cloud-machine-github,cloud-image-fetch}.test.ts`, `docs/AWS.md`
  "The machine downloads the artifact itself". With `deployment.imageSource: "github"` the EC2 machine fetches
  the GitHub artifact `projectman-job-<run_id>` itself instead of receiving a 460 MB stream from the admin Mac.
  **What runs where:** the Mac (the admin machine, `gh` logged in with read access to the repository's Actions)
  finds the run, gets the artifact's pre-signed link (valid about one minute) and sends it on a standard input
  to `host.sh stage-image`; the machine downloads the zip with `curl` over HTTPS, unpacks exactly the manifest
  and the archive into `/var/lib/projectman/.stage/<id>`, and answers the manifest, which the Mac verifies
  (attestation, schema, commit); `receive-image` then imports from the stage. **What the machine needs:** `curl`
  and `unzip` (installed by `bootstrap`), outbound HTTPS to GitHub's artifact storage (its host is not fixed),
  about twice the artifact size free on `/var/lib/projectman`; no GitHub credential, no `gh`. **What crosses the
  boundary:** the short-lived link (stdin only, never in an argument or a message) and the small manifest; the
  image itself no longer crosses it. **Does this work on a remote engine?** The engine is not affected: this is
  the cloud deploy path of the admin Mac and the EC2 machine; it adds no RPC and no engine-side step.
  **Module:** `scripts`

- **Non-interactive editors in member sessions** — `runner/env.ts` (`NON_INTERACTIVE_EDITOR_ENV`,
  `buildSessionEnv`) (PM-428). Every member session gets `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`,
  `EDITOR` and `VISUAL` set to `true`, so git (a rebase's message or todo list) never opens
  Vim on a terminal nobody types into. The values override the service's environment and are
  set for every provider. **Remote engine:** the engine builds the session
  environment beside the CLI with the same function (or the same four variables).
  **Module:** `runner`
