# Deploy on a Linux VPS over Tailscale

This page describes a single trusted-team account on a VPS. For the **managed VM profile**
(PM-137: pinned versions, a root-owned app, unprivileged per-member accounts, system-managed
egress rules and a readiness report), which also builds a Linux VM on a Mac, follow
[VM.md](VM.md); its scripts in `deploy/vm/` replace the account and build steps below, and the
service-unit, login, Tailscale and curl sections here still apply to it.

Use Node **22.12 or newer** (a supported LTS release), npm, git, curl, Tailscale,
and the standalone Claude Code / Codex CLIs you need. Install `gh` for GitHub integration.
Native dependencies may need a compiler, make and Python when no prebuilt binary is
available. Allow about **2 GB RAM base plus 1–1.5 GB per concurrent AI developer**;
leave headroom for builds and the project's own tools. Limit concurrency in team settings.

## Account and build

Gemini members use Antigravity CLI `agy` (tested version 1.2.17; `AGY_BIN` may select the
binary). Log in as the executing account by starting `agy` and choosing a Google account.
Projectman disables agy's automatic updates on session launches and login checks with
`--release_base_url http://127.0.0.1:9`. Update it manually during maintenance, then verify
login, a tool approval and conversation resume before restarting member work. A manual
`agy` login without this flag can itself update the binary. Conversation configuration and
transcripts stay under `PROJECTMAN_HOME/providers/gemini`; do not delete them if resume is
needed. The managed VM profile refuses Gemini until PM-331.

Run the app and its CLIs as a dedicated, trusted-team Unix account, `projectman`,
with login home `/var/lib/projectman`. Keep repositories accessible to that account.
Agent and terminal users share its filesystem and credentials; see [SECURITY.md](SECURITY.md).
Set `PROJECTMAN_HOME=/var/lib/projectman/data` (private, mode 0700). This is separate
from the CLI login home and from the app checkout at `/srv/projectman`.
`PROJECTMAN_WORKSPACES=member` gives every AI member one durable workspace per repository under
`$PROJECTMAN_HOME/workspaces` instead of a worktree per task (PM-138; default `task_worktree`).
Allow disk for one clone and its dependencies per member and repository; projectman never
removes them.

Claude members in the legacy profile also get a session folder for the files they attach, such as
screenshots (PM-268; PROVIDERS.md has the details). It is `projectman-sessions/<hash of
PROJECTMAN_HOME>/<session id>.<random>` in the server's temp directory, made at each session's start and
removed when it ends and at the server's start. With the unit's `PrivateTmp=true` that is the
service's own `/tmp`, private to it and emptied when the service stops; without it, the root must
be a real directory of the service user's, not a link, which the server checks (otherwise it
logs an error and runs without the folders). `PROJECTMAN_BROWSERS_PATH` (default
`$PROJECTMAN_HOME/browsers`) is the directory of Playwright's browsers that those sessions read
(`PLAYWRIGHT_BROWSERS_PATH`) and never write; a human installs the browsers there.

```sh
sudo useradd --create-home --home-dir /var/lib/projectman --shell /bin/bash projectman
sudo install -d -o projectman -g projectman -m 0700 /var/lib/projectman/data
# Place a checkout owned by projectman at /srv/projectman, then:
sudo -iu projectman
cd /srv/projectman
npm ci
npm run smoke:prod
```

Install build dependencies too: do not use `npm ci --omit=dev` before building.
`npm run smoke:prod` runs the production build (`npm run build`) and then checks it:
it runs `npm start` using fake CLIs, a temporary home and an isolated port, checks
HTML/assets/SPA/API and an authenticated websocket handshake, then stops and removes its
data. It does not use your CLI accounts. The server bundle is `apps/server/dist/index.js`,
with third-party/native dependencies in `node_modules`. It serves `apps/web/dist`, its SPA
fallback, `/api` and `/ws` on **127.0.0.1:4700**. Deploy both dist directories and the
checkout's dependencies together.

## CLI subscription login

In the same service-user login shell (never as root):

```sh
claude auth login
# Choose the Claude subscription account, not Console/API billing.
codex login
# Choose the ChatGPT account login, not an API key.
gh auth login # optional
```

