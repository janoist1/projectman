# Vision

Draft by the integrating session for the owner's approval (PM-381). The owner's decisions behind
it are in [DECISIONS.md](DECISIONS.md); the plan that follows from it is in [ROADMAP.md](ROADMAP.md).

## What projectman is

One board where a small team of people and AI members works together like colleagues. A card
moves through the team's own stages; AI members (Claude Code, Codex, Gemini, open models through
NanoGPT) pick up their part, hand over to the next role, ask a person when a decision is not
theirs, and leave a trace that anyone can follow. It replaces ClickUp for the owner's own
projects, client projects and internal tools, and it develops itself: the PM project on the
owner's instance builds projectman.

## Who it is for

First the owner: one person who leads a team of AI members and a few colleagues, often from a
phone, and wants to see at a glance what moves, what waits and what waits for them. Later other
small teams that work the same way, and their clients, who see only what is meant for them.

## Principles

- **Subscriptions, not API billing.** AI members run the vendors' own interactive CLIs on the
  owner's plans. The only API key is the projectman-managed NanoGPT key (decisions 1, 15, 34).
- **Fast and lean.** Development should be as fast as possible with the fewest local resources
  and tokens: cheaper members for routine work, one heavy run at a time, the full test once per
  card (decision 40), no member repeating another's work.
- **People decide, AI members do the work.** Approvals, scope, releases and anything that
  publishes or spends belong to a person or to an AI decider the owner chose. Every question
  comes with a recommendation and its consequences, in plain language.
- **The board tells the truth.** Cards, labels and the timeline show what really happens; a
  rule lives in one place and is the same for the server, the AI members and the UI.
- **Safe by default.** Members work in their own worktree and their CLI's sandbox; secrets,
  logins and other projects stay out of reach.
- **Hungarian UI, English code.** The interface speaks the project's language; code, commits
  and documents are English.

## Where it runs

The board, the cards and the people's side run in the cloud, like a Trello board. AI work happens
either in an **office**, today the owner's Mac and later possibly a cloud machine such as EC2, or
as **remote work**, for example on RunPod, which keeps going while the Mac sleeps (decision 38,
PM-286, PM-310, PM-378). There is no separate always-on server and no managed VM layer
(decisions 36, 38).

## What it is not

- Not an API-billed agent platform, and not a general chat client.
- Not a replacement for git hosting or CI: the repository and its checks stay where they are.
- No team rituals (meetings, retrospectives, a "System" member) for now (decision 37).
