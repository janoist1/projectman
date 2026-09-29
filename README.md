# projectman

Run and track a team of humans and AI members (Claude Code sessions) from the browser.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Working rules for contributors and agents: [CLAUDE.md](CLAUDE.md)

## Development

```
npm install
npm run dev        # server on :4700, web on :5173
npm run typecheck
npm test
```

Requires Node 22.12+, git, the Claude Code CLI logged in with a Claude subscription, and
optionally the GitHub CLI (`gh auth login`).
