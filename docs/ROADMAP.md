# Roadmap

What comes next and what waits for the owner. Cards (`PM-nn`) live on the "PM" board of the
owner's instance; this file names them so that the plan and the board stay in step. Why we go
this way: [VISION.md](VISION.md); decisions taken: [DECISIONS.md](DECISIONS.md). The Operator
updates this file at the owner's request, together with decisions that change the plan, and
before a release after the owner's yes (decision 50).

Last reviewed: 2026-10-25, at the owner's request.

## Where we stand

projectman develops itself on the owner's instance: an AI team (Claude Code, Codex, Gemini and
open models through NanoGPT) picks up the cards of the PM project, reviews each other and hands
over. The project manager starts what is in Indulhat (decision 57); the merger member merges
verified work with `merge_task`, with the merge test on GitHub Actions. Built so far, in short:
the board and its pipeline, gates and labels; AI members with a fresh session per work item,
team tools, worktrees, admission and capacity; the inbox and the AI decider; card relations and
themes; pause and resume; four AI providers and the members' sandboxes.

Since 2026-10-18 the owner's order A–G of that day is done, except E and D below: the work keeps
going on its own (PM-796), super mode (PM-784, PM-875, PM-881), the Mac's limits (PM-798), the
hybrid and cloud remainders (PM-675, PM-736, PM-703, PM-713, PM-723, PM-753, PM-754) and history
search (PM-767). Also done: the module refactor (PM-577), the public board with its own login
(PM-930, decision 56), email in and out (decision 60), the first run with the Operator (PM-970),
the team map for members (PM-971), client visibility (PM-79, PM-985, decision 59), browser
notifications (PM-59), traceable involvement (PM-251) and the board's columns on a phone
(PM-986).

## Now

Hybrid mode runs live: the board in the cloud (EC2, chopper.istvan.io), the AI work on the
Mac's engine.

- **The Operator, settled (high):** what the Operator and its super mode are, what they must do
  and how it is fixed for good; the analysis waits for the owner's answer (see the open
  questions).
- **Members decide, the system enforces (decision 58):** the team map continued for the
  Operator and every role (PM-990), short role guides, and what a member gets shown to the
  owner on the web (PM-998).
- **Email mailboxes for AI members (PM-989):** decision 60.
- **Complexity points (PM-1001):** decision 62.
- **One developer per card (PM-958).**

## Next

- **A further refactor:** simplify and cut what is not needed (the owner, 2026-10-25).
- **The release tool for the member responsible for releases (PM-967).**
- **E) History search, continued:** recurring answers in the Operator's knowledge (PM-768).
- **D) An isolated engine for the Operator (later):** PM-699, PM-701, PM-704–706.
- **F) AROOM client work:** last.
- Remote work on RunPod and the like (PM-310) and, when needed, a cloud office (PM-378).

## Later

Planned and mostly designed; the order is decided when the work above is done.

- **The operator's UI (decision 41):** intent-driven control (PM-384) and setting the team's focus
  from the UI (PM-427).
- **Settings rework (PM-298):** the pipeline, labels and history (PM-303–309), item by item
  editing (PM-73).
- **Urgent messages (PM-117):** reach a member during running work (PM-122–124).
- **Documents (PM-147):** the project's living documents for every member (PM-148–151, PM-157).
- **Views:** a card's path through the team (PM-160), a full phone layout (PM-284), a
  maintenance page (PM-292).
- **Smaller UI work:** who decides when a member asks (PM-258), system messages and chat steps
  in Hungarian (PM-265, PM-279, PM-82), why fix rounds happened (PM-280), recent decisions in the
  inbox (PM-299), relations in a theme's drawer (PM-226), the 360 px app bar (PM-382), a written
  style direction for several UI/UX members (PM-363).
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

- **The Operator (2026-10-25):** one Operator with two hands, the in-app one running the board
  on its own and super doing only machine and infrastructure work, with machine to-dos going
  to super instead of the owner? Asked with the analysis of 2026-10-25.
- **Product name (PM-47):** later; until then "projectman".
- **QA's part on UI cards (PM-337):** should QA also try the behaviour, beside the designer's
  screenshot comparison?
