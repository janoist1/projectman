/** A loop on a card (PM-261): AI members writing to each other without progress. */
export const loop = {
  mark: 'Going in circles',
  /** Stands for the member who holds the Scheduling duty when the payload names none. */
  schedulingHolder: 'Scheduling holder',
  decides: 'it’s up to {names}',
  youDecide: 'it’s up to you',
  summary:
    '{pair} have been writing to each other for {minutes|# minute|# minutes} without progress ({count|# message|# messages}). {who}',
  who: {
    notified: 'Notified: {name}.',
    no_watcher: 'Nobody holds Scheduling, so {decides}.',
    continued: 'It carried on after {name} was notified, so {decides}.',
    let_run: '{name}: let it run.',
  },
  box: {
    title: 'The conversation is going in circles',
    text: '{pair} exchanged {count|# message|# messages}, with no commit, stage or label change, description edit, attachment or note in between.',
    let_run: '{name} decided to let it run. The mark disappears when it goes quiet.',
    messages: 'Messages',
  },
  events: {
    raised:
      'Back-and-forth: {pair} exchanged {count|# message|# messages} in {minutes|# minute|# minutes} without progress. Notified: {name}.',
    raisedToPeople:
      'Back-and-forth: {pair} exchanged {count|# message|# messages} in {minutes|# minute|# minutes} without progress.',
    escalated: {
      continued: 'It went on after the notification; {decides}.',
      no_watcher: 'Nobody holds Scheduling; {decides}.',
    },
    let_run: '{name}: let it run.',
    ended: 'The back-and-forth ended: {reason}.',
  },
  endReasons: {
    label: 'a label change',
    stage: 'a stage change',
    commit: 'a commit',
    work: 'a description edit, an attachment or a note made progress',
    quiet: 'it went quiet',
    stopped: 'it was stopped',
    let_run: 'let it run',
    disabled: 'it was switched off',
    closed: 'the card was closed',
  },
} as const;
