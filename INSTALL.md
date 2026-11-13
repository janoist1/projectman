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
  friend is only asked for: their logins, the password, the macOS permission prompts and copying two
  keys from the web app. Nothing else.
- **Keys never travel as arguments or environment variables.** The two keys (the engine key `pme_…`
  and the integrator key) are shown once in the web app and copied by the friend with its **Copy**
  button. You read each one from the clipboard and pass it on standard input (`pbpaste | …`).
  Never put a key in a command line, an environment variable, a file you create, a message, or your
  answer to the friend. Never print or read the contents of the Access token files either; the
  commands below read them themselves.
- If a command is refused by your own sandbox or permission system, do not try to get around it.
  Tell the friend what you need, and let them approve it or run the command themselves.
- If a command prints `REFUSED [code]`, or fails any check, stop and tell the friend and the person
  who invited them (the hub's owner). Do not skip the check.

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
   that browser tab open: steps 4 and 5 need it.
2. **[AI]** unpack the archive into a private staging folder, not into `cloud/` itself: step 5's
   `connect` writes `cloud/integrator-access-token.json` by itself, from the file you give it, and
   refuses to copy a file onto itself. The archive holds two Access token files (secrets) and a
   non-secret `handoff.json`:

   ```sh
   mkdir -p ~/.config/projectman/cloud ~/.config/projectman/handoff
   chmod 700 ~/.config/projectman ~/.config/projectman/cloud ~/.config/projectman/handoff
   unzip -o <archive> -d ~/.config/projectman/handoff
   chmod 600 ~/.config/projectman/handoff/*.json
   mv ~/.config/projectman/handoff/engine-access-token.json ~/.config/projectman/cloud/
   ```

   Then read **only** `~/.config/projectman/handoff/handoff.json`. It gives `hubUrl` (the hub, for
   `--cloud`) and `integratorBaseUrl` (for `connect`). Do not open the two `*-access-token.json`
   files. The engine's file now lives in `cloud/` (step 4 uses it there); the integrator's file
   stays in `handoff/` until step 5. Delete the archive afterwards and tell the friend to delete
   their copy of the transfer.

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

Check: `"$engine" status --json` prints one JSON line with `"overall":"not_initialised"`. (`package`
is still `null` and no service exists: the app installs the service in step 4.)

From here on, two commands matter, and the app does not put them on `PATH`; always use their
absolute paths. Below, `$engine` and `$client` stand for them; each shell command is a separate
process, so set them in the same command you use them in:

```sh
engine="$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"
client="$HOME/Library/Application Support/projectman/engine/bin/projectman"
```

## 4. Connecting the engine to the hub

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

3. **[FRIEND]** tells you the key of the project (and, if the project's folder is not there yet,
   creates it in the web app) and which folder on this Mac holds the project's code. If the friend
   has no folder yet, agree on one, for example `~/projects/<name>`; create it, and run `git init`
   in it if it is empty.
4. **[AI]** bind the project:

   ```sh
   "$engine" project set <KEY> <absolute folder path>
   ```

5. Once `init` has run, the app notices it within seconds, installs the engine's service
   (LaunchAgent) and opens _System Settings → General → Login Items_. **[FRIEND]** switches
   **projectman motor** on there (macOS asks for this once; the app starts the engine as soon as it
   is on). Then **[AI]** wait for the service, then restart it so the engine reports the new project
   to the hub (it learns of a `project set` only at its start):

   ```sh
   "$engine" service status      # exit 0 only when the service runs; repeat every few seconds
   "$engine" service restart
   ```

   If the service is still not installed about a minute after `init` and the app shows no
   progress, run `"$engine" service install` yourself (it installs and starts the service; macOS
   may still ask for the Login Items approval above) and skip the restart.

   (Further steps, such as adding a repository with `repo add`, are in
   [docs/HYBRID.md](docs/HYBRID.md#connecting-the-engine).)

## 5. The connected AI

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
