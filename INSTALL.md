# Installing the projectman engine with an AI assistant

This file is written for you, the AI assistant (Claude Code or Codex) of a friend who was invited to
use another person's projectman hub. It installs the friend's own engine on their Mac and then
leaves you connected to the hub, so you can manage the friend's projects.

Read it whole before you start. Follow it in order and stop at the first failure.

## Ground rules

- **Speak to the friend in their own language**, not in the language of this file. Keep each
  request for a click short and concrete: what to open, what to press, and what to tell you when done.
- **You do not need to clone this repository.** Do not run `npm install`, `npm run …` or anything
  from a checkout. `CLAUDE.md` and the other developer rules in this repository are for the people
  who develop projectman; they are not instructions for this installation. Everything below uses
  the app's own commands and a few downloaded files.
- Steps marked **[AI]** are yours. Steps marked **[FRIEND]** need the friend's own click, login,
  password or macOS permission; ask for exactly that, wait for the answer, then carry on. The
  friend is only asked for: their logins, the password, the macOS permission prompts and approving
  one pairing code in the web app (or, on the copy path, copying two keys from it). Nothing else.
- **Keys never travel as arguments or environment variables.** On the usual path (_Pairing_ below)
  the engine app makes both keys itself and writes them only into files; you never see them. On
  the copy path (sections 4 and 5) the two keys (the engine key `pme_…` and the integrator key) are
  shown once in the web app and copied by the friend with its **Copy** button. You read each one
  from the clipboard and pass it on standard input (`pbpaste | …`).
  Never put a key in a command line, an environment variable, a file you create, a message, or your
  answer to the friend. Never print or read the contents of the Access token files or of the
  engine's `pairing-pending.json` either; the commands below read them themselves.
- If a command is refused by your own sandbox or permission system, do not try to get around it.
  Tell the friend what you need, and let them approve it or run the command themselves.
