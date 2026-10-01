# Deploy on a Linux VPS over Tailscale

Use Node **22.12 or newer** (a supported LTS release), npm, git, curl, Tailscale,
and the standalone Claude Code / Codex CLIs you need. Install `gh` for GitHub integration.
Native dependencies may need a compiler, make and Python when no prebuilt binary is
available. Allow about **2 GB RAM base plus 1–1.5 GB per concurrent AI developer**;
leave headroom for builds and the project's own tools. Limit concurrency in team settings.

## Account and build

Run the app and its CLIs as a dedicated, trusted-team Unix account, `projectman`,
with login home `/var/lib/projectman`. Keep repositories accessible to that account.
Agent and terminal users share its filesystem and credentials; see [SECURITY.md](SECURITY.md).
Set `PROJECTMAN_HOME=/var/lib/projectman/data` (private, mode 0700). This is separate
from the CLI login home and from the app checkout at `/srv/projectman`.

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
especially `ExecStart` if Node lives elsewhere, then:

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

## GitHub attribution

Optionally set `githubLogin: acme-developer` on a human or AI member in
`$PROJECTMAN_HOME/customization/projects/<KEY>/team.yaml`, using the actual account
that opens their PRs. Restart after a manual config edit. GitHub polling matches the
login case-insensitively and persists that member as PR author for the no-self-review
rule. The login is returned in `MemberView`; editing it currently uses config only.

## Sandbox rollout prerequisite (PM-87)

The provider-neutral policy migration does not activate strict sandboxes or change the live
instance. Current policies retain legacy enforcement; strict intent fails startup instead of
falling back. Do not treat the PM-126 probe versions as certified deployment minimums: its
review, provider adapters, hook isolation (PM-49), disposable copies and the final PM-130
matrix must pass before activation. The documented local-port exception is decision 24.
Changing the owner's live instance still requires approval for that exact update.

## Backups and updates

For a consistent backup, stop the service and archive **all of `PROJECTMAN_HOME`**,
then restart. This includes `db.sqlite` (and any WAL/SHM files), `customization/`
**including `.git`**, `secret` (the cookie signing key), memory, worktrees and
`attachments/` (the files attached to tasks; the database holds their names and states, so the
two belong to the same backup: a database restored without its files, or the other way round,
leaves attachments that cannot be opened). Also protect CLI transcripts/login state in the
service user's home and project repositories. On start the server cleans up the uploads and
deletions that were cut short (it logs what it finds); a restored copy needs nothing else.
Encrypt backups, restrict readers, and test restoring ownership/modes on an isolated host.
Restoring a different secret invalidates existing browser logins. An online SQLite backup
must use SQLite's backup API/`.backup`, never copy just the live database file.

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
active PTYs; stored conversations remain resumable.
