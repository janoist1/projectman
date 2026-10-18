# Roadmap

What comes next and what waits for the owner. Cards (`PM-nn`) live on the "PM" board of the
owner's instance; this file names them so that the plan and the board stay in step. Why we go
this way: [VISION.md](VISION.md); decisions taken: [DECISIONS.md](DECISIONS.md). The Operator
updates this file at the owner's request, together with decisions that change the plan, and
before a release after the owner's yes (decision 50).

Last reviewed: 2026-10-18, the owner's priority order of that day (A–G below).

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

Hybrid mode (PM-286, decision 45) runs live: the board in the cloud, the AI work on the Mac's
engine (PM-675, PM-731, PM-732, PM-739, PM-740). The owner's order of 2026-10-18:

- **A) The work must not stop (high):** the collecting card PM-796, member workspaces (PM-738),
  PM-794, PM-792, PM-795, PM-714, the developers' merge-from-main rule (PM-747), and PM-797, the
  bug that keeps the finished collecting cards PM-733, PM-735, PM-737 and PM-772 from closing.
- **B) Finish the super mode (high):** PM-784.
- **G) Relieve the Mac (normal):** a load of 15–20 drops the engine link; measure what loads it
  (parallel sessions, vitest workers, Docker) and propose worker and session limits (PM-799,
  related to PM-777).

## Next

- **C) Hybrid and cloud remainders (normal):** PM-675, PM-736, PM-703, PM-713, PM-723, PM-753,
  PM-754.
- **E) History search, continued (later):** PM-767, PM-768.
- **D) An isolated engine for the Operator (later):** PM-699, PM-701, PM-704–706.
- **F) AROOM client work:** last.
- Remote work on RunPod and the like (PM-310) and, when needed, a cloud office (PM-378).

## Later

Planned and mostly designed; the order is decided when hybrid mode is done.

- **The operator's UI (decision 41):** intent-driven control (PM-384) and setting the team's focus
  from the UI (PM-427); the flow map (PM-379) and the hand-over (PM-342) are done.

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
