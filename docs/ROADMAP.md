# Roadmap

What comes next and what waits for the owner. Cards (`PM-nn`) live on the "PM" board of the
owner's instance; this file names them so that the plan and the board stay in step. Why we go
this way: [VISION.md](VISION.md); decisions taken: [DECISIONS.md](DECISIONS.md). The integrating
session updates this file with every release (decision 35).

Last reviewed: 2026-10-06, after the board triage (decisions 36–40). Live: v2026.10.6.

## Where we stand

projectman develops itself on the owner's instance: an AI team (Claude Code, Codex, Gemini and
open models through NanoGPT) picks up the cards of the PM project, reviews each other and hands
over; the integrating session merges reviewed work into `main` and prepares the releases, which
the owner switches live. Built so far, in short: the board and its pipeline, gates and labels;
AI members with a fresh session per work item, team tools, worktrees, admission and capacity;
the inbox and the AI decider; card relations and themes; pause and resume; the machine and
heavy-run display; four AI providers; the members' sandboxes (Claude, Codex: PM-153, PM-167,
PM-356).

## Now

Less churn, less load, safer providers. Roughly in this order:

- **Stop repeated work rounds (PM-368):** a team message kind that wakes only for a valid task
  (PM-369), pending messages as one input with the card's state (PM-370), waiting for a
  permission visible to the sender (PM-371), only branches without conflicts with `main` go on
  (PM-372). Collecting cards close themselves when all their parts are done (PM-373). Idle
  conversations: PM-297 finishes PM-288.
- **Fewer test runs (PM-380):** members run targeted tests only; the full test runs once, at the
  merge (decision 40).
- **Members' network and sandboxes:** outgoing network per member (PM-355); Codex members'
  worktree `.codex` (PM-357), network (PM-358) and read boundary (PM-360), the owner's hooks
  (PM-49), managed preferences (PM-375); shared temporary folders (PM-353, PM-365); Gemini's
  sandbox and permissions (PM-361, PM-366, PM-367); the control channel (PM-293).
- **Providers in use:** NanoGPT members stuck after a 429 and without team tools (PM-377), the
  NanoGPT model picker (PM-364), a Codex locale warning that fails tests (PM-352), Codex prompt
  detection (PM-125).
- **Housekeeping:** rewrite the public repository's history to remove a client's name (PM-354,
  decision 39); these documents (PM-381).

## Next: hybrid mode (PM-286)

The board in the cloud, AI work in an office or as remote work (decision 38). In order: an engine
interface in front of the machine-dependent parts (PM-311), disk and terminal behind it (PM-312),
engine registry, machine keys and protocol (PM-313), the engine process on the Mac (PM-314), the
cloud build (PM-315), the engine's state in the UI (PM-316), cloud deployment with a Docker image,
a Cloudflare tunnel and the domain (PM-317, absorbs PM-200), moving between single-machine and
hybrid mode (PM-318). Then remote work on RunPod and the like (PM-310) and, when needed, a cloud
office (PM-378).

## Later

Planned and mostly designed; the order is decided when hybrid mode is done.

- **Settings rework (PM-298):** the pipeline, labels and history, 3/9 to 9/9 (PM-303–309).
- **Hand-over between members and providers (PM-342)**, for example when a provider's plan runs
  out.
- **Traceable involvement (PM-251):** who started or stopped whom and why (PM-274–278).
- **Urgent messages (PM-117):** reach a member during running work (PM-122–124).
- **Documents (PM-147):** the project's living documents for every member (PM-148–151, PM-157).
- **Views:** a flow map of the work at a glance (PM-379), a card's path through the team
  (PM-160), a full phone layout (PM-284), browser notifications and a PWA (PM-59), a maintenance
  page (PM-292).
- **Smaller UI work:** who decides when a member asks (PM-258), system messages and chat steps
  in Hungarian (PM-265, PM-279, PM-82), why fix rounds happened (PM-280), recent decisions in the
  inbox (PM-299), relations in a theme's drawer (PM-226), the 360 px app bar (PM-382), a written
  style direction for several UI/UX members (PM-363).
- **Client visibility (PM-79):** when clients start using projectman.
- **Clean-up and operations:** unused fields and old forms (PM-86), team tokens off the command
  line (PM-156), `X-Forwarded-Proto` behind Tailscale (PM-46), team customization as a git
  submodule (PM-94).

## Dropped

- **The managed VM** (PM-135 and its parts): decision 36. [VM.md](VM.md),
  [MIGRATION.md](MIGRATION.md) and [BOUNDARY.md](BOUNDARY.md) are kept for reference.
- **Phase 2 team rituals** (PM-44, PM-52–58): decision 37; [design/phase2.md](design/phase2.md)
  is kept for reference.
- **A separate always-on server** (PM-45, Hetzner): decision 38.

## Open questions for the owner

- **Product name (PM-47):** later; until then "projectman".
- **QA's part on UI cards (PM-337):** should QA also try the behaviour, beside the designer's
  screenshot comparison?
