# projectman

Run and track a team of humans and AI members (Claude Code sessions) from the browser.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Working rules for contributors and agents: [CLAUDE.md](CLAUDE.md)

Requires Node 22.12+ and git.

## Try it (demo, no AI usage)

```sh
npm install
npm run demo
```

Open http://127.0.0.1:5173 and use the generated login printed on the first run and saved
in `.demo/credentials.txt`. The fictional Acme webshop has Te, Kata and Bence, four tasks,
and a live fake session. The fake CLI echoes messages; a message containing `PERMISSION`
triggers an approval request. No Claude account or AI usage is needed.

Ctrl+C stops the demo. Later runs reuse `.demo/`; `npm run demo -- --reset` starts fresh.

## Run it for real

AI members run on the owner's Claude subscription through the standalone `claude` CLI.
Log in once with `claude auth login` and choose the Claude subscription account, not the
Console/API account. The desktop app's login is separate. Never set `ANTHROPIC_API_KEY`.
GitHub integration optionally uses the GitHub CLI (`gh auth login`).

```sh
npm install
npm run build && npm start
```

Open http://localhost:4700 and create the owner account. Runtime data defaults to
`~/.projectman` (override with `PROJECTMAN_HOME`). `npm run dev` is for development: server
on port 4700, Vite on port 5173, data in `~/.projectman-dev` unless `PROJECTMAN_HOME` is set.
Checks: `npm run typecheck`, `npm test` and `npm run smoke:prod`. Linux service setup, HTTPS
verification and backups: [docs/DEPLOY.md](docs/DEPLOY.md).

### Live instance next to development

If you develop projectman on the machine that runs your team, keep the live instance in a
checkout of its own. Merges then do not restart it or stop its AI sessions:

```sh
git clone https://github.com/janoist1/projectman.git ~/projectman-live
cd ~/projectman-live && npm ci && npm run build
PORT=4800 npm start
```

Open it at http://localhost:4800 and development instances at http://127.0.0.1:5173: the two
hosts keep separate login cookies. To update, stop the server, run
`git pull --ff-only && npm ci && npm run build`, and start it again. A restart stops running
AI sessions; their conversations stay resumable.

## Open it on your phone

Connect your computer and phone with Tailscale, then expose the app:

```sh
tailscale serve --bg 4700
```

Open the HTTPS URL Tailscale prints on your phone. The server binds to `127.0.0.1` by default.