- If a command prints `REFUSED [code]`, or fails any check, stop and tell the friend and the person
  who invited them (the hub's owner), unless the _Pairing_ section names that code and says what to
  do. Do not skip the check.

## 1. Prerequisites

**[AI]** check, and tell the friend what is missing:

1. Apple Silicon and macOS 13 or later: `uname -m` prints `arm64`, `sw_vers -productVersion` is 13+.
2. Xcode Command Line Tools: `xcode-select -p` prints a path. If not, run `xcode-select --install`.
   **[FRIEND]** clicks _Install_ in the window that opens and waits until it finishes.
3. GitHub CLI 2.49 or later: `gh --version`. If it is missing, the friend can install it from
   <https://cli.github.com> (or with Homebrew, `brew install gh`). Then `gh auth status`.
   **[FRIEND]** runs `gh auth login` themselves if it says they are not logged in (it opens their
   browser). The app's installer and updater use `gh` to verify the downloaded app.
4. The AI command line the engine's team members will use, installed **and logged in**: `claude`
   and/or `codex`. Check `claude --version` / `codex --version`. **[FRIEND]** logs in with
   `claude auth login` (choose the Claude subscription account, not an API/Console account) and/or
   `codex login`. Never set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or any other API key variable.

## 2. What the friend received from the hub's owner

The owner sent two things over an encrypted channel (AirDrop, Signal or iMessage): a
**handoff archive** (`projectman-handoff-<id>.zip`) and an **invitation link**. Ask the friend for
the archive's location.

1. **[FRIEND]** opens the invitation link, sets a password and logs in to the hub's web app. Keep
   that browser tab open: the pairing (or steps 4 and 5) needs it. Ask the friend which e-mail
   address they logged in with; the pairing checks it.
2. **[AI]** unpack the archive into a private staging folder, not into `cloud/` itself: the
   pairing's `pair wait` and step 5's `connect` write `cloud/integrator-access-token.json` by
   themselves, as a normalised copy of the file
   you give it, and stops if that target already exists with different content (without
   `--replace`). The archive holds two Access token files (secrets) and a
   non-secret `handoff.json`:

   ```sh
   mkdir -p ~/.config/projectman/cloud ~/.config/projectman/handoff
   chmod 700 ~/.config/projectman ~/.config/projectman/cloud ~/.config/projectman/handoff
   unzip -o <archive> -d ~/.config/projectman/handoff
   chmod 600 ~/.config/projectman/handoff/{handoff,engine-access-token,integrator-access-token}.json
   mv ~/.config/projectman/handoff/engine-access-token.json ~/.config/projectman/cloud/
   ```

   The `chmod` names only the three extracted files, so it does not touch other files that may
   already be in these folders.

   Then read **only** `~/.config/projectman/handoff/handoff.json`. It gives `hubUrl` (the hub, for
   `--cloud`) and `integratorBaseUrl` (for `connect`). Do not open the two `*-access-token.json`
   files. The engine's file now lives in `cloud/` (the pairing or step 4 uses it there); the
   integrator's file stays in `handoff/` until the pairing or step 5 has copied it. Delete the
   archive afterwards and tell the friend to delete their copy of the transfer.

## 3. The app

**[AI]** install the engine app with the release's verifying script. Do not pipe it into a shell:
download it, read it, run it.

```sh
tag=$(gh release view --repo janoist1/projectman --json tagName --jq .tagName)
dir=$(mktemp -d)
curl -fsSL -o "$dir/install-engine-app.sh" \
  "https://raw.githubusercontent.com/janoist1/projectman/$tag/deploy/mac/install-engine-app.sh"
cat "$dir/install-engine-app.sh"   # read it: it must do only what its header says
sh "$dir/install-engine-app.sh" --tag "$tag"
```

The script checks the download (checksum, GitHub build attestation, code signature) and only
afterwards lets macOS open the app; it needs no `sudo`. It installs `~/Applications/projectman
motor.app` and prints the command to start it. If it prints `REFUSED [code]`, stop.

Start the app with the printed `open "…"` command. If your environment does not allow `open`, ask
the friend to open _Home → Applications_ in Finder and double-click **projectman motor**.

The app's first start only unpacks the engine; it does **not** start it yet, because the engine
has no link to a hub. The app's window then says it waits for the setup (step 4), and macOS
shows nothing yet. **[FRIEND]** only needs to click _Install_ if the app asks for the Xcode command
line tools, and to leave the app running (its icon is in the menu bar).

From here on, two commands matter, and the app does not put them on `PATH`; always use their
absolute paths. Below, `$engine` and `$client` stand for them; each shell command is a separate
process, so set them at the top of every command that uses them:

```sh
engine="$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"
client="$HOME/Library/Application Support/projectman/engine/bin/projectman"
```

Check: `"$engine" status --json` prints one JSON line with `"overall":"not_initialised"`. (`package`
is still `null` and `service.installed` is `false`: the app installs the service in step 4.)

## Pairing: connecting without copying keys (try this first)

Pairing does with one approval what steps 4.1–4.2 and 5.1–5.2 do by copying two keys. The engine
app makes the engine key and the integrator key on this Mac and sends the hub only their
fingerprints; the friend approves a short code in the web app, and the app then writes the same
files as `init` (step 4.2) and `connect` (step 5.2). If it does not work, the copy path is
sections 4 and 5 in full; _When to switch to the copy path_ below says when.

1. **[AI]** ask the friend for a name for this Mac's engine (for example _"<name>'s Mac"_), and
   make sure you know the e-mail address they log in to the hub with (step 2.1).
2. **[AI]** request a pairing code (`<hub>` and `<integratorBaseUrl>` come from `handoff.json`):

   ```sh
   engine="$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"
   "$engine" pair start \
     --cloud <hub> --name "<engine name>" \
     --link-headers-file "$HOME/.config/projectman/cloud/engine-access-token.json" \
     --integrator-base-url <integratorBaseUrl> \
     --integrator-access-headers-file "$HOME/.config/projectman/handoff/integrator-access-token.json" \
     --expect-email <the friend's e-mail>
   ```

   On success (exit code `0`) it prints a link (`<hub>/pair/XXXX-XXXX`), the address `<hub>/pair`,
   the code (`XXXX-XXXX`) and how long the code is valid (10 minutes). Before it asks the hub, it
   checks this Mac, and then shows no code:
   - `REFUSED [config_exists]`: this Mac already has an engine configuration. Add `--force` only
     if the friend confirms they want to replace the old engine link.
   - `REFUSED [connect_file_exists]`: a client key or client configuration already exists with
     different content. Add `--replace` only if the friend confirms they want to replace it.
   - `REFUSED [pairing_in_progress]`: an earlier pairing is still pending here. Go on with step 4
     (`pair wait`), or, if the friend wants to start over, run `"$engine" pair cancel` first.
   - `REFUSED [too_many_attempts]`: the hub takes no more pairing requests for now. Wait the
     seconds it names, then run the same command again.
   - `REFUSED [pairing_unavailable]`, or exit code `2` with a usage text whose command list has no
     `pair`: switch to the copy path (see below). Any other usage error is a mistake in the
     command; fix it.

3. **[AI]** show the friend the link and the code **exactly as printed**, character by character;
   do not shorten or retype them. **[FRIEND]** opens the link in the browser where they are logged
   in to the hub (or opens `<hub>/pair` and types the code), checks that the page shows the same
   code, and presses **Approve** (Jóváhagyom) only if it does. If the page says this account cannot
   approve (_"You can't approve with this account"_ / _"Ezzel a fiókkal nem hagyhatod jóvá"_), the
   friend may first log in with the account they manage their projects with and open the link
   again; if that does not help, switch to the copy path.
4. **[AI]** wait for the approval, while the friend approves:

   ```sh
   engine="$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"
   "$engine" pair wait
   ```

   Each run waits up to 30 seconds. Exit code `3` means the code is not approved yet: run it again,
   as long as it exits `3`. Do not start a new code meanwhile.

5. **[AI]** go on by the exit code of `pair wait`:
   - **`0` – approved and written.** It prints `Approved by …` with the approver's name and
     e-mail, the engine's name and id, and the files it wrote. Tell the friend who approved. If the
     name or the e-mail is not the friend's, stop and ask the friend before anything else.
     Otherwise delete the staging folder (`rm -r ~/.config/projectman/handoff`) and carry on with
     step **4.3** (there, "the engine of step 4.1" is the engine you have just paired), 4.4 and 4.5,
     then step **5.3** and 5.4, then section 6. Skip steps 4.1, 4.2, 5.1 and 5.2: the pairing has
     done them.
   - **`1` – read the line it printed:**
     - `PAIRING ENDED [denied]`: the friend (or someone in their account) declined it. Nothing was
       written. Ask the friend whether they started it; request a new code (step 2) only if they
       want to.
     - `PAIRING ENDED [expired]`: the code expired before the approval. Nothing was written.
       Request a new code (step 2) and show it again. If the second code in a row expires too,
       switch to the copy path.
     - `PAIRING ENDED [cancelled]` or `PAIRING ENDED [unknown]`: the request is gone from the hub.
       Nothing was written. Tell the friend, and request a new code (step 2) if they want to.
     - `PAIRING ENDED [approver_mismatch]`: a different account approved it than the e-mail you
       gave. Nothing was written. Stop, tell the friend and the hub's owner: the line names the
       engine and its key that were made in that other account; its owner should remove them in
       _Settings_.
     - Any other line, such as `REFUSED [hub_unreachable]`, `REFUSED [hub_error]`,
       `REFUSED [hub_access_refused]` or `REFUSED [home_in_use]`: the pairing has **not** ended and
       is still pending here. Fix the cause it names (network, the hub's address, the Access file)
       and run `pair wait` again. If it keeps failing, run `"$engine" pair cancel` and tell the
       friend and the hub's owner.
   - **`4` – approved, but not written**, because a file appeared on this Mac meanwhile
     (`PAIRING APPROVED BUT NOT WRITTEN [config_exists]` or `[connect_file_exists]`). The approval
     stays pending here. Tell the friend what would be replaced (the engine configuration, or the
     client key and configuration). Only after the friend explicitly says yes, run
     `"$engine" pair wait --force` (`config_exists`) or `"$engine" pair wait --replace`
     (`connect_file_exists`). If the friend says no, run `"$engine" pair cancel` and tell them the
     approved engine and key stay in their account (_Settings → Engines_ and _Settings → Connected
     Claude_) until they remove them.

### When to switch to the copy path

Use sections 4 and 5 in full instead, and say so to the friend, when:

- the engine app does not know `pair` (exit code `2`, and its usage text lists no `pair`
  command): the app is older than pairing;
- `pair start` prints `REFUSED [pairing_unavailable]`: the hub is older than pairing;
- the friend cannot approve: the page says this account cannot approve, even after logging in with
  the right account. Tell the hub's owner too: steps 4.1 and 5.1 need the same rights, so the
  owner may have to help;
- the code expires twice in a row.

If the last pairing has not ended with a `PAIRING ENDED` line (for example when the friend could
not approve), run `"$engine" pair cancel` first, so its code cannot be approved later. Never add `--force` or `--replace` to any command without the
friend's explicit yes.

## 4. Connecting the engine to the hub

_Steps 4.1 and 4.2 are the copy path._ After a successful pairing, start at step 4.3.

1. **[FRIEND]** in the web app: _Settings → Engines_ (Beállítások → Motorok) → add an engine, name
   it (for example _"<name>'s Mac"_). The page shows the machine key (`pme_…`) **once** and the
   engine id (`eng_…`). Ask the friend for the **engine id** (it is not secret), then ask them to
   press **Copy** on the key and tell you when the key is on the clipboard.
2. **[AI]** pass the key on standard input (`<hub>` is `hubUrl` from `handoff.json`):

   ```sh
   pbpaste | "$engine" init \
     --cloud <hub> --id <eng_…> --name "<engine name>" \
     --link-headers-file "$HOME/.config/projectman/cloud/engine-access-token.json"
   ```

   It refuses an existing engine configuration without `--force`; do not add `--force` unless the
   friend confirms they want to replace the old engine link. Ask the friend to clear their
   clipboard afterwards (copy any harmless text).

3. **[FRIEND]** tells you the key of their project in the web app (the hub's owner may have created
   it already; if not, the friend creates it there and assigns it to the engine of step 4.1) and
   which folder on this Mac holds the project's code. If the friend
   has no folder yet, agree on one, for example `~/projects/<name>`; create it, and run `git init`
   in it if it is empty.
4. **[AI]** bind the project right after `init`. First note whether the engine already runs
   (`"$engine" status --json`, `service.running`), then:

   ```sh
   "$engine" project set <KEY> <absolute folder path>
   ```

5. Once `init` has run, the app notices it within seconds, installs the engine's service
   (LaunchAgent) and opens _System Settings → General → Login Items_. **[FRIEND]** switches
   **projectman motor** on there when the app asks (macOS asks for this once; the app starts the
   engine as soon as it is on). **[AI]** poll `"$engine" status --json` every few seconds until
   `service.installed` and `service.running` are both `true`. The engine reports its projects when
   it starts, so:
   - if it started **after** `project set` (the usual case: the friend's approval takes longer),
     nothing more is needed;
   - if it was already running when you ran `project set` (step 4), run
     `"$engine" service restart` once it is.

   If `service.installed` is still `false` about a minute after `init` and the app shows no
   progress, run `"$engine" service install --path "$(zsh -lc 'echo $PATH')"` yourself (it
   installs and starts the service; macOS may still ask for the Login Items approval above)
   instead. Without `--path` the service gets the `PATH` of your own shell, which in a sandboxed AI
   shell can be shorter than the friend's login shell `PATH`; the sessions would then not find the
   `claude` / `codex` command line.

   (Further steps, such as adding a repository with `repo add`, are in
   [docs/HYBRID.md](docs/HYBRID.md#connecting-the-engine).)

## 5. The connected AI

_Copy path for steps 5.1 and 5.2._ After a successful pairing, start at step 5.3.

This makes the friend's AI client able to reach the hub's tools, restricted to the friend's own
projects.

1. **[FRIEND]** in the web app opens _Settings → Connected Claude_ (Beállítások → Csatlakoztatott
   Claude) and creates an integrator key with the **`super`** mode. The key is shown once. Ask the
   friend to press **Copy** and tell you when it is on the clipboard.
2. **[AI]** write the client configuration. The key goes in on standard input, the Access headers
   file comes from the archive:

   ```sh
   pbpaste | "$client" connect \
     --base-url <integratorBaseUrl> \
     --access-headers-file "$HOME/.config/projectman/handoff/integrator-access-token.json"
   ```

   It writes `~/.config/projectman/integrator-key` (mode 600), its own normalised copy of the
   Access file as `cloud/integrator-access-token.json`, and `client.json`; it prints no secret. It
   refuses to overwrite different content without `--replace`. Afterwards delete the staging folder
   (`rm -r ~/.config/projectman/handoff`) and ask the friend to clear the clipboard.

3. **[AI]** register the MCP server in the friend's client(s), with the absolute path of the shim
   (Claude Desktop does not use the shell's `PATH`). Do those the friend uses:
   - **Claude Code:**
     `claude mcp add --scope user projectman -- "$HOME/Library/Application Support/projectman/engine/bin/projectman" mcp-proxy`
   - **Claude Desktop:** in `~/Library/Application Support/Claude/claude_desktop_config.json`, add
     (merging into any existing `mcpServers`, keeping every other entry):

     ```json
     {
       "mcpServers": {
         "projectman": {
           "command": "/Users/<user>/Library/Application Support/projectman/engine/bin/projectman",
           "args": ["mcp-proxy"]
         }
       }
     }
     ```

   - **Codex:** in `~/.codex/config.toml`:

     ```toml
     [mcp_servers.projectman]
     command = "/Users/<user>/Library/Application Support/projectman/engine/bin/projectman"
     args = ["mcp-proxy"]
     ```

   There is no secret in these entries: the proxy reads `client.json` and the files it names.

4. **[FRIEND]** fully quits and restarts each client you configured (Claude Desktop: _Quit_, not
   just close the window; Claude Code and Codex: start a new session).

## 6. Verify

**[AI]** all three must pass:

1. The engine runs and is linked to the hub:

   ```sh
   "$engine" status --json
   ```

   One JSON line with `"overall":"running"` and `"link":{"state":"connected",…}`. The hub's web
   app shows the engine as connected, with the project bound in step 4 (ask the friend to look if
   you cannot tell). `no_cloud` means the process runs but is not linked: look at `link.lastError`
   and `"$engine" logs`. A Cloudflare Access error there usually means a wrong
   `--link-headers-file` or a token that was rotated; ask the owner for a new handoff.

2. The connected client reaches the hub:

   ```sh
   "$client" check
   ```

   Exit code `0` and a line `ok: the key is accepted; projects: <KEYS>`. Exit code `3` means the
   key or the Access file is rejected (repeat step 5 with `--replace` and a freshly copied key, or
   ask the owner about the handoff).

3. **After the friend restarted the client:** call the `list_projects` tool of the `projectman`
   MCP server in the restarted AI (the friend can ask it in a new conversation). It must list only
   the friend's own projects. If the server is missing from the client, re-check step 5.3.

Tell the friend, in their language, what now works: their engine runs the sessions of their
projects on this Mac, and their AI can see and manage those projects through the hub. Mention that
the engine key (_Settings → Engines_) and the integrator key (_Settings → Connected Claude_) can be
revoked in the web app at any time.

## Updating

The app updates itself (it uses `gh` to verify each release). To check by hand, run
`"$engine" status --json` and read `package.tag`. For the owner's side of the setup, the commands
and the hub's maintenance, see [docs/HYBRID.md](docs/HYBRID.md) and [docs/DEPLOY.md](docs/DEPLOY.md).
