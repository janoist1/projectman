# Meaningful labels in place of checks: proposal

Status: implemented (decision 17). The owner answered the open questions below:
approvals are labels; a failing label only notifies; stage kinds are simplified later; plain
labels stay allowed. The `pr_updated` clear trigger fires when the head commit of a linked
pull request changes (see `docs/GITHUB.md`).

## Why

Three parts of today's model are hard-wired, and one is missing.

- **Checks** are a fixed catalogue: `code_review`, `security_review`, `qa` and `client_test`. Each takes one of five fixed states.
- **Gates** combine three fixed condition types: `check_passed`, `pr_merged` and `human_approval`.
- **The drawer** has a dedicated "checks" section, with its own endpoint and team-tool parameter.
- **Labels** are free strings that nothing understands.

Together this mirrors one kind of team: a web agency with review, QA and client test. A content team, operations, legal or research work cannot say what "done" means for them. Their words, such as "legal ok", "copy approved", "waiting for an answer" or "invoice sent", end up as meaningless labels, next to a checks section that does not fit them.

## The model in one sentence

A **label** is a small, coloured fact about a task. The project defines its meaning once. A **gate** is the set of labels that must be on the task (or must not be) before it enters a stage. **Comments** say why.

## Label definitions (project config)

```yaml
labels:
  - id: review-ok
    name: Code review rendben
    color: green
    meaning: >-
      Someone other than the author reviewed the change and found nothing blocking.
    group: code-review          # labels of a group exclude each other (one "state")
    setBy: { duties: [code_review] }   # anyone | humans | duties | members | system
    notByAuthor: true           # not the assignee or a PR author (no self-review)
    requiresComment: false      # setting it asks for the reason in the same action
    clearedWhen: [moved_back, pr_updated]   # stale after rework
  - id: review-changes
    name: Code review: javítandó
    color: red
    group: code-review
    setBy: { duties: [code_review] }
    notByAuthor: true
    requiresComment: true
  - id: waiting-answer
    name: Válaszra vár
    color: yellow
    meaning: Waiting for an outside answer; no work starts meanwhile.
    blocks: true                # the task cannot move forward while it is on
```

| Field             | Meaning                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `meaning`         | Plain text in the project's language. It is shown as a tooltip and in settings, and put into every AI member's instructions.        |
| `group`           | Makes labels a state (for example code review: ok / changes / blocked). Setting one removes the others. This replaces `CheckState`. |
| `setBy`           | Who may add the label: `anyone`, `humans`, `duties: [...]`, `members: [...]` or `system`. The server enforces it.                   |
| `notByAuthor`     | The self-review rule, per label.                                                                                                    |
| `requiresComment` | Evidence is a comment written together with the label, never a separate field.                                                      |
| `clearedWhen`     | Automatic removal, for example `moved_back` (the task returns to an earlier stage) or `pr_updated` (new commits after an approval). |
| `blocks`          | The task may not move forward while the label is on.                                                                                |

Labels without a definition stay allowed as plain tags, for example imported ones. Settings lists them as "no meaning yet" and offers to define them.

## Gates

Gate conditions shrink to two types:

- `has_label: <id>`
- `lacks_label: <id>`

A blocking label adds an implicit `lacks_label` to every forward move. The other condition types become labels:

| Today              | With labels                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_passed: qa` | `has_label: qa-ok`                                                                                                                                                                       |
| `pr_merged`        | `has_label: pr-merged`, a `system` label kept in sync by the GitHub integration                                                                                                          |
| `human_approval`   | `has_label: release-approved`, where the label is `setBy: { humans: true, duties: [release_approval] }`, `clearedWhen: [moved_back, pr_updated]`, and `notByAuthor` when four eyes is on |

When a move is refused, the reply names the missing labels and who may set them. For a label only certain humans may set, the move opens an inbox request for them: "Rád vár: Élesítés jóváhagyása". Approving applies the label, with an optional comment. Rejecting requires a comment. The inbox stays the place where humans are asked, but the decision itself is simply a label.

## Invariants (enforced by config validation and the server)

- **An AI never sets a label whose `setBy` is human-only.** Every `release` stage gate must require at least one such label, settable only by holders of the `release_approval` duty. This keeps today's "releases happen only on a human decision".
- **No orphan gates.** Every label a gate requires has at least one member able to set it, after `notByAuthor` is applied. Otherwise the config reports an error.
- **Every change is visible.** Adding and removing labels are timeline events with an actor. The comment is linked, and automatic removal names its reason.

## How the system understands labels

1. **Templates** ship a label set with meanings. The web template reproduces today's checks, and other templates bring their own.
2. **Settings → Címkék** lets the owner:
   - create and edit labels: name, colour, meaning, group, who may set, self-review, comment required, clear on and blocks;
   - see where each label is used: gates, and task counts.
3. **Undefined labels,** whether imported, typed ad hoc or added by agents, are listed there. Later the PM/Rendszer member proposes a meaning from how the label is used, for example: "Válaszra vár is on 3 tasks with no work; make it blocking?". The owner accepts or edits the proposal.
4. **AI instructions** list the project's labels: meaning, who may set, and "comment required". Work instructions then say "add Code review rendben or Code review: javítandó with a comment", instead of naming built-in checks.
5. **Team tools.** `update_task` takes `add_labels` and `remove_labels` together with the note, under the same rules.

## UI

- **Cards** show label chips in their colours.
- **The drawer** has one labels row.
  - Adding a label is a picker grouped by `group`. A label the viewer may not set is disabled, with the reason ("csak a QA feladatkör", "saját munkádra nem").
  - A `requiresComment` label opens a small comment box.
  - The checks section disappears.
- **A stage's "A belépés feltételei"** shows the required labels as chips: met or missing.

## Stage kinds (follow-up, done: decision 18)

Once checks are gone, most stage kinds (`review`, `test`, `client_test`, `deploy`, `merge`) differ only in duty and gate labels. They could shrink to five: `queue`, `work`, `check`, `release` and `done`. Behaviour would then come from the stage's duty and labels, not from the kind name. This is recommended as a second step, after labels.

Built as `queue`, `work`, `step`, `release` and `done` (`step` rather than `check`, so it is not confused with the removed checks); the old names load as `step`.

## Migration

- Each template's checks become label groups, for example:
  - `code_review`: ok / javítandó / elakadt;
  - `qa`: ok / hibás / újrateszt;
  - `client_test`: elfogadta / javítást kér;
  - `security_review`: ok / javítandó.
- Existing `Task.checks` values become those labels.
- Gates are rewritten as the table above shows.
- Existing free labels stay as they are, for example an imported "waiting for an answer" or "high priority" tag, until someone gives them a definition.

## What disappears

- `CheckName`, `CheckState`, `Task.checks`, and the checks endpoint and drawer section.
- The `check` parameter of `update_task`, and the role-to-check mapping in the prompts.
- The gate condition types `check_passed`, `pr_merged` and `human_approval`.

## Open questions for the owner

1. **Approvals as labels.** Should release and merge approval also be human-only labels with an inbox request, as proposed? Or should approvals keep a separate mechanism?
2. **Failure effects.** Should a failing label such as "QA: hibás" also send the task back to development automatically? The alternative is that it only notifies the assignee.
3. **Stage kinds.** Should the simplification to five kinds happen together with labels, or later?
4. **Meaningless labels.** Should they be allowed freely, or should adding a new label to a task ask for its meaning the first time?