Follow the CLIs' browser/device login instructions. Do not set API-billing environment
variables. The desktop app's login is separate. Ensure the executables are on the unit's
PATH; adjust PATH or set absolute `CLAUDE_BIN`, `CODEX_BIN`, `GH_BIN` paths in the unit.

## Service and first owner

Exit the service-user shell. Adjust [projectman.service](../deploy/projectman.service),
especially `ExecStart` (it expects Node at `/usr/local/bin/node`, as the VM profile installs it)
and the `PATH` for your CLIs. The unit also sets `DISABLE_AUTOUPDATER=1` and hardening options
(`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, an empty capability set); if a tool of
yours needs more, loosen one option at a time and say why. Then:

```sh
sudo install -m 0644 deploy/projectman.service /etc/systemd/system/projectman.service
sudo systemctl daemon-reload
sudo systemctl enable --now projectman
sudo journalctl -u projectman -f
```

Complete first-run setup locally before enabling remote access. For a browser on your
computer, forward loopback over SSH (`ssh -L 4700:127.0.0.1:4700 <vps>`) and open
`http://127.0.0.1:4700`. The service has no public listener; do not expose Vite.

## Tailnet HTTPS and verification

On the VPS, enable Tailscale HTTPS/MagicDNS as prompted and run:

```sh
sudo tailscale serve --bg 4700
sudo tailscale serve status
```

Use the printed HTTPS URL; restrict access with tailnet ACLs. Serve is tailnet-only;
do not enable Funnel. Projectman still requires its own login.

The [current Tailscale proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)
preserves the incoming Host for TCP HTTP backends and overwrites `X-Forwarded-Proto`
with `https` for TLS requests. Therefore the app compares the browser's Origin to
`https://<public-host>` and issues Secure cookies. `X-Forwarded-Host` alone is insufficient:
projectman deliberately uses Host, and trusts the protocol header only from loopback.
Serve also supplies forwarding/identity headers so remote hook/MCP requests are rejected.
See [Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

Verify the **installed version** from a tailnet client. Create a mode-0600 `login.json`
with your owner's email/password and use the actual printed URL below; remove the file
afterward. Avoid passwords in shell history.

```sh
origin=https://projectman.example-tailnet.ts.net
curl -fsS "$origin/api/setup" # {"needsSetup":false}
curl -sS -D headers.txt -c cookies.txt -H "Origin: $origin" \
  -H 'Content-Type: application/json' --data-binary @login.json "$origin/api/auth/login"
# Expect 200 and Set-Cookie containing Secure; same-origin must not return invalid_origin.
curl --http1.1 -i --max-time 3 -b cookies.txt -H "Origin: $origin" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: cHJvamVjdG1hbnNtb2tlIQ==' "$origin/ws"
# Expect 101 Switching Protocols; timeout afterward is normal for an open websocket.
curl -i -b cookies.txt -X POST -H 'Origin: https://other.example.com' "$origin/api/auth/logout"
# Expect 403 invalid_origin.
rm -f login.json headers.txt cookies.txt
```

If HTTPS login fails origin validation or lacks Secure, upgrade Tailscale and recheck.
An additional loopback proxy must preserve Host, overwrite `X-Forwarded-Proto: https`,
retain forwarding/identity headers, and support websocket upgrades. Do not weaken the
origin check. Deny `/hooks` and `/mcp` at that proxy where possible.

## Client address behind a public entrance (PM-211)

The login and invitation limits count failed attempts per client address (10 per 15 minutes)
and for all clients together (50 per 15 minutes). The service listens on loopback only, so
behind a proxy every request arrives from `127.0.0.1` and, by default, everybody is one
client. If the entrance sets a header with the real client's address, name it in the
service's environment:

```sh
PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip   # behind Cloudflare (Tunnel/Access)
```

Projectman then counts a request under that header's address, but only when the request
comes from loopback (the proxy) and the header holds exactly one valid IP address; anything
else (missing, empty, repeated or malformed header) counts under the connection's address as
before. `X-Forwarded-For` is never read: a client can start that chain with any value. The
name must be a single header (not `x-forwarded-for`), or the service does not start.

Set it only when **every** way to the service goes through an entrance that overwrites that
header with the real client's address (Cloudflare does for `cf-connecting-ip`). If a
client can reach the proxy directly with its own value for the header, it can pick its own
address and gets a fresh per-client budget each time (the shared cap of 50 still holds).
Behind `tailscale serve` there is no such header: leave the variable unset.

## Public entry through Cloudflare Tunnel and Access (PM-200)

The owner's live instance (the Mac, `127.0.0.1:4800`) is reached publicly at
`https://chopper.istvan.io`, behind **Cloudflare Access** (who may come in) and a **Cloudflare
Tunnel** (how the request gets to the Mac). The server and the UI stay on the Mac: there is no
separate frontend hosting and no inbound port. The tunnel is an outbound connection from
`cloudflared`; the only listener stays loopback. Cloudflare terminates TLS and sees the traffic
in clear (see "Public entrance through Cloudflare" in [SECURITY.md](SECURITY.md)). Projectman's
own login still applies after Access: Access is a second lock, not a replacement.

Files: [config.example.yml](../deploy/cloudflare/config.example.yml) (the tunnel's ingress
rules, no secrets) and [check.sh](../deploy/cloudflare/check.sh) (the verification below). Do the
steps in this order: the Access application must exist before the hostname points at the Mac,
or the hostname is open to everybody for the minutes in between.

### 1. Cloudflare account

Create or open the account and protect it with a **passkey or a hardware security key** (not
only a password and an authenticator code or SMS). Whoever controls this account can change
Access, the DNS and the tunnel, which is the same as full access to the Mac. Keep the recovery
codes offline and enable no API token you do not need.

### 2. The istvan.io zone

1. Add `istvan.io` as a site (the free plan is enough).
2. Cloudflare imports the DNS records it finds. **Compare them with the current zone** at the
   registrar or DNS host, record by record: the scan misses some (MX, SPF/DKIM/DMARC TXT,
   verification records, other subdomains). Add what is missing.
3. Leave every existing record **DNS only** (grey cloud), mail records especially (MX cannot be
   proxied). The only proxied record is the one the tunnel creates in step 4.
4. If DNSSEC is on at the registrar, turn it off before changing the nameservers and turn it on
   again at Cloudflare afterwards.
5. Set the two nameservers Cloudflare names at the registrar. The zone is active when the
   dashboard says so; mail and the other sites keep working because the records are the same.

### 3. Zero Trust team and the Access application

1. Open Zero Trust, choose a team name (it is part of the login address,
   `https://<team>.cloudflareaccess.com`), and the free plan.
2. Under the login methods add **Google** or keep the built-in **One-time PIN** (a code sent to
   the email address). Nothing else is needed.
3. Access > Applications > Add an application > **Self-hosted**. Domain `chopper.istvan.io`,
   no path (the whole hostname). Set the **session duration** (for example 24 hours; shorter is
   safer, longer is less typing) and allow only the login methods you chose.
4. Add one policy: action **Allow**, rule **Include > Emails** with the **exact email addresses**
   of the people who may come in, one per address. Do **not** use "Emails ending in", "Everyone",
   "Any valid service token" or a Service Auth/Bypass policy: each of them lets in somebody who
   is not on the list (a whole domain, the whole internet, or a long-lived credential).
5. Note the application's **Audience (AUD) tag** (Overview) and the team name: they go into the
   tunnel's configuration.

### 4. The tunnel on the Mac

Install `cloudflared` (`brew install cloudflared`) and keep it updated. Use a **locally managed**
configuration (a file you can read and review), not a token-managed tunnel: a token sits in the
service definition and gives a tunnel to whoever reads it.

```sh
cloudflared tunnel login                       # opens the browser, writes ~/.cloudflared/cert.pem
cloudflared tunnel create projectman           # writes ~/.cloudflared/<TUNNEL-UUID>.json, prints the UUID
cloudflared tunnel route dns projectman chopper.istvan.io   # the proxied CNAME for the hostname
chmod 700 ~/.cloudflared && chmod 600 ~/.cloudflared/*.json ~/.cloudflared/cert.pem
```

The credentials file (`<TUNNEL-UUID>.json`), the account certificate (`cert.pem`) and any tunnel
token are secrets: keep them at mode **600 outside any repository** (`~/.cloudflared/`), and
never write them into a document, a note, a task, a message, a commit or the clipboard history.
After the DNS route exists `cert.pem` is no longer needed by the service; delete it and log in
again when you need it.

Copy [config.example.yml](../deploy/cloudflare/config.example.yml) to
`~/.cloudflared/config.yml` and fill in the tunnel UUID, the credentials file's absolute path,
the team name and the AUD tag. It has one hostname rule (`chopper.istvan.io` to
`http://127.0.0.1:4800`), in front of it `404` rules for `^/hooks` and `^/mcp`, and a final
catch-all `404`. Its `originRequest.access` block makes `cloudflared` verify the Access token
before it passes a request on. Do not add `httpHostHeader` or any other Host rewrite (the server
computes the expected origin from the Host header, and with a loopback Host a remote request
would look local) and do not add a rule for port 4700 (the development server).

Validate it before the first start. If `cloudflared` is not installed where you read this, this
is a step for you, on the Mac:

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://chopper.istvan.io/hooks/x  # the 404 rule
cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://chopper.istvan.io/api/setup # the 4800 rule
```

Also run the static check of the verification script (`brew install shellcheck` if it is not
installed); it must print nothing:

```sh
bash -n deploy/cloudflare/check.sh
shellcheck deploy/cloudflare/check.sh
```

Make the live instance count login attempts per real client: in the environment of the process
that runs `npm start` add `PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip` (see "Client address
behind a public entrance" above) and restart it. Then run `cloudflared` as a launchd service,
**as your own user, without `sudo`**:

```sh
cloudflared tunnel --config ~/.cloudflared/config.yml run projectman   # once in the foreground first; stop it with Ctrl-C
cloudflared service install                                           # a user LaunchAgent; reads ~/.cloudflared/config.yml
launchctl list | grep -i cloudflared                                  # it is loaded
```

Without `sudo` the installer makes a LaunchAgent (`~/Library/LaunchAgents`) that runs as the same
user as `npm start` and reads `~/.cloudflared`, which is what this guide assumes. It starts when
that user logs in, as the live instance does. Check the plist it wrote: it must name the config
file and hold no token (the installer without an argument uses the config file); keep it at
mode 600. After a change to the configuration, restart the service. Compare the installer's
behavior with the cloudflared documentation for the version you installed.

With `sudo` the installer is documented to make a root LaunchDaemon (`/Library/LaunchDaemons`)
instead. That one runs as root, does not look in your `~/.cloudflared`, and would need the
credentials file and the config copied to a root-owned place: another copy of the secret, and a
root process facing the internet. Prefer the user agent.

### 5. Edge settings

The dashboard moves these around; look for the feature by name, in the `istvan.io` zone.

- **SSL/TLS > Edge Certificates:** **Always Use HTTPS** on; **HSTS** on (max age at least six
  months; "include subdomains" and "preload" only if every other subdomain of `istvan.io` serves
  HTTPS, because both are hard to undo). Minimum TLS version 1.2.
- **Caching:** no "Cache Everything" rule, no Cache Rule or Page Rule that caches this
  hostname. A cached API answer would be shown to somebody else. (A "Bypass cache" rule for the
  hostname is allowed and harmless.)
- **Everything that injects script into the pages is off:** **Rocket Loader**, **Email Address
  Obfuscation** (Scrape Shield), the **automatic insertion of Web Analytics** (the JavaScript
  beacon), Zaraz and any other feature that adds a script, a tag or rewrites the HTML. The
  terminal shows code and secrets, and the pages must be exactly what the server sent.
- **Rules > Transform Rules > Modify Response Header:** a rule for the hostname
  `chopper.istvan.io`, on **every response**, with two header operations:
  - `X-Frame-Options`: operation **Set**, value `DENY`.
  - `Content-Security-Policy`: operation **Add** (not Set), value `frame-ancestors 'none'`.

  The server sends both headers itself (PM-211); the rule also covers the answers it does not
  make (the Access login redirect, the tunnel's 404s). The CSP must be **Add**: the server's
  attachment routes send a stricter policy of their own (`default-src 'none'; sandbox;
frame-ancestors 'none'`) for the uploads shown inline (images, PDF), and **Set** would replace
  it with the bare `frame-ancestors` and silently drop the `sandbox`. With **Add** a response that
  already has a policy gets a second one, and a browser enforces both; do not "tidy" it into
  Set.

### 6. Verify

Work from any computer. Log in to Access once with your own account (no service token is
created, and the token this fetches expires with the Access session):

```sh
cloudflared access login https://chopper.istvan.io >/dev/null
```

Create a mode-0600 `login.json` (`{"email": "...", "password": "..."}`) of a projectman account
and run the script, then remove the file:

```sh
LOGIN_JSON=$PWD/login.json bash deploy/cloudflare/check.sh   # or give another origin as the first argument
rm -f login.json
```

The script prints one line per check and exits non-zero if one failed. It writes no secret and
leaves no cookie file (it logs out the session it made). Without Access:
`/`, `/api/setup` and `/ws` must not reach the application (a redirect to the Access login, or
403). With your Access login: the session cookie is `Secure`; the own origin gives no
`invalid_origin` and a foreign one gives 403 `invalid_origin`; `/ws` answers 101; `/hooks/x` and
`/mcp/x` are 404; `POST /api/setup` is refused (`setup_requires_localhost`); and the answers
carry `Strict-Transport-Security` and `frame-ancestors 'none'`. These extend the curl checks of
the tailnet section above to the public address. The result goes on PM-200 (statuses, not tokens
or cookies). Also try the login once from a browser in a private window with an email address
that is **not** on the list: it must be refused at Access.

### Inviting somebody

The invitation link is built from the address in the browser (`InviteDialog`), so create the
invitation while you have projectman open at `https://chopper.istvan.io`: the link then points
there. Before you send it, add the invitee's email address to the Access application's policy
(step 3, exact address): without it they stop at the Access login and never see the invitation.

### Taking it down

Remove in this order, and check each: delete the Access application; stop the service and
remove it (`sudo cloudflared service uninstall`); delete the tunnel
(`cloudflared tunnel cleanup projectman`, then `cloudflared tunnel delete projectman`); delete the
`chopper` DNS record at Cloudflare; delete `~/.cloudflared/<TUNNEL-UUID>.json`, `cert.pem` and
`config.yml`; remove `PROJECTMAN_CLIENT_IP_HEADER` from the live instance if nothing else sets
that header. If the credentials file may have been seen by somebody else, delete the tunnel
first and make a new one.

## GitHub attribution

Optionally set `githubLogin: acme-developer` on a human or AI member in
`$PROJECTMAN_HOME/customization/projects/<KEY>/team.yaml`, using the actual account
that opens their PRs. Restart after a manual config edit. GitHub polling matches the
login case-insensitively and persists that member as PR author for the no-self-review
rule. The login is returned in `MemberView`; editing it currently uses config only.

A pull request that the managed VM's publishing gate opens (PM-142) is attributed differently: its
author is the member whose authenticated session published it, because several AI members share one
bot login and the login cannot say who wrote the change. That author is kept for good and polling
never replaces it. Do not set the bot's login as one member's `githubLogin` expecting it to name the
author of published pull requests.

## GitHub publishing identity (managed VM, PM-142)

Only the managed VM profile publishes, and only with a separate GitHub identity that a person
creates and installs once ([GITHUB.md](GITHUB.md#publishing-from-the-managed-vm-pm-142) lists its
permissions, the rulesets in `deploy/github/` and the trial `deploy/github/trial.sh`). On the server:

```sh
# as root: the token file, readable by the service account alone (the app refuses a wider mode)
install -o projectman -g projectman -m 600 /dev/stdin /etc/projectman/github-publish.token
# then, in the service's environment (next to PROJECTMAN_EXECUTION_PROFILE=managed_vm):
#   PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE=/etc/projectman/github-publish.token
```

The token is never put in a unit file, an environment file of a worker, the repository or a log, and
`gh auth login` of the owner or an admin is never copied to the VM. Rotating it is replacing the file.

## Sandbox rollout prerequisite (PM-87)

The provider-neutral policy migration does not activate strict sandboxes or change the live
instance. Current policies retain legacy enforcement; strict intent fails startup instead of
falling back. Do not treat the PM-126 probe versions as certified deployment minimums: its
review, provider adapters, hook isolation (PM-49), disposable copies and the final PM-130
matrix must pass before activation. The documented local-port exception is decision 24.
Changing the owner's live instance still requires approval for that exact update.

## Pausing the team for an update (PM-219)

A stop of the service pauses the team first: every session comes to a safe point (the tool that runs is
finished, then the session is held), the server closes, and after the start the sessions go on by themselves.
The pause waits `PROJECTMAN_SHUTDOWN_PAUSE_MS` (default 60 000; 0 stops without pausing, as before) and a few
seconds more. [projectman.service](../deploy/projectman.service) therefore has `TimeoutStopSec=90` and
`KillMode=mixed`: the stop signal goes to the server alone, so the sessions are not stopped under it. Keep both
when you change the unit; with the old `control-group` the CLIs would get the signal at once and the pause would
be worth nothing. A crash does not pause, and neither does a second Ctrl-C.

To update without losing the sessions' place, pause by hand, and wait for it, before the switch:

```sh
npm run control -- pause --wait --reason "update"   # returns when every session has stopped; exit 0
# ... build, switch, restart the service (the restart's own pause finds the pause open and leaves it) ...
npm run control -- resume                          # the sessions go on, with a nudge where they were cut
```

`--force-after <s>` is how long a session may take before it is cut with one Esc (default 300 s), `--timeout <s>`
how long `--wait` waits (default: that plus 30 s). `status` prints the pause and the sessions still working,
`force` cuts them now, and `--json` prints the answer for a script. Exit status: 0 done, 1 refused, failed or timed
out, 2 the server does not run. The command talks to `PROJECTMAN_HOME/control.sock` (`--home` or the
`PROJECTMAN_HOME` variable names the home; mode 0600, so run it as the service user): it has no login, and
whoever may open the file may pause the team. The people can pause and resume from the app too (a project's
admins, the instance's owners).

A pause made by hand survives a restart and is not lifted by the start: the team waits until someone resumes
it. Only the pause of the stop itself ends with the start.

## Backups and updates

For a consistent backup, stop the service and archive **all of `PROJECTMAN_HOME`**,
then restart. This includes `db.sqlite` (and any WAL/SHM files), `customization/`
**including `.git`**, `secret` (the cookie signing key), memory, worktrees, member workspaces and
`attachments/` (the files attached to tasks; the database holds their names and states, so the
two belong to the same backup: a database restored without its files, or the other way round,
leaves attachments that cannot be opened). Also protect CLI transcripts/login state in the
service user's home and project repositories. On start the server cleans up the uploads and
deletions that were cut short (it logs what it finds); a restored copy needs nothing else.
Encrypt backups, restrict readers, and test restoring ownership/modes on an isolated host.
Restoring a different secret invalidates existing browser logins. An online SQLite backup
must use SQLite's backup API/`.backup`, never copy just the live database file.
On the managed VM, `deploy/vm/check-backup.sh` proves an archive restorable without touching the
installation (and `restore.sh` runs it first); moving data from another machine is
[MIGRATION.md](MIGRATION.md). A restored or moved copy must not run beside the original: only
one home may be the active instance (`instance.json`, ARCHITECTURE.md).

Before updating, take a backup and review dependency/CLI changes. Stop during the build
so the running server and browser assets stay on the same version:

```sh
sudo systemctl stop projectman
sudo -iu projectman bash -c 'cd /srv/projectman && git pull --ff-only && npm ci && npm run build'
sudo systemctl restart projectman
sudo systemctl status projectman
```

Repeat the HTTPS curl checks after updating; inspect logs with `journalctl -u projectman`.
If the build fails, restore the previous checkout/build before restarting. A restart stops
active PTYs after pausing the team (above); stored conversations remain resumable, and the
sessions that were working go on after the start.

# Integrator access

The host owner can create an integrator key in Settings → Integrator. The secret is shown once;
save it as `~/.config/projectman/integrator-key` on the integrator's machine, with directory mode
700 and file mode 600. Never put it in a message, task, commit, member prompt or engine payload.
Send it in the `Authorization: Bearer <key>` header on `/api/*` requests. For example:

```sh
curl -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" http://localhost:4800/api/me
```

Bearer authentication takes precedence over a login cookie. A revoked or expired key fails with
`integrator_key_invalid`; a replacement immediately revokes the previous key. Keys cannot approve
human decisions or approval labels, and cannot manage keys or authenticate a websocket connection.
The owner must give approvals using their own login. Every key operation remains attributed to
the integrator (`via: integrator`), even after revocation.
