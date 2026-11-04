# Labels and gates

Status: built (decisions 17 and 18). The `pr_updated` clear trigger fires when the head commit of a
linked pull request changes (see [GITHUB.md](../GITHUB.md)). The code: `packages/shared/src/domain/label.ts`,
`packages/shared/src/config/labels.ts`, the template rules in `packages/templates/src/labels.ts`, and the gate
evaluation in the server's domain.

## The model in one sentence

A **label** is a small, coloured fact about a task. The project defines its meaning once. A **gate** is the set of labels that must be on the task (or must not be) before it enters a stage. **Comments** say why.

## Label definitions (project config)

```yaml
labels:
  - id: code-review-ok
    name: Code review rendben
    color: green
    meaning: >-
      Someone other than the author reviewed the change and found nothing blocking.
    group: code-review          # labels of a group exclude each other (one "state")
    setBy: { duties: [code_review] }   # anyone | humans | duties | members | system
    notByAuthor: true           # not the assignee or a PR author (no self-review)
    requiresComment: false      # setting it asks for the reason in the same action
    clearedWhen: [moved_back, pr_updated]   # stale after rework
  - id: code-review-changes
    name: Code review: javítandó
    color: red
    group: code-review
    setBy: { duties: [code_review] }
    notByAuthor: true
    requiresComment: true
    notifyAssignee: true
  - id: waiting-answer
    name: Válaszra vár
    color: yellow
    meaning: Waiting for an outside answer; no work starts meanwhile.
    blocks: true                # the task cannot move forward while it is on
```

| Field             | Meaning                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `meaning`         | Plain text in the project's language. It is shown as a tooltip and in settings, and put into every AI member's instructions.        |
| `group`           | Makes labels a state (for example code review: ok / changes / blocked). Setting one removes the others.                             |
| `setBy`           | Who may add the label: `anyone`, `humans`, `duties: [...]`, `members: [...]` or `system`. The server enforces it.                   |
| `notByAuthor`     | The self-review rule, per label.                                                                                                    |
| `requiresComment` | Evidence is a comment written together with the label, never a separate field.                                                      |
| `notifyAssignee`  | Adding the label notifies the task's assignee (a failing result only notifies; it does not move the task back).                     |
| `clearedWhen`     | Automatic removal, for example `moved_back` (the task returns to an earlier stage) or `pr_updated` (new commits after an approval). |
| `blocks`          | The task may not move forward while the label is on.                                                                                |

`waiting-answer` also follows an open AI question: when a member asks a question about a card in a work or step stage and the project defines this label, the system puts it on (the question's payload says `autoLabel: true`) and takes it off when the last such question closes. A label a person put on is not taken off, and one a person took off is not put back. A running session may go on; only the hand-over to a new session is held back.

Labels without a definition stay allowed as plain tags, for example imported ones. Settings lists them as "no meaning yet" and offers to define them.

## Gates

Gate conditions shrink to two types:

- `has_label: <id>`
- `lacks_label: <id>`

Either type takes an optional `when: <id>`: the condition then binds only the cards that carry that label, and holds on every other card. "Has `design-ok`, when `ui`" asks for the designer's plan on interface cards and leaves the rest alone. `when` must name a defined label, and a `release` gate takes no `when` (its approval holds for every card, decision 19). It is part of the approval signature, so only the owner may add or change it next to a human-only label. A refused move names who may set a missing label.

A blocking label adds an implicit `lacks_label` to every forward move. A QA result is `has_label: qa-ok`; a merged
pull request is `has_label: pr-merged`, a `system` label kept in sync by the GitHub integration; a human approval is
a label with `setBy: { duties: [release_approval], humansOnly: true }`, `clearedWhen: [moved_back, pr_updated]`, and
`notByAuthor` when four eyes is on.

When a move is refused, the reply names the missing labels and who may set them. For a label only certain humans may set, the move opens an inbox request for them: "Rád vár: Élesítés jóváhagyása". Approving applies the label, with an optional comment. Rejecting requires a comment. The inbox stays the place where humans are asked, but the decision itself is simply a label.

## Invariants (enforced by config validation and the server)

- **An AI never sets a label whose `setBy` is human-only.** Every `release` stage gate must require at least one such label, and every human-only label it requires is settable only by holders of the `release_approval` duty: `setBy: { duties: [release_approval], humansOnly: true }`, no other duty and no named member (decision 19). A label any human may set does not pass a release gate. This keeps today's "releases happen only on a human decision".
- **No orphan gates.** Every label a gate requires has at least one member able to set it, after `notByAuthor` is applied. Otherwise the config reports an error.
- **Every change is visible.** Adding and removing labels are timeline events with an actor. The comment is linked, and automatic removal names its reason.

## How the system understands labels

1. **Templates** ship a label set with meanings (`packages/templates/src/labels.ts`; names and meanings come from the locale files).
2. **Settings → Címkék** lets the owner:
   - create and edit labels: name, colour, meaning, group, who may set, self-review, comment required, clear on and blocks;
   - see where each label is used: gates, and task counts.
3. **Undefined labels,** whether imported, typed ad hoc or added by agents, are listed there with the offer to define them.
4. **AI instructions** list the project's labels: meaning, who may set, and "comment required". Work instructions then say "add Code review rendben or Code review: javítandó with a comment", instead of naming built-in checks.
5. **Team tools.** `update_task` takes `add_labels` and `remove_labels` together with the note, under the same rules.

## UI

- **Cards** show label chips in their colours.
- **The drawer** has one labels row.
  - Adding a label is a picker grouped by `group`. A label the viewer may not set is disabled, with the reason ("csak a QA feladatkör", "saját munkádra nem").
  - A `requiresComment` label opens a small comment box.
- **A stage's "A belépés feltételei"** shows the required labels as chips: met or missing.

## Stage kinds

A stage has one of five kinds: `queue`, `work`, `step`, `release` and `done` (decision 18). Behaviour comes from the
stage's duty and gate labels, not from the kind name. A configuration that still names an older kind (`review`,
`test`, `client_test`, `deploy`, `merge`) loads it as `step`.

## Decisions that shape it

1. **Approvals are labels** only humans may set, requested in the inbox; no separate mechanism.
2. **A failing label only notifies** the assignee; it does not move the task back.
3. **Plain labels stay allowed**; settings offers to define them.
